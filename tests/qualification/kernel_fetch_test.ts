/**
 * M4 kernel-fetch qualification: really download the pinned Firecracker-CI
 * `vmlinux` for the host-mapped arch and verify it against the sha256 pin
 * in `images/pins.json`. Network-touching, so gated behind `SBX_QUALIFY=1`
 * like the streaming soak; needs `--allow-net=s3.amazonaws.com` plus
 * read/write for the temp download.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureKernel, verifyKernelFile } from "../../images/kernel.ts";
import { loadImagePins } from "../../images/pins.ts";

const QUALIFY = ((): boolean => {
  try {
    return Deno.env.get("SBX_QUALIFY") === "1";
  } catch {
    return false;
  }
})();

// Self-gate on permissions too: `deno task qualify:streaming` runs this
// directory with `--allow-net=127.0.0.1` and no write grant, and must not
// trip over this test. Run it via `deno task qualify:images` instead.
const PERMITTED = ((): boolean => {
  const wanted: Deno.PermissionDescriptor[] = [
    { name: "net", host: "s3.amazonaws.com" },
    { name: "write" },
    { name: "read" },
  ];
  return wanted.every(
    (descriptor) => Deno.permissions.querySync(descriptor).state === "granted",
  );
})();

Deno.test({
  name: "pinned kernel downloads and verifies against pins.json",
  ignore: !QUALIFY || !PERMITTED,
  fn: async () => {
    const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
    const pins = await loadImagePins();
    const dir = await Deno.makeTempDir({ prefix: "sbx-kernel-qualify-" });
    try {
      const destPath = join(dir, "vmlinux");
      const result = await ensureKernel({ pins, arch, destPath });
      assertEquals(result.fetched, true);
      assertEquals(result.sha256, pins.kernel.perArch[arch].sha256);
      await verifyKernelFile(destPath, pins.kernel.perArch[arch].sha256);
      const size = (await Deno.stat(destPath)).size;
      console.log(
        `kernel ${pins.kernel.version} (${arch}): ${size} bytes, sha256 ${result.sha256}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
