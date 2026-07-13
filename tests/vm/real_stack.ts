/**
 * The REAL two-daemon stack, stood up as SEPARATE PROCESSES inside the
 * `fc-smoke` guest — the M8 Parity-real exit proof (PLAN.md §M8).
 *
 * Where {@link tunnel_vm_test.ts} drives the tunnel machinery in-process
 * (a `SupervisorCore` and a `TunnelServer` in the test runtime), this boots
 * the ACTUAL daemons the same way a production host does:
 *
 *   studiobox-rootd  (root)  ── supervisor.capnp over a UDS, real
 *                               `GoldenArtifactLaunchPlanner` → real jailed
 *                               Firecracker microVM + real studioboxd on real
 *                               vsock
 *   studiobox-hostd          ── host_control.capnp over loopback TCP +
 *                               the shared tunnel router on a second port,
 *                               driving rootd through the bounded supervisor
 *                               client
 *
 * and points a {@link StudioboxProvider} at hostd over loopback — exactly the
 * pure-wire path a `@deno/sandbox` consumer drives, only the endpoints + token
 * differ from the in-process assembled stack proven on macOS
 * (`tests/fake/sdk/provider_test.ts`).
 *
 * The daemons run as the COMPILED binaries when `SBX_VM_HOSTD_BIN` /
 * `SBX_VM_ROOTD_BIN` name them (the `deno task daemons:compile` output the
 * driver builds); absent those it falls back to `deno run` from source so the
 * harness is drivable by hand. Both are launched here — rootd first (hostd
 * refuses to start until it can dial rootd), each awaited to its JSON ready
 * line before the provider is handed back.
 *
 * @module
 */

import { join } from "@std/path";
import { fromFileUrl } from "@std/path";

import { StudioboxProvider } from "../../src/sdk/provider.ts";
import {
  DEFAULT_AGENT_VSOCK_PORT,
  DEFAULT_OVERLAY_SIZE_BYTES,
} from "../../src/rootd/launch_planner.ts";
import { denoConfigArgs, readVmConfig, type VmSuiteConfig } from "./support.ts";

const REPO_ROOT = fromFileUrl(new URL("../../", import.meta.url)).replace(
  /\/$/,
  "",
);

/** Loopback ports the daemons bind (control plane + shared tunnel router). */
const CONTROL_PORT = 40000;
const TUNNEL_PORT = 40001;

/** Ready-line wait budget: a cold compiled daemon prints within a second. */
const READY_TIMEOUT_MS = 20_000;
/** Per-call budget for the provider (a cold microVM boot fits comfortably). */
const PROVIDER_CALL_TIMEOUT_MS = 60_000;

