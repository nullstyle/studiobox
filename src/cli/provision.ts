/**
 * Provisioning: turn a bare host (a fresh Lima VM, or a Linux machine under
 * `--no-lima`) into a running studiobox host — pinned Firecracker + jailer,
 * nftables + dnsmasq, both compiled daemons as systemd units, and the minted
 * auth token delivered off the wire (PLAN.md §M9; DESIGN.md §11).
 *
 * The step list is a fixed, ordered sequence and every step is idempotent, so a
 * re-run is safe:
 *
 *   1. `packages`     — apt-install nftables/dnsmasq (+ rootfs-build deps),
 *                       guarded by `command -v`.
 *   2. `firecracker`  — install pinned Firecracker + jailer (`FIRECRACKER_COMPAT`),
 *                       guarded by a version check.
 *   3. `directories`  — create /etc,/var/lib,/run trees + the `studiobox`
 *                       service user (unprivileged hostd; DESIGN.md §3).
 *   4. `binaries`     — deliver the compiled `studiobox-hostd`/`studiobox-rootd`
 *                       binaries + the `compat/wire.json` identity pin.
 *   5. `token`        — mint + install the bootstrap tokens, off the forwarded
 *                       port (DESIGN.md §8). Idempotent: a re-run does NOT
 *                       rotate an existing token unless `rotateToken`.
 *   6. `systemd`      — write the units, `daemon-reload`, `enable`, then
 *                       `restart` so the live daemons match the written config.
 *
 * Everything runs through the injected {@linkcode HostEnv} (limactl/bash) and
 * {@linkcode LocalFs} seams, so the full sequence is driven and asserted in
 * tests with no VM present. A daemon whose compiled binary is not on the host
 * yet is reported as a warning and its unit is skipped (rather than failing the
 * whole provision) — the full cold `host up` is validated manually once the
 * `deno compile` step for the daemons exists.
 *
 * @module
 */

import { FIRECRACKER_COMPAT } from "@nullstyle/firecracker";
import { fromFileUrl, join } from "@std/path";
// Import the pin directly so it is embedded in the package (works local AND
// when the module is fetched from a remote registry).
import wireCompat from "../../compat/wire.json" with { type: "json" };
import type { ArtifactArch } from "../../images/pins.ts";
import { BAKE_LOG, bakeGoldenSet } from "./bake.ts";
import { GUEST_CACHE_DIR, GUEST_STATE_DIR } from "./guest_layout.ts";
import type { HostEnv } from "./host_env.ts";
import type { HostPortConfig } from "./host_template.ts";
import type { LocalFs } from "./local_fs.ts";

// Guest-side layout (logical-id / short paths; DESIGN.md §8, §12).
const GUEST_BIN_DIR = "/usr/local/bin";
export const HOSTD_BIN = `${GUEST_BIN_DIR}/studiobox-hostd`;
export const ROOTD_BIN = `${GUEST_BIN_DIR}/studiobox-rootd`;
const GUEST_ETC = "/etc/studiobox";
export const HOSTD_TOKEN = `${GUEST_ETC}/hostd.token`;
export const ROOTD_TOKEN = `${GUEST_ETC}/rootd.token`;
export const WIRE_JSON = `${GUEST_ETC}/wire.json`;
/** rootd's `--launch-config`: enables the golden-artifact launch planner. */
export const LAUNCH_JSON = `${GUEST_ETC}/launch.json`;
// GUEST_STATE_DIR + GUEST_CACHE_DIR live in the leaf ./guest_layout.ts so the
// bake step and the launch-config step agree on where the cache is (and to
// avoid a provision↔bake import cycle).
export const JOURNAL_PATH = `${GUEST_STATE_DIR}/journal.json`;
// Launch-planner guest layout (mirrors the working /etc/studiobox/launch.json).
// `installFirecrackerScript` installs both bins into GUEST_BIN_DIR; rootd (root)
// creates the jail/overlay dirs on demand; the cache is populated by the golden
// bake (`tools/build_golden_set.ts`).
const GUEST_JAILER_BIN = `${GUEST_BIN_DIR}/jailer`;
const GUEST_FIRECRACKER_BIN = `${GUEST_BIN_DIR}/firecracker`;
const GUEST_JAIL_DIR = `${GUEST_STATE_DIR}/jail`;
const GUEST_OVERLAY_DIR = `${GUEST_STATE_DIR}/overlay`;
const GUEST_RUN_DIR = "/run/studiobox";
export const SUPERVISOR_SOCK = `${GUEST_RUN_DIR}/supervisor.sock`;
const SERVICE_USER = "studiobox";
const BUILD_ID = "studiobox-host";

