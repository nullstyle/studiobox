/**
 * One-command in-VM (T3) suite driver for macOS via Lima — the `test:vm`
 * task (PLAN.md §M5, ported from firecracker-deno's `smoke:lima`).
 *
 * The `tests/vm/` suite boots REAL jailed Firecracker microVMs and drives the
 * real studioboxd agent over REAL vsock, so it only runs on a Linux+KVM host
 * as root. On a Mac that host is a nested-virt Lima VM. This driver:
 *
 *   1. reuses (or, with `--recreate`, provisions) the `fc-smoke` Lima VM and
 *      verifies `/dev/kvm`;
 *   2. provisions the guest: Deno, the rootfs build deps, and the pinned
 *      Firecracker + jailer binaries (`images/pins.json` → `firecrackerPinned`);
 *   3. syncs the working tree into the guest (tarball of the git-tracked +
 *      untracked-not-ignored files — no mount, so it never touches the
 *      borrowed VM's config);
 *   4. bakes the real golden artifact set in-guest (`deno task images:build`),
 *      caching it across runs by manifest hash;
 *   5. runs `deno task test:vm:run` in-guest as root against that set with the
 *      `SBX_VM_*` environment contract from `tests/vm/support.ts`.
 *
 * It **loud-skips** (exit 0 with a reason) when the host is not macOS, Lima is
 * not installed, or `fc-smoke` is absent and `--recreate` was not passed — the
 * suite is Linux/KVM-only and is deliberately not wired into `deno task test`.
 *
 * Usage:
 *   deno task test:vm                 # reuse fc-smoke, bake, run the suite
 *   deno task test:vm --recreate      # rebuild the Lima VM from scratch first
 *   deno task test:vm --rebuild       # force a fresh golden bake
 *   deno task test:vm --siblings      # resolve capnp/firecracker from ../ (dev)
 *   deno task test:vm --name my-vm    # use a different Lima instance
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url)).replace(
  /\/$/,
  "",
);

// Persistent guest work base (survives across runs on a reused VM).
const GUEST_BASE = "/tmp/sbx-m5/vmtest";
const GUEST_REPO = `${GUEST_BASE}/repo`;
const GUEST_CACHE = `${GUEST_BASE}/cache`;
const GUEST_BUILD = `${GUEST_BASE}/build`;
const GUEST_HASH_FILE = `${GUEST_BASE}/golden.hash`;
// Short work base: it prefixes the vsock sun_path (~104-byte sockaddr_un).
const GUEST_WORK = "/tmp/sbxw";
const JAILER_BIN = "/usr/local/bin/jailer";
const FIRECRACKER_BIN = "/usr/local/bin/firecracker";

const args = new Set(Deno.args.filter((a) => a.startsWith("--")));
function flagValue(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
const name = flagValue("--name") ?? "fc-smoke";
const recreate = args.has("--recreate");
const rebuild = args.has("--rebuild");
const siblings = args.has("--siblings");

function skip(message: string): never {
  console.log(`\n⊘ test:vm skipped — ${message}\n`);
  Deno.exit(0);
}
function fail(message: string): never {
  console.error(`\n✗ test:vm — ${message}\n`);
  Deno.exit(1);
}
function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

/** Run a host command, inheriting stdio. Returns the exit code. */
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

/** Run a host command capturing stdout (stderr inherited). */
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

/** Run a bash script in the guest with Deno on PATH and cwd = the synced repo. */
function guestScript(script: string): string {
  return `export PATH="$HOME/.deno/bin:$PATH"; set -euo pipefail; ${script}`;
}
function guest(script: string, check = true): Promise<number> {
  return host(
    ["limactl", "shell", name, "--", "bash", "-lc", guestScript(script)],
    check,
  );
}
function guestCapture(script: string): Promise<string> {
  return hostCapture(
    ["limactl", "shell", name, "--", "bash", "-lc", guestScript(script)],
  );
}

