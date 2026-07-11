/**
 * Fetch + sha256-verify the pinned Firecracker-CI guest kernel(s) into
 * `images/dist/kernels/<arch>/vmlinux` (PLAN.md M4 item 1).
 *
 * This is the explicit network entry point for kernels — unit tests never
 * touch the network (they inject fixture bytes into `ensureKernel`).
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net=s3.amazonaws.com \
 *     tools/images_fetch_kernel.ts [--arch aarch64|x86_64|all] [--dir DIR]
 */

import { fromFileUrl, join } from "@std/path";
import { ensureKernel } from "../images/kernel.ts";
import {
  ARTIFACT_ARCHES,
  type ArtifactArch,
  loadImagePins,
} from "../images/pins.ts";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length - 1; i++) {
  if (Deno.args[i].startsWith("--")) args.set(Deno.args[i], Deno.args[i + 1]);
}

const archArg = args.get("--arch") ??
  (Deno.build.arch === "aarch64" ? "aarch64" : "x86_64");
const arches: ArtifactArch[] = archArg === "all"
  ? [...ARTIFACT_ARCHES]
  : [archArg as ArtifactArch];
if (!arches.every((arch) => ARTIFACT_ARCHES.includes(arch))) {
  console.error(`unknown arch ${archArg}; use aarch64, x86_64, or all`);
  Deno.exit(2);
}

const baseDir = args.get("--dir") ??
  fromFileUrl(new URL("../images/dist/kernels", import.meta.url));
const pins = await loadImagePins();

for (const arch of arches) {
  const destPath = join(baseDir, arch, "vmlinux");
  const result = await ensureKernel({ pins, arch, destPath });
  const verb = result.fetched ? "fetched" : "up to date";
  console.log(`${verb}: ${result.path} (sha256 ${result.sha256})`);
}
