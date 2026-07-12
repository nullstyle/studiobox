/**
 * `FakeVmmSoakBackend` — the host-safe {@linkcode SoakBackend} that lets the
 * 1.0 soak drill (PLAN.md §M11) run in the batch on macOS with no VM.
 *
 * It drives a real {@linkcode SupervisorCore} over the fake VMM / jailer shims
 * from `@nullstyle/firecracker/testing` and a temp journal, staging a fixture
 * kernel into a real jail and acquiring / releasing a real artifact-cache
 * refcount + per-boot overlay through the same journal-before-spawn +
 * reclaim-hook contract the real `GoldenArtifactLaunchPlanner` uses (M4/M5).
 * That gives the audit real, host-safe resources to enumerate: journal
 * records, artifact refcounts, overlay files, jail roots, and orphan fake-VMM
 * processes.
 *
 * The kill-9-mid-fleet drill is faithful: {@linkcode
 * FakeVmmSoakBackend.crashAndReconcile} launches a mid-fleet batch in a
 * **child** supervisor process (`soak_crash_main.ts`), `kill -9`s it (real
 * orphan fake VMMs + a live journal), then runs the destructive reconcile from
 * a fresh core over the same journal — exactly the M5 restart drill.
 *
 * The Linux-only leak classes (tap / netns / nftables / mount) have no
 * host-safe enumerator here, so {@linkcode SoakRunner} reports them as bounded
 * coverage; `enumerators_linux.ts` supplies them for the in-guest `soak:vm`.
 *
 * > WARNING — like `FakeSandboxHost`, this is a test double, not an isolation
 * > boundary: the fake VMM shims run as the current user on the host.
 *
 * @module
 */

import { basename, fromFileUrl, join } from "@std/path";
import {
  makeFakeJailerBin,
  makeFakeVmmBin,
} from "@nullstyle/firecracker/testing";
import type { VsockConn } from "@nullstyle/firecracker";

import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import type {
  ReclaimHook,
  SupervisorLaunchPlan,
  SupervisorLaunchPlanner,
} from "../../src/rootd/supervisor_core.ts";
import type { SupervisorLaunchRequest } from "../../src/rootd/supervisor_core_api.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { ArtifactCache } from "../../images/cache.ts";
import { ArtifactReclaimHook } from "../../src/rootd/launch_planner.ts";
import { JournalArtifactReferenceReader } from "../../src/rootd/artifact_refs.ts";
import type { ArtifactReference } from "../../src/state/model.ts";

import {
  artifactRefcountEnumerator,
  jailRootEnumerator,
  journalPhaseEnumerator,
  journalPhaseIdentity,
  type LeakAllowance,
  LeakAudit,
  overlayFileEnumerator,
  portReservationEnumerator,
  processIdentity,
  trackedProcessEnumerator,
} from "./leak_audit.ts";
import type { SoakBackend, SoakSandboxHandle } from "./soak_runner.ts";

/** Everything the parent backend and the doomed child supervisor both need. */
export interface FakeVmmSoakConfig {
  readonly workDir: string;
  readonly cacheRoot: string;
  readonly manifestHash: string;
  readonly overlayDir: string;
  readonly chrootBaseDir: string;
  readonly firecrackerBin: string;
  readonly jailerBin: string;
  readonly kernelPath: string;
  readonly arch: ArtifactReference["arch"];
  readonly agentVsockPort: number;
  readonly overlaySizeBytes: number;
  readonly uid: number;
  readonly gid: number;
}

/** One launched mid-fleet sandbox, as the child reports it over `READY`. */
export interface CrashLaunch {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly pid: number;
}

const CRASH_MAIN = fromFileUrl(import.meta.resolve("./soak_crash_main.ts"));

/**
 * A minimal launch planner over the fake VMM shims: acquires the artifact
 * refcount BEFORE the plan is journaled (the M4 store→journal GC-window note),
 * creates a fresh per-boot overlay, stages the fixture kernel, and configures
 * a vsock echo port so the readiness probe and the `use` phase both round-trip
 * bytes over a real (fake-served) vsock. Shared by the parent backend and the
 * doomed child supervisor so both speak the identical launch contract.
 */