// --- host gates -------------------------------------------------------------
if (Deno.build.os !== "darwin") {
  skip(
    "not macOS. On a Linux+KVM host, run `deno task test:vm:run` directly " +
      "after `deno task images:build` (set the SBX_VM_* env — see " +
      "tests/vm/support.ts)",
  );
}
try {
  await new Deno.Command("limactl", { args: ["--version"], stdout: "null" })
    .output();
} catch {
  skip("Lima not installed (`brew install lima`)");
}

const instances = (await hostCapture(["limactl", "list", "-q"])).split("\n")
  .map((s) => s.trim());
const exists = instances.includes(name);

if (recreate && exists) {
  step(`deleting Lima instance ${name}`);
  await host(["limactl", "delete", "-f", name]);
}
if (!exists && !recreate) {
  skip(
    `Lima instance ${name} not found. Provision it with ` +
      `\`deno task test:vm --recreate\` (needs an M3+ Mac, macOS 15+, nested ` +
      `virtualization)`,
  );
}
if (recreate || !exists) {
  step(`creating Lima instance ${name} (first run downloads an image)…`);
  await host([
    "limactl",
    "start",
    `--name=${name}`,
    "--vm-type=vz",
    "--nested-virt",
    "--tty=false",
    "template:ubuntu-24.04",
  ]);
}
// A reused, already-running instance is left untouched (no stop/restart).

// --- nested virtualization is the whole point -------------------------------
if (await guest("test -e /dev/kvm", false) !== 0) {
  fail(
    `/dev/kvm missing in ${name}: nested virtualization needs an M3+ Mac on ` +
      `macOS 15+ with vmType vz. The instance is kept for inspection ` +
      `(limactl shell ${name}).`,
  );
}
console.log("✓ /dev/kvm present in guest");

// --- provision the guest toolchain (idempotent) -----------------------------
step("provisioning guest toolchain (Deno, build deps, Firecracker)…");
const pins = JSON.parse(
  await Deno.readTextFile(join(REPO_ROOT, "images", "pins.json")),
) as { kernel: { firecrackerPinned: string } };
const fcVersion = pins.kernel.firecrackerPinned;

await guest(
  `command -v deno >/dev/null || (curl -fsSL https://deno.land/install.sh | sh -s -- -y)`,
);
await guest(
  `(command -v debootstrap >/dev/null && command -v mke2fs >/dev/null && ` +
    `command -v unzip >/dev/null) || (sudo apt-get update -q && ` +
    `sudo apt-get install -y -q debootstrap e2fsprogs unzip squashfs-tools)`,
);
await guest(
  `if ! ${FIRECRACKER_BIN} --version 2>/dev/null | grep -q "${fcVersion}"; then\n` +
    `  arch="$(uname -m)"; tmp="$(mktemp -d)";\n` +
    `  url="https://github.com/firecracker-microvm/firecracker/releases/download/${fcVersion}/firecracker-${fcVersion}-\${arch}.tgz";\n` +
    `  echo "installing Firecracker ${fcVersion} (\${arch})"; curl -fsSL "$url" -o "$tmp/fc.tgz";\n` +
    `  tar -xzf "$tmp/fc.tgz" -C "$tmp";\n` +
    `  sudo install -m0755 "$tmp/release-${fcVersion}-\${arch}/firecracker-${fcVersion}-\${arch}" ${FIRECRACKER_BIN};\n` +
    `  sudo install -m0755 "$tmp/release-${fcVersion}-\${arch}/jailer-${fcVersion}-\${arch}" ${JAILER_BIN};\n` +
    `  rm -rf "$tmp";\n` +
    `fi;\n` +
    `${FIRECRACKER_BIN} --version | head -1; ${JAILER_BIN} --version | head -1`,
);

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
// --no-xattrs: bsdtar otherwise emits macOS provenance xattr headers that
// GNU tar in the guest can't read and warns about, one line per file.
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
await host(["limactl", "cp", tgzPath, `${name}:${GUEST_BASE}/repo.tgz`]);
await guest(
  `rm -rf ${GUEST_REPO} && mkdir -p ${GUEST_REPO} && ` +
    `tar --warning=no-unknown-keyword -xzf ${GUEST_BASE}/repo.tgz ` +
    `-C ${GUEST_REPO} && rm -f ${GUEST_BASE}/repo.tgz && ` +
    // Belt: drop any macOS AppleDouble sidecars so `deno test` never globs
    // a `._*.ts` and chokes parsing its resource-fork bytes.
    `find ${GUEST_REPO} -name '._*' -delete`,
);
await Deno.remove(listPath).catch(() => {});
await Deno.remove(tgzPath).catch(() => {});

