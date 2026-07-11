/**
 * Emit the canonical content manifest of a rootfs tree to stdout.
 *
 * Run by `images/build_rootfs.sh` inside the build VM with the pinned
 * guest Deno binary (no import map, no dependencies):
 *
 * ```sh
 * deno run --allow-read=<rootfs> images/emit_content_manifest.ts <rootfs>
 * ```
 *
 * The manifest text goes to stdout; the entry count and the content
 * manifest hash go to stderr so `> rootfs.manifest.txt` stays clean.
 */

import {
  collectContentManifest,
  contentManifestHash,
  formatContentManifest,
} from "./content_manifest.ts";

if (import.meta.main) {
  const root = Deno.args[0];
  if (root === undefined || Deno.args.length !== 1) {
    console.error("usage: emit_content_manifest.ts <rootfs-dir>");
    Deno.exit(2);
  }
  const entries = await collectContentManifest(root);
  const text = formatContentManifest(entries);
  const bytes = new TextEncoder().encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += await Deno.stdout.write(bytes.subarray(written));
  }
  console.error(
    `entries=${entries.length} contentManifestHash=${await contentManifestHash(
      entries,
    )}`,
  );
}