/** Where the SDK reads its bootstrap token on the host (`~/.studiobox/token`). */
export function defaultHostTokenPath(homeDir: string): string {
  return `${homeDir}/.studiobox/token`;
}

/** Default compiled-daemon source path on the host (`.build/<name>-<target>`). */
export function defaultDaemonBinary(
  buildDir: string,
  daemon: "studiobox-hostd" | "studiobox-rootd",
  arch: ArtifactArch,
): string {
  return `${buildDir}/${daemon}-${arch}-unknown-linux-gnu`;
}

/**
 * Materialize the package-embedded `compat/wire.json` pin to a fresh temp file
 * and return its path.
 *
 * Used when the CLI was fetched from a remote registry (`jsr:`/`https:`), where
 * `import.meta.resolve` yields a non-`file:` URL and the pin has no on-disk
 * path — provisioning still needs a readable LOCAL file: {@linkcode provisionHost}
 * `copyIn`s it into the guest and {@linkcode HostLifecycle} reads it to build the
 * host contract identity.
 *
 * Re-serializing the embedded pin is safe: the daemons and the host/supervisor
 * identity `JSON.parse` this file and consume the `protocol`, `schemaSha256`,
 * and `codegen.version` FIELDS (see `buildSupervisorContractIdentity` in
 * `src/rootd/service.ts`) — never a hash of the raw file bytes — and those
 * fields survive `JSON.stringify` intact.
 */
export function materializeCompatPin(): string {
  const dir = Deno.makeTempDirSync({ prefix: "studiobox-compat-" });
  const path = join(dir, "wire.json");
  Deno.writeTextFileSync(path, JSON.stringify(wireCompat));
  return path;
}

/**
 * Path to the committed `compat/wire.json` shipped into the guest.
 *
 * Kept SYNC because {@linkcode HostLifecycle}'s constructor calls it
 * synchronously. Two branches resolve the SAME pin regardless of how the CLI
 * was loaded:
 *
 *   1. LOCAL checkout — `import.meta.resolve` yields a `file:` URL and the pin
 *      is on disk → return that path unchanged (byte-identical to the committed
 *      file; the historical fast path).
 *   2. REMOTE (`jsr:`/`https:`) or the file is absent — `fromFileUrl` would
 *      throw on a non-`file:` URL, so materialize the package-embedded pin to a
 *      temp file (see {@linkcode materializeCompatPin}) and return that path.
 */
export function defaultCompatPath(): string {
  const url = import.meta.resolve("../../compat/wire.json");
  if (url.startsWith("file:")) {
    const path = fromFileUrl(url);
    try {
      Deno.statSync(path);
      return path;
    } catch {
      // A file: URL that points nowhere on disk (unusual): fall through to
      // materializing the embedded pin rather than handing back a dead path.
    }
  }
  return materializeCompatPin();
}

/** One provisioning step's outcome. */
export interface ProvisionStepResult {
  readonly name: ProvisionStepName;
  readonly status: "ran" | "skipped";
  readonly detail: string;
}

export type ProvisionStepName =
  | "packages"
  | "firecracker"
  | "directories"
  | "bake"
  | "binaries"
  | "token"
  | "launch-config"
  | "systemd";

/** The fixed step order (also the assertion order in tests). */
export const PROVISION_STEP_ORDER: readonly ProvisionStepName[] = [
  "packages",
  "firecracker",
  "directories",
  // `bake` runs after `directories` (so /var/lib/studiobox + build deps exist)
  // and before `binaries`/`token`/`systemd`, so the multi-minute step fails
  // fast yet the control-plane steps still complete if the bake degrades.
  "bake",
  "binaries",
  "token",
  "launch-config",
  "systemd",
];

/**
 * Request to bake the golden set in-guest during provisioning (from
 * `--bake`). Mutually exclusive with {@linkcode ProvisionOptions.launchConfig}
 * (the two ways to populate the launch config's manifest hash); the CLI
 * enforces that they never coexist.
 */