// Optional dev mode: carry the capnp/firecracker siblings for deno.local.json.
let configArg = "";
let sbxConfigEnv = "";
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
    await host(["limactl", "cp", st, `${name}:${GUEST_BASE}/${sib}.tgz`]);
    await guest(
      `rm -rf ${GUEST_BASE}/${sib} && mkdir -p ${GUEST_BASE}/${sib} && ` +
        `tar --warning=no-unknown-keyword -xzf ${GUEST_BASE}/${sib}.tgz ` +
        `-C ${GUEST_BASE}/${sib} && rm -f ${GUEST_BASE}/${sib}.tgz`,
    );
    await Deno.remove(sl).catch(() => {});
    await Deno.remove(st).catch(() => {});
  }
  configArg = `--config ${GUEST_REPO}/deno.local.json`;
  sbxConfigEnv = `SBX_VM_CONFIG=${GUEST_REPO}/deno.local.json`;
}

// --- bake the real golden set (cached by manifest hash across runs) ---------
step("baking the real golden artifact set…");
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

// --- prewarm the warm-restore template (snapshot_vm_test.ts requires it) -----
// Without a template for this golden hash, the snapshot strategy falls SAFE to
// cold and the restore-path assertions fail. Idempotent (reused if present).
// `--work` MUST be OUTSIDE ${GUEST_REPO}: template:build runs as root and would
// otherwise leave a root-owned .build/ that the next run's `rm -rf repo` (as the
// unprivileged user) cannot remove.
step("baking the warm-restore template…");
await guest(
  `cd ${GUEST_REPO} && sudo -E "$(command -v deno)" run -A --unstable-vsock ` +
    `${configArg} tools/build_warm_template.ts --arch "$(uname -m)" ` +
    `--hash ${manifestHash} --cache-root ${GUEST_CACHE} ` +
    `--work ${GUEST_BASE}/template-build`,
);

// --- run the in-VM suite as root against the golden set ---------------------
step("running the tests/vm/ suite inside the guest as root…");
const env = [
  "SBX_VM=1",
  `SBX_VM_CACHE=${GUEST_CACHE}`,
  `SBX_VM_MANIFEST_HASH=${manifestHash}`,
  `SBX_VM_WORK=${GUEST_WORK}`,
  `SBX_VM_JAILER_BIN=${JAILER_BIN}`,
  `SBX_VM_FIRECRACKER_BIN=${FIRECRACKER_BIN}`,
  sbxConfigEnv,
].filter((e) => e !== "").join(" ");

const code = await guest(
  `cd ${GUEST_REPO} && sudo mkdir -p ${GUEST_WORK} && ` +
    `sudo -E env ${env} "$(command -v deno)" task test:vm:run`,
  false,
);

if (code === 0) {
  console.log(
    `\n✓ test:vm OK — real Firecracker microVM lifecycle green inside ${name}.` +
      `\n  Instance kept for fast re-runs (golden set cached at ` +
      `${GUEST_CACHE}/${manifestHash}).`,
  );
} else {
  fail(`the in-VM suite failed inside ${name} (exit ${code})`);
}
