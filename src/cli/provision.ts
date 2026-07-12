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
 *   6. `systemd`      — write the units, `daemon-reload`, `enable --now`.
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
import { fromFileUrl } from "@std/path";
import type { ArtifactArch } from "../../images/pins.ts";
import type { HostEnv } from "./host_env.ts";
import type { HostPortConfig } from "./lima_template.ts";
import type { LocalFs } from "./local_fs.ts";

// Guest-side layout (logical-id / short paths; DESIGN.md §8, §12).
const GUEST_BIN_DIR = "/usr/local/bin";
export const HOSTD_BIN = `${GUEST_BIN_DIR}/studiobox-hostd`;
export const ROOTD_BIN = `${GUEST_BIN_DIR}/studiobox-rootd`;
const GUEST_ETC = "/etc/studiobox";
export const HOSTD_TOKEN = `${GUEST_ETC}/hostd.token`;
export const ROOTD_TOKEN = `${GUEST_ETC}/rootd.token`;
export const WIRE_JSON = `${GUEST_ETC}/wire.json`;
const GUEST_STATE_DIR = "/var/lib/studiobox";
export const JOURNAL_PATH = `${GUEST_STATE_DIR}/journal.json`;
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

/** Path to the committed `compat/wire.json` shipped into the guest. */
export function defaultCompatPath(): string {
  return fromFileUrl(import.meta.resolve("../../compat/wire.json"));
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
  | "binaries"
  | "token"
  | "systemd";

/** The fixed step order (also the assertion order in tests). */
export const PROVISION_STEP_ORDER: readonly ProvisionStepName[] = [
  "packages",
  "firecracker",
  "directories",
  "binaries",
  "token",
  "systemd",
];

/** Aggregate result of {@linkcode provisionHost}. */
export interface ProvisionResult {
  readonly steps: readonly ProvisionStepResult[];
  readonly warnings: readonly string[];
  /** True when the token step minted a fresh token this run. */
  readonly tokenRotated: boolean;
  /** Which daemons had their binary installed + unit enabled. */
  readonly installedDaemons: readonly ("hostd" | "rootd")[];
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
  /** Re-mint the token even when one already exists. @default false */
  readonly rotateToken?: boolean;
  /** Bootstrap-token source (32 bytes). @default 32 random bytes */
  readonly tokenFactory?: () => Uint8Array;
  /** Progress sink. @default no-op */
  readonly log?: (line: string) => void;
}

const TOKEN_BYTES = 32;

/**
 * Render the two systemd units. Pure + exported so a unit test pins the
 * `ExecStart` argv (which must match the daemons' own flag parsers) without a
 * host.
 */
export function renderSystemdUnits(
  ports: HostPortConfig,
): { readonly rootd: string; readonly hostd: string } {
  const rootd = `[Unit]
Description=studiobox-rootd (root supervisor)
Documentation=https://jsr.io/@nullstyle/studiobox
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=${ROOTD_BIN} --socket ${SUPERVISOR_SOCK} --state ${JOURNAL_PATH} --token-file ${ROOTD_TOKEN} --build-id ${BUILD_ID} --compat ${WIRE_JSON}
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
ExecStart=${HOSTD_BIN} --listen 0.0.0.0:${ports.control} --rootd-socket ${SUPERVISOR_SOCK} --token-file ${HOSTD_TOKEN} --rootd-token-file ${ROOTD_TOKEN} --build-id ${BUILD_ID} --compat ${WIRE_JSON}
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
      `command -v unzip >/dev/null) || ` +
      `(apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q ` +
      `nftables dnsmasq debootstrap e2fsprogs unzip)`,
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

  // 6) systemd units -------------------------------------------------------
  const units = renderSystemdUnits(ports);
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
    // Enable rootd first (hostd Requires= it); a single enable of both is fine
    // because hostd's ordering dependency sequences the start.
    await env.guestExec(
      "systemctl enable --now studiobox-rootd.service studiobox-hostd.service",
      { check: true, sudo: true },
    );
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
    // hostd runs as the unprivileged service user; let it read its own token.
    await env.guestExec(
      `chown root:${SERVICE_USER} ${HOSTD_TOKEN}`,
      { check: true, sudo: true },
    );
    await env.copyIn(tmpRootd, ROOTD_TOKEN, "0600");
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
  return `mkdir -p ${GUEST_ETC} ${GUEST_STATE_DIR}; ` +
    `chmod 0710 ${GUEST_ETC}; ` +
    `getent group ${SERVICE_USER} >/dev/null || groupadd --system ${SERVICE_USER}; ` +
    `id ${SERVICE_USER} >/dev/null 2>&1 || ` +
    `useradd --system --no-create-home --shell /usr/sbin/nologin -g ${SERVICE_USER} ${SERVICE_USER}`;
}

function writeUnitScript(unitName: string, contents: string): string {
  return `cat > /etc/systemd/system/${unitName} <<'STUDIOBOX_UNIT_EOF'\n` +
    `${contents}STUDIOBOX_UNIT_EOF`;
}