export interface BakeRequest {
  /** Host repo root (a git working tree) the source tarball is built from. */
  readonly sourceRoot: string;
  /** Ignore the cache and force a fresh bake. @default false */
  readonly rebuild?: boolean;
  /** Optional dataplane/strategy fields to fold into the launch config. */
  readonly launch?: Omit<LaunchConfigInput, "manifestHash">;
}

/** Aggregate result of {@linkcode provisionHost}. */
export interface ProvisionResult {
  readonly steps: readonly ProvisionStepResult[];
  readonly warnings: readonly string[];
  /** True when the token step minted a fresh token this run. */
  readonly tokenRotated: boolean;
  /** Which daemons had their binary installed + unit enabled. */
  readonly installedDaemons: readonly ("hostd" | "rootd")[];
  /** True when a requested bake failed (host is up but control-plane only). */
  readonly bakeFailed: boolean;
}

/** Options for {@linkcode provisionHost}. */
export interface ProvisionOptions {
  readonly env: HostEnv;
  readonly fs: LocalFs;
  readonly arch: ArtifactArch;
  /** Loopback ports the hostd unit binds/forwards. */
  readonly ports: HostPortConfig;
  /** Host path the SDK token is written to. */
  readonly hostTokenPath: string;
  /** Host source of the compiled `studiobox-hostd` binary. */
  readonly hostdBinarySource: string;
  /** Host source of the compiled `studiobox-rootd` binary. */
  readonly rootdBinarySource: string;
  /** Host source of `compat/wire.json`. */
  readonly compatSource: string;
  /**
   * When set, write `launch.json` and wire rootd's `--launch-config` so
   * `Sandbox.create` can boot a real microVM. Omit to bring up a control-plane-
   * only host (a warning is recorded and `Sandbox.create` stays unavailable).
   */
  readonly launchConfig?: LaunchConfigInput;
  /**
   * When set, bake the golden set in-guest and auto-wire its hash into the
   * launch config (the `--bake` path). Mutually exclusive with
   * {@linkcode launchConfig}. A bake failure degrades to a control-plane-only
   * host (see {@linkcode ProvisionResult.bakeFailed}) rather than aborting.
   */
  readonly bake?: BakeRequest;
  /** Re-mint the token even when one already exists. @default false */
  readonly rotateToken?: boolean;
  /** Bootstrap-token source (32 bytes). @default 32 random bytes */
  readonly tokenFactory?: () => Uint8Array;
  /** Progress sink. @default no-op */
  readonly log?: (line: string) => void;
}

const TOKEN_BYTES = 32;

/**
 * Operator-supplied inputs that turn ON rootd's launch planner (so
 * `Sandbox.create` can boot a real microVM). The only thing that varies per
 * host is the identity of the baked golden artifact set — its content-manifest
 * hash, which `tools/build_golden_set.ts` prints. Everything else in the launch
 * config (bin paths, uid/gid, chroot/overlay/cache dirs) is fixed by the guest
 * layout this provisioner installs, so {@linkcode buildLaunchConfig} fills it in.
 *
 * Absent ⇒ rootd runs control-plane only: `host doctor` is green but
 * `Sandbox.create` fails until a golden set is baked and `host up` is re-run
 * with its hash.
 */
export interface LaunchConfigInput {
  /** sha256 content-manifest hash of the baked golden artifact set. */
  readonly manifestHash: string;
  /** Enable the Tier-B dataplane with this upstream DNS resolver (else vsock-only). */
  readonly upstreamDns?: string;
  /** Override the default pool CIDR (`10.201.0.0/16`); must not overlap host bridges. */
  readonly poolCidr?: string;
  /** Force the pre-M10 vsock-only path even when `upstreamDns` is set. */
  readonly netlessOnly?: boolean;
  /** Opt into warm-template snapshot restore (gated; default cold). */
  readonly launchStrategy?: "cold" | "snapshot";
}

/**
 * Compose the `--launch-config` JSON rootd reads, from the fixed guest layout
 * plus the operator's {@linkcode LaunchConfigInput}. Pure + exported so a unit
 * test pins the shape against rootd's own parser without a host.
 */
