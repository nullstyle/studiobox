/**
 * One-command driver for the M8 Parity-real GATE on macOS via Lima
 * (`deno task test:vm:parity`; PLAN.md §M8).
 *
 * The M8 exit proof reruns the M3 upstream-parity fixture suite against the
 * REAL two-daemon stack — studiobox-rootd + studiobox-hostd as separate
 * processes behind real jailed Firecracker microVMs — reached by a
 * {@link StudioboxProvider} over loopback (`tests/vm/parity_vm_test.ts`). Like
 * {@link lima_vm_test.ts} it reuses the `fc-smoke` guest, syncs the working
 * tree, and bakes (or reuses) the golden artifact set; ON TOP of that it:
 *
 *   1. compiles the daemons in-guest (`deno task daemons:compile`), so the
 *      parity harness spawns the ACTUAL shipped binaries, and
 *   2. runs ONLY the parity gate file with the `SBX_VM_*` contract plus
 *      `SBX_VM_{HOSTD,ROOTD}_BIN` naming the compiled daemons.
 *
 * It **loud-skips** (exit 0 with a reason) when the host is not macOS, Lima is
 * absent, or `fc-smoke` has not been provisioned by `deno task test:vm
 * --recreate` (which this driver deliberately does NOT do — provisioning the
 * base VM is that driver's job; this one reuses it).
 *
 * Usage:
 *   deno task test:vm:parity            # reuse fc-smoke, compile, run the gate
 *   deno task test:vm:parity --rebuild  # force a fresh golden bake first
 *   deno task test:vm:parity --siblings # resolve capnp/firecracker from ../ (dev)
 *   deno task test:vm:parity --name x   # use a different Lima instance
 *
 * @module
 */

import { fromFileUrl } from "@std/path";
import {
  buildShellArgv,
  type CommandResult,
  Limactl,
  strictWrap,
} from "@nullstyle/lima";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);

// Reuse the exact guest layout `tools/lima_vm_test.ts` establishes so the
// baked golden set and synced repo are shared across both drivers.
const GUEST_BASE = "/tmp/sbx-m5/vmtest";
const GUEST_REPO = `${GUEST_BASE}/repo`;
const GUEST_CACHE = `${GUEST_BASE}/cache`;
const GUEST_BUILD = `${GUEST_BASE}/build`;
const GUEST_HASH_FILE = `${GUEST_BASE}/golden.hash`;
const GUEST_WORK = "/tmp/sbxw";
const JAILER_BIN = "/usr/local/bin/jailer";
const FIRECRACKER_BIN = "/usr/local/bin/firecracker";

const args = new Set(Deno.args.filter((a) => a.startsWith("--")));
function flagValue(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const name = flagValue("--name") ?? "fc-smoke";
const rebuild = args.has("--rebuild");
const siblings = args.has("--siblings");
/** The in-guest gate file to run (default: the M8 parity gate). */
const gateFile = flagValue("--gate") ?? "tests/vm/parity_vm_test.ts";
const gateLabel = gateFile.split("/").pop() ?? gateFile;
/** `--soak <cycles>`: run the real-microVM no-leak soak instead of a gate. */
const soakCycles = flagValue("--soak");

function skip(message: string): never {
  console.log(`\n⊘ test:vm:parity skipped — ${message}\n`);
  Deno.exit(0);
}
function fail(message: string): never {
  console.error(`\n✗ test:vm:parity — ${message}\n`);
  Deno.exit(1);
}
function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

/** Run a host command, inheriting stdio (git/tar — the non-limactl work). */
async function host(cmd: string[], check = true): Promise<number> {
  console.log(`$ ${cmd.join(" ")}`);
  const status = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (check && !status.success) {
    fail(`command failed (${status.code}): ${cmd.join(" ")}`);
  }
  return status.code;
}

async function hostCapture(cmd: string[]): Promise<string> {
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!out.success) fail(`command failed: ${cmd.join(" ")}`);
  return new TextDecoder().decode(out.stdout);
}