export class FakeVmmPlanner implements SupervisorLaunchPlanner {
  readonly #config: FakeVmmSoakConfig;
  readonly #cache: ArtifactCache;

  constructor(config: FakeVmmSoakConfig) {
    this.#config = config;
    this.#cache = new ArtifactCache({ root: config.cacheRoot });
  }

  #overlayPath(executionId: string): string {
    return join(this.#config.overlayDir, `ov-${executionId}.ext4`);
  }

  async resolve(
    request: SupervisorLaunchRequest,
  ): Promise<SupervisorLaunchPlan> {
    // Acquire the belt before the plan is journaled; the reclaim hook releases
    // it on terminate / reconcile.
    await this.#cache.acquire(this.#config.manifestHash);
    const overlayPath = this.#overlayPath(request.executionId);
    try {
      await Deno.mkdir(this.#config.overlayDir, { recursive: true });
      const file = await Deno.open(overlayPath, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      try {
        await file.truncate(this.#config.overlaySizeBytes);
      } finally {
        file.close();
      }
      return {
        jailer: {
          jailerBin: this.#config.jailerBin,
          firecrackerBin: this.#config.firecrackerBin,
          uid: this.#config.uid,
          gid: this.#config.gid,
          chrootBaseDir: this.#config.chrootBaseDir,
        },
        stage: [{ hostPath: this.#config.kernelPath, jailPath: "/vmlinux" }],
        config: {
          boot_source: { kernel_image_path: "/vmlinux" },
          vsock: { guest_cid: 3, uds_path: "v.sock" },
        },
        readinessTimeoutMs: 10_000,
        agentVsockPort: this.#config.agentVsockPort,
        artifact: {
          manifestHash: this.#config.manifestHash,
          arch: this.#config.arch,
        },
      };
    } catch (error) {
      // The plan never reached the journal, so nothing else releases the belt.
      await this.#cache.release(this.#config.manifestHash).catch(() => {});
      await Deno.remove(overlayPath).catch(() => {});
      throw error;
    }
  }

  /** Releases the refcount + removes the per-boot overlay on terminate. */
  get reclaimHook(): ReclaimHook {
    return new ArtifactReclaimHook(
      this.#cache,
      (executionId) => this.#overlayPath(executionId),
    );
  }
}

export interface FakeVmmSoakBackendOptions {
  /**
   * Register the reclaim hook (release refcount + remove overlay on
   * terminate). Default `true`. Set `false` to build a deliberately LEAKY
   * backend whose terminate leaves overlays + stuck refcounts — proves the
   * runner catches a real leak, not just the audit unit.
   */
  readonly reclaim?: boolean;
  /** Temp-dir parent (kept short: jail paths prefix the vsock sun_path). */
  readonly tmpDir?: string;
  /** Guest vsock echo port. @default 5000 */
  readonly agentVsockPort?: number;
}

/** See the module doc. Build via {@linkcode FakeVmmSoakBackend.provision}. */
export class FakeVmmSoakBackend implements SoakBackend {
  readonly #config: FakeVmmSoakConfig;
  readonly #reclaim: boolean;
  readonly #store: JsonFileSandboxStore;
  readonly #planner: FakeVmmPlanner;
  readonly #launchedPids = new Set<number>();
  readonly #live = new Map<string, SoakSandboxHandle>();
  #core: SupervisorCore;
  #seq = 0;
  #crashSeq = 0;

  readonly audit: LeakAudit;
  readonly journalPath: string;

  private constructor(config: FakeVmmSoakConfig, reclaim: boolean) {
    this.#config = config;
    this.#reclaim = reclaim;
    this.journalPath = join(config.workDir, "state.json");
    this.#store = new JsonFileSandboxStore(this.journalPath);
    this.#planner = new FakeVmmPlanner(config);
    this.#core = this.#makeCore();

    const cache = new ArtifactCache({ root: config.cacheRoot });
    const references = new JournalArtifactReferenceReader(this.#store);
    this.audit = new LeakAudit([
      trackedProcessEnumerator(() => this.#launchedPids),
      overlayFileEnumerator(config.overlayDir),
      jailRootEnumerator(config.chrootBaseDir),
      journalPhaseEnumerator(this.#store),
      portReservationEnumerator(this.#store),
      artifactRefcountEnumerator(cache, references),
    ]);
  }

  /** Provision the fake-VMM fixtures + temp journal and build the backend. */
  static async provision(
    options: FakeVmmSoakBackendOptions = {},
  ): Promise<FakeVmmSoakBackend> {
    const config = await provisionFakeVmm(options);
    return new FakeVmmSoakBackend(config, options.reclaim ?? true);
  }

  /** The shared config, for spawning the doomed child supervisor. */
  get config(): FakeVmmSoakConfig {
    return this.#config;
  }

  #makeCore(): SupervisorCore {
    return new SupervisorCore({
      store: this.#store,
      planner: this.#planner,
      reclaimHooks: this.#reclaim ? [this.#planner.reclaimHook] : [],
      buildId: "soak-fake",
    });
  }

  async create(): Promise<SoakSandboxHandle> {
    const n = this.#seq++;
    const sandboxId = `sbx-s${n}`;
    const executionId = `e${n}`;
    const status = await this.#core.launch({
      sandboxId,
      executionId,
      artifactId: "artifact-soak",
      allocationId: "alloc-soak",
      bootNonce: randomBytes(32),
      idempotencyKey: randomBytes(16),
    });
    const handle: SoakSandboxHandle = {
      sandboxId,
      executionId,
      pid: status.pid!,
    };
    this.#launchedPids.add(handle.pid);
    this.#live.set(sandboxId, handle);
    return handle;
  }

  async use(handle: SoakSandboxHandle): Promise<void> {
    // Exercise the vsock path (readiness already dialed it): round-trip bytes
    // through the fake VMM echo handler, proving connectAgent + the outbound
    // connection lifecycle (a leaked conn would keep the VMM's outbound set
    // non-empty; terminate closes it).
    const conn: VsockConn = await this.#core.connectAgent(handle.executionId, {
      retryTimeoutMs: 5_000,
    });
    try {
      const payload = randomBytes(16);
      await writeAll(conn, payload);
      const echoed = await readExactly(conn, payload.byteLength);
      assertBytesEqual(payload, echoed, "vsock echo");
    } finally {
      conn.close();
    }
  }

  async terminate(handle: SoakSandboxHandle): Promise<void> {
    await this.#core.kill(handle.executionId);
    this.#live.delete(handle.sandboxId);
    // The pid is dead now; it stays in the ledger so a future terminate/
    // reconcile that fails to kill some pid is still caught (the enumerator
    // filters by liveness).
  }

  async crashAndReconcile(batchSize: number): Promise<void> {
    const crashIndex = this.#crashSeq++;
    const { child, launched } = await spawnDoomedSupervisor(
      this.#config,
      batchSize,
      crashIndex,
    );
    for (const entry of launched) this.#launchedPids.add(entry.pid);
    try {
      // Mid-fleet audit: the journal now holds `batchSize` ready records with
      // live pids; with the batch allowance the audit must still be clean (no
      // false positive on legitimately-live resources).
      await this.audit.assertClean(
        this.#allowanceForLaunches(launched),
        "mid-fleet before kill-9",
      );
      // kill -9 the doomed supervisor: real orphan fake VMMs + a live journal.
      child.kill("SIGKILL");
      await child.status;
    } finally {
      await child.stdout.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});
    }
    // Restart: a fresh core over the same journal runs the destructive
    // reconcile, reaping every orphan and converging the records to terminal.
    this.#core = this.#makeCore();
    await this.#core.reconcile();
  }

  allowanceFor(live: readonly SoakSandboxHandle[]): LeakAllowance {
    return {
      journalPhase: live.map((h) => journalPhaseIdentity(h.sandboxId, "ready")),
      overlay: live.map((h) => `ov-${h.executionId}.ext4`),
      jailRoot: live.map((h) =>
        join(basename(this.#config.firecrackerBin), h.executionId)
      ),
      process: live.map((h) => processIdentity(h.pid)),
    };
  }

  #allowanceForLaunches(launched: readonly CrashLaunch[]): LeakAllowance {
    return this.allowanceFor(
      launched.map((entry) => ({
        sandboxId: entry.sandboxId,
        executionId: entry.executionId,
        pid: entry.pid,
      })),
    );
  }

  sampleRssBytes(): number {
    return Deno.memoryUsage().rss;
  }

  async close(): Promise<void> {
    for (const handle of [...this.#live.values()]) {
      await this.#core.kill(handle.executionId).catch(() => {});
    }
    this.#live.clear();
    await Deno.remove(this.#config.workDir, { recursive: true }).catch(
      () => {},
    );
  }
}

/** Create the fake-VMM fixtures + a temp journal/cache/overlay tree. */
export async function provisionFakeVmm(
  options: FakeVmmSoakBackendOptions = {},
): Promise<FakeVmmSoakConfig> {
  const agentVsockPort = options.agentVsockPort ?? 5000;
  const workDir = await Deno.makeTempDir({
    dir: options.tmpDir ?? "/tmp",
    prefix: "sbx-soak-",
  });
  const firecrackerBin = await makeFakeVmmBin(workDir, "ready", {
    FAKE_VMM_ECHO_PORT: String(agentVsockPort),
  });
  const jailerBin = await makeFakeJailerBin(workDir);
  const kernelPath = join(workDir, "vmlinux-src");
  await Deno.writeTextFile(kernelPath, "studiobox soak kernel fixture\n");
  const cacheRoot = join(workDir, "cache");
  const manifestHash = await sha256Hex(
    new TextEncoder().encode("studiobox-soak-golden-set"),
  );
  // The cache only needs the set directory to exist for refcount acquire /
  // release (no manifest required for the fake flow).
  await Deno.mkdir(join(cacheRoot, manifestHash), { recursive: true });
  return {
    workDir,
    cacheRoot,
    manifestHash,
    overlayDir: join(workDir, "o"),
    chrootBaseDir: join(workDir, "j"),
    firecrackerBin,
    jailerBin,
    kernelPath,
    arch: Deno.build.arch === "aarch64" ? "aarch64" : "x86_64",
    agentVsockPort,
    overlaySizeBytes: 4096,
    uid: Deno.uid() ?? 0,
    gid: Deno.gid() ?? 0,
  };
}

/** `--config <path>` for the child, propagating a dev import map if set. */
export function denoConfigArgs(): string[] {
  const config = Deno.env.get("SBX_SOAK_CONFIG");
  return config === undefined || config === "" ? [] : ["--config", config];
}

/**
 * Spawn a doomed child supervisor that launches `batchSize` sandboxes to
 * `ready` over the shared journal and hangs. Returns the child handle plus the
 * launches it reported, so the parent can `kill -9` it and reconcile.
 */
export async function spawnDoomedSupervisor(
  config: FakeVmmSoakConfig,
  batchSize: number,
  crashIndex: number,
): Promise<{ child: Deno.ChildProcess; launched: CrashLaunch[] }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      ...denoConfigArgs(),
      CRASH_MAIN,
      JSON.stringify(config),
      String(batchSize),
      String(crashIndex),
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        const stderr = await new Response(child.stderr).text();
        await child.status;
        throw new Error(`doomed supervisor exited before READY:\n${stderr}`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const line = buffer.split("\n", 1)[0]!;
  if (!line.startsWith("READY ")) {
    throw new Error(`unexpected doomed supervisor output: ${line}`);
  }
  return {
    child,
    launched: JSON.parse(line.slice("READY ".length)) as CrashLaunch[],
  };
}

// ---------------------------------------------------------------------------
// Small byte helpers
// ---------------------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function writeAll(conn: VsockConn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function readExactly(
  conn: VsockConn,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = await conn.read(out.subarray(offset));
    if (read === null) break;
    offset += read;
  }
  return out.subarray(0, offset);
}

function assertBytesEqual(
  expected: Uint8Array,
  actual: Uint8Array,
  what: string,
): void {
  if (expected.byteLength !== actual.byteLength) {
    throw new Error(
      `${what}: length ${actual.byteLength} != ${expected.byteLength}`,
    );
  }
  for (let i = 0; i < expected.byteLength; i++) {
    if (expected[i] !== actual[i]) {
      throw new Error(`${what}: byte ${i} differs`);
    }
  }
}