function toHexToken(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** A launched daemon: its process handle plus a drained stdout/stderr pump. */
interface Daemon {
  readonly label: string;
  readonly child: Deno.ChildProcess;
  readonly drained: Promise<void>;
  /** Every stderr line the daemon emitted (for asserting diagnostics, e.g. the
   * snapshot-restore vs cold-fallback signal). */
  readonly stderrLines: string[];
}

/** The live stack: a provider over the real daemons, torn down on dispose. */
export interface RealStack extends AsyncDisposable {
  readonly provider: StudioboxProvider;
  /** hostd control endpoint (`127.0.0.1:<control>`). */
  readonly controlPort: number;
  /** Shared tunnel-router endpoint (`127.0.0.1:<tunnel>`). */
  readonly tunnelPort: number;
  /** rootd's stderr lines so far (e.g. the "created via snapshot restore" /
   * "snapshot strategy fell back to cold" signal). */
  readonly rootdStderr: readonly string[];
}

/** Opt-in Tier-B networking for the real stack (M10 §W5 validation). */
export interface RealStackNetwork {
  /** The per-sandbox dnsmasq upstream resolver; its presence enables the dataplane. */
  readonly upstreamDns: string;
  /** Pool CIDR override (default `10.201.0.0/16`). */
  readonly poolCidr?: string;
}

/** Options for {@linkcode startRealStack}. */
export interface RealStackOptions {
  /**
   * When set, rootd runs the Tier-B dataplane (TAP + NAT + egress + dnsmasq)
   * so a created sandbox boots with a real NIC. Absent ⇒ the vsock-only path
   * (the M8 parity default), which needs no root network mutation.
   */
  readonly network?: RealStackNetwork;
  /**
   * Opt into snapshot-restore fast-create (snapshot-restore §5): rootd resolves
   * `launchStrategy: "snapshot"`, restoring a warm template + personalizing it
   * instead of cold-booting. Requires a baked template for the golden hash under
   * {@linkcode templateCacheDir} (default `<cache>/templates`) AND a real fc
   * `>= v1.16`; because netless always cold-boots (§9.5), pair it with
   * {@linkcode network}. Absent ⇒ cold (the M8 default). A template problem
   * transparently falls back to cold (§5.3), so a create never fails on it.
   */
  readonly snapshot?: boolean;
  /**
   * Override the warm-template directory (default `<artifactCache>/templates`).
   * Point at an EMPTY dir to exercise the cold FALLBACK (§5.3) with the snapshot
   * strategy still requested. Only consulted when {@linkcode snapshot} is set.
   */
  readonly templateCacheDir?: string;
}

/**
 * Resolve the daemon argv. A compiled binary is invoked directly; the source
 * fallback runs `deno run -A --unstable-vsock <main>` with the suite's config
 * (so a sibling `deno.local.json` import map propagates in the dev loop).
 */
function daemonCommand(
  binEnv: string,
  sourceMain: string,
  args: readonly string[],
): { cmd: string; args: string[] } {
  const bin = Deno.env.get(binEnv);
  if (bin !== undefined && bin !== "") {
    return { cmd: bin, args: [...args] };
  }
  return {
    cmd: Deno.execPath(),
    args: [
      "run",
      "-A",
      "--unstable-vsock",
      ...denoConfigArgs(),
      join(REPO_ROOT, sourceMain),
      ...args,
    ],
  };
}

/**
 * Spawn a daemon, pump its stdout/stderr to the test console (prefixed), and
 * resolve once the JSON ready line naming `readyKey` is seen. Rejects if the
 * process exits or the budget lapses before the ready line.
 */
async function spawnDaemon(
  label: string,
  binEnv: string,
  sourceMain: string,
  args: readonly string[],
  readyKey: string,
): Promise<Daemon> {
  const { cmd, args: cmdArgs } = daemonCommand(binEnv, sourceMain, args);
  const child = new Deno.Command(cmd, {
    args: cmdArgs,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain stderr to the console for diagnosis (and remember the lines so tests
  // can assert on a daemon's diagnostics); never blocks the ready gate.
  const decoder = new TextDecoder();
  const stderrLines: string[] = [];
  const pumpStderr = (async () => {
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk).trimEnd();
      if (text.length > 0) {
        stderrLines.push(text);
        console.error(`[${label} stderr] ${text}`);
      }
    }
  })();

  // Watch stdout for the ready line while echoing it.
  let ready = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const pumpStdout = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        console.log(`[${label}] ${line}`);
        if (!ready && line.includes(`"${readyKey}"`)) {
          ready = true;
          resolveReady();
        }
      }
    }
  })();

  const exited = child.status.then((status) => {
    if (!ready) {
      rejectReady(
        new Error(
          `${label} exited (code ${status.code}) before its ready line`,
        ),
      );
    }
  });

  const timer = setTimeout(() => {
    if (!ready) {
      rejectReady(
        new Error(
          `${label} did not print its ready line within ${READY_TIMEOUT_MS}ms`,
        ),
      );
    }
  }, READY_TIMEOUT_MS);

  try {
    await readyPromise;
  } finally {
    clearTimeout(timer);
  }

  const drained = Promise.allSettled([pumpStdout, pumpStderr, exited]).then(
    () => {},
  );
  return { label, child, drained, stderrLines };
}