// All limactl work flows through @nullstyle/lima. The package CAPTURES guest
// output (bounded at 64 KiB unless a call opts out) instead of streaming it,
// so the helpers below echo the captured streams after each command completes.
const lima = new Limactl();
const vm = lima.instance(name);

/** Await a package call, converting its typed failure into the driver's ✗ fail. */
async function orFail<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run a bash script in the guest with Deno on PATH. `exec()` adds the old
 * inline helper's `set -euo pipefail; ` wrap itself; the `uncapped` path
 * rebuilds the identical argv from the package's exported shell grammar,
 * because `exec()` has no capture-cap escape hatch.
 */
function guestRun(script: string, uncapped: boolean): Promise<CommandResult> {
  const withPath = `export PATH="$HOME/.deno/bin:$PATH"; ${script}`;
  return uncapped
    ? lima.raw(buildShellArgv(name, strictWrap(withPath)), { uncapped: true })
    : vm.exec(withPath);
}

/** Guest exec, echoing captured output; `check` (default) fails the driver on nonzero exit. */
async function guest(
  script: string,
  options: { check?: boolean; uncapped?: boolean } = {},
): Promise<CommandResult> {
  console.log(`$ [${name}] ${script}`);
  const result = await guestRun(script, options.uncapped === true);
  const out = result.stdout.trimEnd();
  if (out.length > 0) console.log(out);
  const err = result.stderr.trimEnd();
  if (err.length > 0) console.error(err);
  if (options.check !== false && !result.success) {
    fail(`guest command failed (${result.code}): ${script}`);
  }
  return result;
}

/** Guest exec returning stdout (stderr echoed after completion); fails on nonzero exit. */
async function guestCapture(
  script: string,
  options: { uncapped?: boolean } = {},
): Promise<string> {
  const result = await guestRun(script, options.uncapped === true);
  const err = result.stderr.trimEnd();
  if (err.length > 0) console.error(err);
  if (!result.success) {
    fail(`guest command failed (${result.code}): ${script}`);
  }
  return result.stdout;
}

// --- host gates -------------------------------------------------------------
if (Deno.build.os !== "darwin") {
  skip(
    "not macOS. On a Linux+KVM host, compile the daemons and run " +
      "`deno test tests/vm/parity_vm_test.ts` with the SBX_VM_* env directly " +
      "(see tests/vm/real_stack.ts).",
  );
}
if (!(await lima.available())) {
  skip("Lima not installed (`brew install lima`)");
}

if (!(await orFail(lima.exists(name)))) {
  skip(
    `Lima instance ${name} not found. Provision it first with ` +
      `\`deno task test:vm --recreate\`.`,
  );
}

if (!(await guest("test -e /dev/kvm", { check: false })).success) {
  fail(`/dev/kvm missing in ${name}: provision with \`deno task test:vm\`.`);
}
console.log("✓ /dev/kvm present in guest");

// --- sync the working tree into the guest (no mount) ------------------------
step("syncing working tree into the guest…");
const fileList = await hostCapture([
  "git",
  "-C",
  REPO_ROOT,
  "ls-files",
  "-co",
  "--exclude-standard",
]);
const listPath = await Deno.makeTempFile({ suffix: ".vmfiles" });
await Deno.writeTextFile(listPath, fileList);
const tgzPath = await Deno.makeTempFile({ suffix: ".repo.tgz" });
await host([
  "tar",
  "--no-xattrs",
  "-czf",
  tgzPath,
  "-C",
  REPO_ROOT,
  "-T",
  listPath,
]);
await guest(`mkdir -p ${GUEST_BASE}`);
await orFail(vm.copyIn(tgzPath, `${GUEST_BASE}/repo.tgz`));
await guest(
  `rm -rf ${GUEST_REPO} && mkdir -p ${GUEST_REPO} && ` +
    `tar --warning=no-unknown-keyword -xzf ${GUEST_BASE}/repo.tgz ` +
    `-C ${GUEST_REPO} && rm -f ${GUEST_BASE}/repo.tgz && ` +
    `find ${GUEST_REPO} -name '._*' -delete`,
);
await Deno.remove(listPath).catch(() => {});
await Deno.remove(tgzPath).catch(() => {});