export function buildLaunchConfig(
  arch: ArtifactArch,
  input: LaunchConfigInput,
): Record<string, unknown> {
  return {
    artifactCache: GUEST_CACHE_DIR,
    manifestHash: input.manifestHash,
    arch,
    jailerBin: GUEST_JAILER_BIN,
    firecrackerBin: GUEST_FIRECRACKER_BIN,
    uid: 0,
    gid: 0,
    chrootBaseDir: GUEST_JAIL_DIR,
    overlayDir: GUEST_OVERLAY_DIR,
    ...(input.upstreamDns === undefined
      ? {}
      : { upstreamDns: input.upstreamDns }),
    ...(input.poolCidr === undefined ? {} : { poolCidr: input.poolCidr }),
    ...(input.netlessOnly === undefined
      ? {}
      : { netlessOnly: input.netlessOnly }),
    ...(input.launchStrategy === undefined
      ? {}
      : { launchStrategy: input.launchStrategy }),
  };
}

/**
 * Render the two systemd units. Pure + exported so a unit test pins the
 * `ExecStart` argv (which must match the daemons' own flag parsers) without a
 * host. When `launchConfigPath` is set, rootd is wired to read its launch
 * planner config from there (enabling `Sandbox.create`).
 */
export function renderSystemdUnits(
  ports: HostPortConfig,
  options: { readonly launchConfigPath?: string } = {},
): { readonly rootd: string; readonly hostd: string } {
  const launchArg = options.launchConfigPath === undefined
    ? ""
    : ` --launch-config ${options.launchConfigPath}`;
  const rootd = `[Unit]
Description=studiobox-rootd (root supervisor)
Documentation=https://jsr.io/@nullstyle/studiobox
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
# rootd runs as root (the jailer needs it) but with the service GROUP, so its
# RuntimeDirectory (/run/studiobox) and the supervisor UDS it binds there are
# owned root:${SERVICE_USER} — letting the unprivileged hostd traverse + connect.
Group=${SERVICE_USER}
ExecStart=${ROOTD_BIN} --socket ${SUPERVISOR_SOCK} --state ${JOURNAL_PATH} --token-file ${ROOTD_TOKEN} --build-id ${BUILD_ID} --compat ${WIRE_JSON}${launchArg}
RuntimeDirectory=studiobox
RuntimeDirectoryMode=0710
StateDirectory=studiobox
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
  const hostd = `[Unit]
Description=studiobox-hostd (control plane)
Documentation=https://jsr.io/@nullstyle/studiobox
After=studiobox-rootd.service
Requires=studiobox-rootd.service

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=${HOSTD_BIN} --listen 0.0.0.0:${ports.control} --tunnel-listen 0.0.0.0:${ports.tunnel} --rootd-socket ${SUPERVISOR_SOCK} --token-file ${HOSTD_TOKEN} --rootd-token-file ${ROOTD_TOKEN} --build-id ${BUILD_ID} --compat ${WIRE_JSON}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
  return { rootd, hostd };
}

