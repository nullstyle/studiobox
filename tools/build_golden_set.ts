/**
 * Bake the REAL golden artifact set and store it in the M4 artifact cache
 * (PLAN.md §M5, DESIGN.md §7). This is the `images:build` task.
 *
 * It bakes the **compiled studioboxd** into the rootfs, so a launched microVM
 * comes up on the real `sandbox_agent.capnp` vsock plane. End to end it:
 *
 *   1. `deno compile`s `src/agent/main.ts` for the target arch (native when
 *      the tool runs on that arch), producing the self-contained
 *      `studioboxd` binary and its sha256 (an input pin);
 *   2. fetch-and-verifies the pinned guest kernel (`images/kernel.ts`);
 *   3. runs `images/build_rootfs.sh` with the committed pins and the real
 *      agent, producing `rootfs.ext4` + its canonical content manifest;
 *   4. assembles the artifact `manifest.json` from the pins + observed
 *      identity (content-manifest hash, per `images/README.md`);
 *   5. `store()`s the set (kernel + rootfs + agent) into the cache, verified
 *      against the manifest's sha256 pins, and prints the manifest hash.
 *
 * Linux + root required (the same gate as `build_rootfs.sh`: `mke2fs -d`
 * ownership, `debootstrap`). Runs inside the `fc-smoke` Lima VM under the
 * `test:vm` driver, or directly on any Linux+KVM CI runner.
 *
 * Machine-readable contract: the FINAL stdout line is a JSON object
 * `{ "hash", "cacheRoot", "created", "arch" }`. All human logs go to stderr.
 *
 * Usage:
 *   deno run -A tools/build_golden_set.ts \
 *     [--arch aarch64|x86_64] [--cache-root DIR] [--work DIR] [--config PATH]
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";
import { loadImagePins } from "../images/pins.ts";
import type { ArtifactArch } from "../images/pins.ts";
import {
  contentManifestHash,
  parseContentManifest,
} from "../images/content_manifest.ts";
import { manifestFromPins } from "../images/manifest.ts";
import { ensureKernel } from "../images/kernel.ts";
import { sha256HexOfFile } from "../images/validate.ts";
import { ArtifactCache } from "../images/cache.ts";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

function log(message: string): void {
  console.error(`[images:build] ${message}`);
}

function fail(message: string): never {
  console.error(`[images:build] ✗ ${message}`);
  Deno.exit(1);
}

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (!arg.startsWith("--")) continue;
    const next = Deno.args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(arg, next);
      i++;
    } else {
      args.set(arg, "true");
    }
  }
  return args;
}

/** Run a subprocess, streaming its output; throw on non-zero exit. */
async function run(
  cmd: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<void> {
  log(`$ ${cmd.join(" ")}`);
  const status = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
    env: opts.env,
  }).spawn().status;
  if (!status.success) {
    fail(`command failed (${status.code}): ${cmd.join(" ")}`);
  }
}

const args = parseArgs();
const arch = (args.get("--arch") ??
  (Deno.build.arch === "aarch64" ? "aarch64" : "x86_64")) as ArtifactArch;
if (arch !== "aarch64" && arch !== "x86_64") {
  fail(`unsupported --arch ${arch}`);
}
if (Deno.build.os !== "linux") {
  fail("the real golden bake only runs on Linux (debootstrap + mke2fs -d)");
}

const cacheRoot = args.get("--cache-root") ??
  join(REPO_ROOT, ".build", "vm-cache");
const work = args.get("--work") ?? join(REPO_ROOT, ".build", "vm-build");
const configPath = args.get("--config");
const configArgs = configPath ? ["--config", configPath] : [];

await Deno.mkdir(work, { recursive: true });
const pins = await loadImagePins();
const denoPin = pins.guestDeno.perArch[arch];

// --- 1. compile the real studioboxd -----------------------------------------
const agentPath = join(work, "studioboxd");
log(`compiling studioboxd (${arch}) → ${agentPath}`);
await run([
  Deno.execPath(),
  "compile",
  "-A",
  "--unstable-vsock",
  ...configArgs,
  "--output",
  agentPath,
  join(REPO_ROOT, "src", "agent", "main.ts"),
]);
const agentSha = await sha256HexOfFile(agentPath);
log(`studioboxd sha256 ${agentSha}`);

// --- 2. fetch + verify the pinned kernel ------------------------------------
const kernelPath = join(work, "vmlinux");
const kernel = await ensureKernel({ pins, arch, destPath: kernelPath });
log(
  `kernel ${kernel.fetched ? "fetched" : "cached"} (sha256 ${kernel.sha256})`,
);

// --- 3. build the golden rootfs with the real agent -------------------------
const builderScript = join(REPO_ROOT, "images", "build_rootfs.sh");
const overlayInit = join(
  REPO_ROOT,
  "images",
  "overlay_init",
  "overlay-init.sh",
);
const rootfsOut = join(work, "rootfs");
log("building golden rootfs (debootstrap; first run downloads packages)…");
await run([
  "bash",
  builderScript,
  "--out",
  rootfsOut,
  "--arch",
  arch,
  "--suite",
  pins.rootfs.suite,
  "--epoch",
  pins.rootfs.snapshotEpoch,
  "--mirror",
  pins.rootfs.mirror,
  "--packages",
  pins.rootfs.packages.join(","),
  "--image-size-mib",
  String(pins.rootfs.imageSizeMiB),
  "--sandbox-user",
  pins.rootfs.sandboxUser.name,
  "--sandbox-uid",
  String(pins.rootfs.sandboxUser.uid),
  "--sandbox-home",
  pins.rootfs.sandboxUser.home,
  "--deno-url",
  denoPin.url,
  "--deno-sha256",
  denoPin.sha256,
  "--deno-bin",
  Deno.execPath(),
  "--agent",
  agentPath,
  "--overlay-init",
  overlayInit,
]);

const rootfsPath = join(rootfsOut, "rootfs.ext4");
const contentManifestPath = join(rootfsOut, "rootfs.manifest.txt");
const rootfsSizeBytes = (await Deno.stat(rootfsPath)).size;

// --- 4. assemble the artifact manifest --------------------------------------
const identitySha = await contentManifestHash(
  parseContentManifest(await Deno.readTextFile(contentManifestPath)),
);
const manifest = manifestFromPins({
  pins,
  arch,
  builderScriptSha256: await sha256HexOfFile(builderScript),
  overlayInitSha256: await sha256HexOfFile(overlayInit),
  agentBinary: { filename: "studioboxd", sha256: agentSha },
  identity: { kind: "contentManifest", sha256: identitySha },
  rootfsSizeBytes,
});

// --- 5. store into the artifact cache ---------------------------------------
const cache = new ArtifactCache({ root: cacheRoot });
const stored = await cache.store({
  manifest,
  files: {
    vmlinux: kernelPath,
    "rootfs.ext4": rootfsPath,
    studioboxd: agentPath,
  },
});
log(
  `${stored.created ? "stored" : "reused"} golden set ${stored.hash} ` +
    `in ${cacheRoot}`,
);

// Machine-readable final line for the test:vm driver.
console.log(JSON.stringify({
  hash: stored.hash,
  cacheRoot,
  created: stored.created,
  arch,
}));