// Optional dev mode: carry the capnp/firecracker siblings for deno.local.json.
let configArg = "";
if (siblings) {
  step("carrying capnp/firecracker siblings (--siblings)…");
  for (const sib of ["capnp-deno", "firecracker-deno"]) {
    const sibRoot = fromFileUrl(new URL(`../../${sib}/`, import.meta.url))
      .replace(/\/$/, "");
    const sibList = await hostCapture([
      "git",
      "-C",
      sibRoot,
      "ls-files",
      "-co",
      "--exclude-standard",
    ]);
    const sl = await Deno.makeTempFile({ suffix: ".sibfiles" });
    await Deno.writeTextFile(sl, sibList);
    const st = await Deno.makeTempFile({ suffix: `.${sib}.tgz` });
    await host(["tar", "--no-xattrs", "-czf", st, "-C", sibRoot, "-T", sl]);
    await orFail(vm.copyIn(st, `${GUEST_BASE}/${sib}.tgz`));
    await guest(
      `rm -rf ${GUEST_BASE}/${sib} && mkdir -p ${GUEST_BASE}/${sib} && ` +
        `tar --warning=no-unknown-keyword -xzf ${GUEST_BASE}/${sib}.tgz ` +
        `-C ${GUEST_BASE}/${sib} && rm -f ${GUEST_BASE}/${sib}.tgz`,
    );
    await Deno.remove(sl).catch(() => {});
    await Deno.remove(st).catch(() => {});
  }
  configArg = `--config ${GUEST_REPO}/deno.local.json`;
}

// --- ensure a golden set (reuse the cache lima_vm_test baked) ---------------
step("resolving the golden artifact set…");
const cached = rebuild ? "" : (await guestCapture(
  `if [ -f ${GUEST_HASH_FILE} ]; then h="$(cat ${GUEST_HASH_FILE})"; ` +
    `[ -d "${GUEST_CACHE}/$h" ] && printf '%s' "$h" || true; fi`,
)).trim();

let manifestHash: string;
if (cached) {
  console.log(`✓ reusing cached golden set ${cached}`);
  manifestHash = cached;
} else {
  const buildOut = await guestCapture(
    `cd ${GUEST_REPO} && sudo -E "$(command -v deno)" run -A ${configArg} ` +
      `tools/build_golden_set.ts --arch "$(uname -m)" ` +
      `--cache-root ${GUEST_CACHE} --work ${GUEST_BUILD}`,
    // The build log's LAST line feeds JSON.parse below, so the capture must
    // be whole — lift the package's 64 KiB cap.
    { uncapped: true },
  );
  const lastLine = buildOut.trim().split("\n").at(-1) ?? "";
  let parsed: { hash?: string };
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    fail(`images:build did not print a result JSON line (got: ${lastLine})`);
  }
  if (!parsed.hash) fail("images:build result JSON has no hash");
  manifestHash = parsed.hash;
  await guest(`printf '%s' ${manifestHash} > ${GUEST_HASH_FILE}`);
  console.log(`✓ baked golden set ${manifestHash}`);
}