/** Encode 32 bytes as the 64-hex-char token the daemons' parsers expect. */
function toHexToken(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Run the ordered, idempotent provisioning sequence. */
export async function provisionHost(
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const { env, fs, ports } = options;
  const log = options.log ?? (() => {});
  const tokenFactory = options.tokenFactory ??
    (() => crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const steps: ProvisionStepResult[] = [];
  const warnings: string[] = [];

  // 1) packages ------------------------------------------------------------
  log("provision: base packages (nftables, dnsmasq, rootfs deps)");
  await env.guestExec(
    `(command -v nft >/dev/null && command -v dnsmasq >/dev/null && ` +
      `command -v debootstrap >/dev/null && command -v mke2fs >/dev/null && ` +
      `command -v curl >/dev/null && command -v unzip >/dev/null) || ` +
      `(apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q ` +
      `nftables dnsmasq debootstrap e2fsprogs curl unzip)`,
    { check: true, sudo: true },
  );
  steps.push({ name: "packages", status: "ran", detail: "nftables, dnsmasq" });

  // 2) firecracker ---------------------------------------------------------
  const fc = FIRECRACKER_COMPAT.pinned;
  log(`provision: Firecracker ${fc} + jailer`);
  await env.guestExec(installFirecrackerScript(fc), {
    check: true,
    sudo: true,
  });
  steps.push({
    name: "firecracker",
    status: "ran",
    detail: `Firecracker ${fc} (min ${FIRECRACKER_COMPAT.min})`,
  });

  // 3) directories + service user -----------------------------------------
  log("provision: directories + service user");
  await env.guestExec(directoriesScript(), { check: true, sudo: true });
  steps.push({
    name: "directories",
    status: "ran",
    detail: `${GUEST_ETC}, ${GUEST_STATE_DIR}, user ${SERVICE_USER}`,
  });

  // 3b) bake (optional) — turn the launch config on from a freshly-baked set.
  // The hash it produces feeds the launch-config step below (via effectiveLaunch).
  // A bake FAILURE degrades to a control-plane-only host (bakeFailed=true): the
  // remaining binaries/token/systemd steps still run, so a network hiccup never
  // leaves a daemon-less host.
  let effectiveLaunch = options.launchConfig;
  let bakeFailed = false;
  if (options.bake !== undefined) {
    try {
      const baked = await bakeGoldenSet({
        env,
        fs,
        arch: options.arch,
        sourceRoot: options.bake.sourceRoot,
        rebuild: options.bake.rebuild ?? false,
        log,
      });
      effectiveLaunch = {
        manifestHash: baked.hash,
        ...(options.bake.launch ?? {}),
      };
      steps.push({
        name: "bake",
        status: baked.created ? "ran" : "skipped",
        detail: baked.created
          ? `baked ${baked.hash.slice(0, 12)}…`
          : `reused cached ${baked.hash.slice(0, 12)}…`,
      });
    } catch (error) {
      bakeFailed = true;
      // The build's stderr went to BAKE_LOG (so CommandError's own stderr
      // slice is empty); tail it for a useful diagnostic in the warning.
      const tail =
        (await env.guestExec(`tail -n 60 ${BAKE_LOG}`, { sudo: true })
          .catch(() => ({ stdout: "" }))).stdout;
      warnings.push(
        `bake FAILED (${
          error instanceof Error ? error.message : error
        }); host ` +
          `is control-plane only — re-run \`studiobox host up --bake\` once fixed ` +
          `(the bake needs network: the S3 kernel + the debootstrap mirror).` +
          (tail.trim() === "" ? "" : `\nLast build log lines:\n${tail}`),
      );
      steps.push({
        name: "bake",
        status: "skipped",
        detail: "bake failed (see warning); control-plane only",
      });
    }
  } else {
    steps.push({
      name: "bake",
      status: "skipped",
      detail: options.launchConfig !== undefined
        ? "manifest hash supplied (--manifest-hash)"
        : "no bake requested",
    });
  }

  // 4) binaries + compat pin ----------------------------------------------
  const installed: ("hostd" | "rootd")[] = [];
  await env.copyIn(options.compatSource, WIRE_JSON, "0644");
  for (
    const [daemon, source, dest] of [
      ["hostd", options.hostdBinarySource, HOSTD_BIN],
      ["rootd", options.rootdBinarySource, ROOTD_BIN],
    ] as const
  ) {
    if (await fs.exists(source)) {
      log(`provision: install ${daemon} binary`);
      await env.copyIn(source, dest, "0755");
      installed.push(daemon);
    } else {
      warnings.push(
        `${daemon} binary not found at ${source}; unit skipped ` +
          `(compile the daemons, then re-run host provision)`,
      );
    }
  }
  steps.push({
    name: "binaries",
    status: installed.length > 0 ? "ran" : "skipped",
    detail: installed.length > 0
      ? `installed ${installed.join(", ")}`
      : "no compiled daemon binaries present",
  });

  // 5) token (idempotent; off the forwarded port) --------------------------
  const tokenResult = await installToken(env, fs, {
    hostTokenPath: options.hostTokenPath,
    rotate: options.rotateToken ?? false,
    tokenFactory,
    log,
  });
  steps.push(tokenResult.step);

  // 5b) launch-planner config (optional) -----------------------------------
  // Written before the units so the rootd unit that references it can start.
  // `effectiveLaunch` is the bake's hash (if --bake succeeded) or the supplied
  // --manifest-hash; without it rootd is control-plane only.
  let launchConfigPath: string | undefined;
  if (effectiveLaunch !== undefined) {
    log("provision: launch-planner config");
    const json = JSON.stringify(
      buildLaunchConfig(options.arch, effectiveLaunch),
      null,
      2,
    );
    await env.guestExec(writeGuestConfigScript(LAUNCH_JSON, json, "0640"), {
      check: true,
      sudo: true,
    });
    launchConfigPath = LAUNCH_JSON;
    steps.push({
      name: "launch-config",
      status: "ran",
      detail: `manifest ${effectiveLaunch.manifestHash.slice(0, 12)}…`,
    });
  } else {
    // A requested-but-failed bake already logged a detailed warning above.
    if (!bakeFailed) {
      warnings.push(
        "no launch config provided; rootd runs control-plane only and " +
          "Sandbox.create is unavailable — bake a golden set (host up --bake, " +
          "or tools/build_golden_set.ts + --manifest-hash)",
      );
    }
    steps.push({
      name: "launch-config",
      status: "skipped",
      detail: bakeFailed
        ? "bake failed — Sandbox.create unavailable"
        : "no golden set / manifest hash supplied",
    });
  }

  // 6) systemd units -------------------------------------------------------
  const units = renderSystemdUnits(
    ports,
    launchConfigPath === undefined ? {} : { launchConfigPath },
  );
  log("provision: systemd units");
  await env.guestExec(writeUnitScript("studiobox-rootd.service", units.rootd), {
    check: true,
    sudo: true,
  });
  await env.guestExec(writeUnitScript("studiobox-hostd.service", units.hostd), {
    check: true,
    sudo: true,
  });
  await env.guestExec("systemctl daemon-reload", { check: true, sudo: true });
  if (installed.length === 2) {
    // `enable` (boot symlink) then `restart` — NOT `enable --now`. `--now`'s
    // `start` is a no-op on an already-running unit, so a re-provision that
    // rewrote the units or launch.json (e.g. `host up --bake` after a plain
    // `host up`) would leave the LIVE rootd on its old argv/config and the
    // launch planner silently off. `restart` starts a stopped unit and re-execs
    // a running one, so the running daemons always match the just-written
    // config; rootd's destructive reconcile reclaims any orphaned executions.
    // rootd first (hostd Requires= it), then hostd.
    await env.guestExec(
      "systemctl enable studiobox-rootd.service studiobox-hostd.service",
      { check: true, sudo: true },
    );
    await env.guestExec("systemctl restart studiobox-rootd.service", {
      check: true,
      sudo: true,
    });
    await env.guestExec("systemctl restart studiobox-hostd.service", {
      check: true,
      sudo: true,
    });
  } else {
    warnings.push(
      "not all daemons installed; units written but not enabled " +
        "(run host provision again after compiling both daemons)",
    );
  }
  steps.push({
    name: "systemd",
    status: installed.length === 2 ? "ran" : "skipped",
    detail: installed.length === 2
      ? "enabled studiobox-rootd + studiobox-hostd"
      : "units written, not enabled (missing daemon binaries)",
  });

  return {
    steps,
    warnings,
    tokenRotated: tokenResult.rotated,
    installedDaemons: installed,
    bakeFailed,
  };
}

interface TokenInstallOptions {
  readonly hostTokenPath: string;
  readonly rotate: boolean;
  readonly tokenFactory: () => Uint8Array;
  readonly log: (line: string) => void;
}

async function installToken(
  env: HostEnv,
  fs: LocalFs,
  options: TokenInstallOptions,
): Promise<{ step: ProvisionStepResult; rotated: boolean }> {
  const hostPresent = await fs.exists(options.hostTokenPath);
  const guestHostd =
    (await env.guestExec(`test -f ${HOSTD_TOKEN}`, { sudo: true })).success;
  const guestRootd =
    (await env.guestExec(`test -f ${ROOTD_TOKEN}`, { sudo: true })).success;

  if (!options.rotate && hostPresent && guestHostd && guestRootd) {
    return {
      rotated: false,
      step: {
        name: "token",
        status: "skipped",
        detail: "token already provisioned (use --rotate-token to re-mint)",
      },
    };
  }

  options.log("provision: mint + install bootstrap tokens (off the wire)");
  const hostdToken = toHexToken(options.tokenFactory());
  const rootdToken = toHexToken(options.tokenFactory());

  // The SDK reads this on the host; write it 0600 before it ever leaves.
  await fs.writeSecretFile(options.hostTokenPath, `${hostdToken}\n`);

  const tmpHostd = await fs.makeTempFile(`${hostdToken}\n`);
  const tmpRootd = await fs.makeTempFile(`${rootdToken}\n`);
  try {
    await env.copyIn(tmpHostd, HOSTD_TOKEN, "0640");
    await env.copyIn(tmpRootd, ROOTD_TOKEN, "0640");
    // hostd runs as the unprivileged service user and reads BOTH its own token
    // AND rootd's (the shared bootstrap credential it presents to rootd via
    // `--rootd-token-file`), so both are owned `root:${SERVICE_USER}` 0640 —
    // rootd, running as root, still reads its own.
    await env.guestExec(
      `chown root:${SERVICE_USER} ${HOSTD_TOKEN} ${ROOTD_TOKEN}`,
      { check: true, sudo: true },
    );
  } finally {
    await fs.remove(tmpHostd).catch(() => {});
    await fs.remove(tmpRootd).catch(() => {});
  }

  return {
    rotated: true,
    step: {
      name: "token",
      status: "ran",
      detail: options.rotate ? "token rotated" : "token minted + installed",
    },
  };
}

function installFirecrackerScript(fc: string): string {
  return `if ! ${GUEST_BIN_DIR}/firecracker --version 2>/dev/null | grep -q "${fc}"; then ` +
    `arch="$(uname -m)"; tmp="$(mktemp -d)"; ` +
    `url="https://github.com/firecracker-microvm/firecracker/releases/download/${fc}/firecracker-${fc}-\${arch}.tgz"; ` +
    `curl -fsSL "$url" -o "$tmp/fc.tgz"; tar -xzf "$tmp/fc.tgz" -C "$tmp"; ` +
    `install -m0755 "$tmp/release-${fc}-\${arch}/firecracker-${fc}-\${arch}" ${GUEST_BIN_DIR}/firecracker; ` +
    `install -m0755 "$tmp/release-${fc}-\${arch}/jailer-${fc}-\${arch}" ${GUEST_BIN_DIR}/jailer; ` +
    `rm -rf "$tmp"; fi`;
}

function directoriesScript(): string {
  // Create the service group/user FIRST so the config dir can be group-owned by
  // it: the unprivileged hostd must TRAVERSE ${GUEST_ETC} to read wire.json + its
  // tokens, so own it `root:${SERVICE_USER}` 0710 (group may enter, not list;
  // files inside carry their own modes). ${GUEST_STATE_DIR} stays root — only
  // rootd (root) writes it.
  return `getent group ${SERVICE_USER} >/dev/null || groupadd --system ${SERVICE_USER}; ` +
    `id ${SERVICE_USER} >/dev/null 2>&1 || ` +
    `useradd --system --no-create-home --shell /usr/sbin/nologin -g ${SERVICE_USER} ${SERVICE_USER}; ` +
    `mkdir -p ${GUEST_ETC} ${GUEST_STATE_DIR}; ` +
    `chgrp ${SERVICE_USER} ${GUEST_ETC}; chmod 0710 ${GUEST_ETC}`;
}

function writeUnitScript(unitName: string, contents: string): string {
  return `cat > /etc/systemd/system/${unitName} <<'STUDIOBOX_UNIT_EOF'\n` +
    `${contents}STUDIOBOX_UNIT_EOF`;
}

/**
 * Write a guest config file from a quoted heredoc (no interpolation — the
 * delimiter is single-quoted, so JSON's double quotes are literal), then set its
 * mode and `root:${SERVICE_USER}` ownership. Runs under `sudo` (the caller
 * passes `{ sudo: true }`).
 */
function writeGuestConfigScript(
  path: string,
  contents: string,
  mode: string,
): string {
  return `cat > ${path} <<'STUDIOBOX_CFG_EOF'\n${contents}\nSTUDIOBOX_CFG_EOF\n` +
    `chmod ${mode} ${path}; chown root:${SERVICE_USER} ${path}`;
}