/** Terminate a daemon and await its pumps so nothing leaks past dispose. */
async function stopDaemon(daemon: Daemon | undefined): Promise<void> {
  if (daemon === undefined) return;
  try {
    daemon.child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  // Give a graceful shutdown a moment, then hard-kill if it lingers.
  const graceful = daemon.child.status.then(() => true);
  const timed = new Promise<boolean>((resolve) =>
    setTimeout(() => resolve(false), 5_000)
  );
  if (!(await Promise.race([graceful, timed]))) {
    try {
      daemon.child.kill("SIGKILL");
    } catch {
      // Race with natural exit.
    }
  }
  await daemon.child.status.catch(() => {});
  await daemon.drained.catch(() => {});
}

/**
 * Boot rootd + hostd as real processes against the golden set named by the
 * `SBX_VM_*` contract and return a provider dialing hostd over loopback.
 */
export async function startRealStack(
  config: VmSuiteConfig = readVmConfig(),
  options: RealStackOptions = {},
): Promise<RealStack> {
  const runDir = await Deno.makeTempDir({ dir: config.workBase, prefix: "rs" });
  // Short jail/overlay roots: the chroot base prefixes the guest vsock sun_path
  // (~104-byte sockaddr_un), so keep every segment terse.
  const jailBase = join(runDir, "j");
  const overlayDir = join(runDir, "o");
  await Deno.mkdir(overlayDir, { recursive: true });

  const supervisorSock = join(runDir, "sup.sock");
  const journalPath = join(runDir, "journal.json");
  const rootdTokenPath = join(runDir, "rootd.token");
  const hostdTokenPath = join(runDir, "hostd.token");
  const launchConfigPath = join(runDir, "launch.json");
  const compatPath = join(REPO_ROOT, "compat", "wire.json");

  // Two independent 32-byte bootstrap credentials: hostd↔rootd, and client↔hostd.
  const rootdToken = toHexToken(crypto.getRandomValues(new Uint8Array(32)));
  const hostdToken = crypto.getRandomValues(new Uint8Array(32));
  await Deno.writeTextFile(rootdTokenPath, rootdToken);
  await Deno.writeTextFile(hostdTokenPath, toHexToken(hostdToken));

  // The launch-planner config the production systemd unit does NOT yet write
  // (CLI launch-config is a later milestone): point rootd at the baked golden
  // set with root uid/gid (the jailer needs root to chroot/mknod/drop privs).
  const launchConfig = {
    artifactCache: config.cacheRoot,
    manifestHash: config.manifestHash,
    arch: config.arch,
    jailerBin: config.jailerBin,
    firecrackerBin: config.firecrackerBin,
    uid: 0,
    gid: 0,
    chrootBaseDir: jailBase,
    overlayDir,
    vcpuCount: 1,
    memSizeMib: 512,
    overlaySizeBytes: DEFAULT_OVERLAY_SIZE_BYTES,
    agentVsockPort: DEFAULT_AGENT_VSOCK_PORT,
    // Setting `upstreamDns` flips rootd into the Tier-B dataplane (§W4); absent,
    // it keeps the vsock-only launch the M8 parity gate relies on.
    ...(options.network === undefined ? {} : {
      upstreamDns: options.network.upstreamDns,
      ...(options.network.poolCidr === undefined
        ? {}
        : { poolCidr: options.network.poolCidr }),
    }),
    // Opt into snapshot-restore (§5): rootd probes the real fc version, resolves
    // a valid warm template, and restores+personalizes instead of cold-booting;
    // a template/version problem falls back to cold (§5.3).
    ...(options.snapshot
      ? {
        launchStrategy: "snapshot",
        ...(options.templateCacheDir === undefined
          ? {}
          : { templateCacheDir: options.templateCacheDir }),
      }
      : {}),
  };
  await Deno.writeTextFile(launchConfigPath, JSON.stringify(launchConfig));

  let rootd: Daemon | undefined;
  let hostd: Daemon | undefined;
  try {
    rootd = await spawnDaemon(
      "rootd",
      "SBX_VM_ROOTD_BIN",
      "src/rootd/main.ts",
      [
        "--socket",
        supervisorSock,
        "--state",
        journalPath,
        "--token-file",
        rootdTokenPath,
        "--launch-config",
        launchConfigPath,
        "--compat",
        compatPath,
        "--build-id",
        "studiobox/m8-parity",
      ],
      "studiobox-rootd",
    );

    hostd = await spawnDaemon(
      "hostd",
      "SBX_VM_HOSTD_BIN",
      "src/hostd/main.ts",
      [
        "--listen",
        `127.0.0.1:${CONTROL_PORT}`,
        "--tunnel-listen",
        `127.0.0.1:${TUNNEL_PORT}`,
        "--rootd-socket",
        supervisorSock,
        "--token-file",
        hostdTokenPath,
        "--rootd-token-file",
        rootdTokenPath,
        "--compat",
        compatPath,
        "--build-id",
        "studiobox/m8-parity",
      ],
      "studiobox-hostd",
    );
  } catch (error) {
    await stopDaemon(hostd);
    await stopDaemon(rootd);
    await Deno.remove(runDir, { recursive: true }).catch(() => {});
    throw error;
  }

  const provider = new StudioboxProvider({
    control: { transport: "tcp", hostname: "127.0.0.1", port: CONTROL_PORT },
    tunnel: { transport: "tcp", hostname: "127.0.0.1", port: TUNNEL_PORT },
    token: hostdToken,
    buildId: "studiobox/m8-parity",
    callTimeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });

  const capturedRootd = rootd;
  const capturedHostd = hostd;
  // Safety net: if the test runner exits before the async teardown runs (e.g.
  // a fixture leaves a dangling rejection that cancels the remaining tests),
  // still reap the daemons synchronously so their fixed loopback ports are free
  // for the next run. Best-effort; the async dispose below is the clean path.
  globalThis.addEventListener("unload", () => {
    for (const daemon of [capturedHostd, capturedRootd]) {
      try {
        daemon.child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  });
  return {
    provider,
    controlPort: CONTROL_PORT,
    tunnelPort: TUNNEL_PORT,
    rootdStderr: capturedRootd.stderrLines,
    async [Symbol.asyncDispose]() {
      // hostd first (it drives rootd); its SIGTERM revokes leases + tickets and
      // tears the tunnel router down. Then rootd, whose shutdown sweep reclaims
      // any still-live jailed VM.
      await stopDaemon(capturedHostd);
      await stopDaemon(capturedRootd);
      await Deno.remove(runDir, { recursive: true }).catch(() => {});
    },
  };
}