// --- prewarm the warm-restore template when running the snapshot gate --------
// snapshot_vm_test.ts asserts the RESTORE path, which needs a template for this
// golden hash (else it falls safe to cold and the assertions fail). Idempotent.
// `--work` stays OUTSIDE ${GUEST_REPO} so the root-owned build tree never blocks
// the next run's `rm -rf repo`.
if (gateFile.includes("snapshot")) {
  step("baking the warm-restore template (snapshot gate)…");
  await guest(
    `cd ${GUEST_REPO} && sudo -E "$(command -v deno)" run -A --unstable-vsock ` +
      `${configArg} tools/build_warm_template.ts --arch "$(uname -m)" ` +
      `--hash ${manifestHash} --cache-root ${GUEST_CACHE} ` +
      `--work ${GUEST_BASE}/template-build`,
  );
}

// --- compile the daemons in-guest (the ACTUAL shipped binaries) -------------
step("compiling studiobox-rootd + studiobox-hostd in-guest…");
await guest(`cd ${GUEST_REPO} && "$(command -v deno)" task daemons:compile`);
const hostdBin = `${GUEST_REPO}/.build/studiobox-hostd`;
const rootdBin = `${GUEST_REPO}/.build/studiobox-rootd`;

// --- run the gate as root against the real stack ----------------------------
step(`running ${gateLabel} inside the guest as root…`);
const env = [
  "SBX_VM=1",
  `SBX_VM_CACHE=${GUEST_CACHE}`,
  `SBX_VM_MANIFEST_HASH=${manifestHash}`,
  `SBX_VM_WORK=${GUEST_WORK}`,
  `SBX_VM_JAILER_BIN=${JAILER_BIN}`,
  `SBX_VM_FIRECRACKER_BIN=${FIRECRACKER_BIN}`,
  `SBX_VM_HOSTD_BIN=${hostdBin}`,
  `SBX_VM_ROOTD_BIN=${rootdBin}`,
].join(" ");

// The daemons are reaped by the suite's async teardown and, as a safety net
// against a cancelled run, by an `unload` handler in `tests/vm/real_stack.ts`
// (SIGKILL on process exit) — so a stale daemon never lingers on the fixed
// loopback ports between runs. (We deliberately do NOT `pkill -f
// studiobox-hostd` here: that pattern also appears in this command's own
// SBX_VM_*_BIN env, so `pkill -f` would match and kill its own shell.)
if (soakCycles !== undefined) {
  // `--soak N`: the real-microVM no-leak drill runs the supervisor IN-PROCESS
  // (no compiled daemons), so just point soak_vm_main at the SBX_VM_* contract.
  const soakEnv = `${env} SBX_SOAK_CYCLES=${soakCycles}`;
  // Tradeoff vs the old inherit-stdio helper: the package captures output, so
  // the soak's log prints only AFTER it finishes (uncapped — the log and any
  // failure tail must not be truncated), instead of streaming.
  const { code } = await guest(
    `cd ${GUEST_REPO} && sudo mkdir -p ${GUEST_WORK} && ` +
      `sudo -E env ${soakEnv} "$(command -v deno)" run -A --unstable-vsock ` +
      `tools/soak/soak_vm_main.ts`,
    { check: false, uncapped: true },
  );
  if (code === 0) {
    console.log(
      `\n✓ soak:vm OK — ${soakCycles} cycles clean, no leaks, inside ${name}.`,
    );
  } else {
    fail(`soak:vm failed inside ${name} (exit ${code})`);
  }
} else {
  // Tradeoff vs the old inherit-stdio helper: the package captures output, so
  // the gate's test report prints only AFTER it finishes (uncapped — the
  // report and any failure tail must not be truncated), instead of streaming.
  const { code } = await guest(
    `cd ${GUEST_REPO} && sudo mkdir -p ${GUEST_WORK} && ` +
      `sudo -E env ${env} "$(command -v deno)" test -A --unstable-vsock ` +
      gateFile,
    { check: false, uncapped: true },
  );

  if (code === 0) {
    console.log(
      `\n✓ ${gateLabel} OK — green against REAL sandboxes inside ${name}.`,
    );
  } else {
    fail(`${gateLabel} failed inside ${name} (exit ${code})`);
  }
}
