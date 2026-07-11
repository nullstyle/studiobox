import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ensureKernel,
  KernelVerificationError,
  verifyKernelFile,
} from "../../../images/kernel.ts";
import { sha256Hex } from "../../../images/validate.ts";
import { makeTestPins } from "./helpers.ts";

const FIXTURE = new TextEncoder().encode("tiny fixture kernel\n");

Deno.test("verifyKernelFile matches and fails closed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "vmlinux");
    await Deno.writeFile(path, FIXTURE);
    const digest = await sha256Hex(FIXTURE);
    assertEquals(await verifyKernelFile(path, digest), digest);
    await assertRejects(
      () => verifyKernelFile(path, digest.replace(/^./, "0")),
      KernelVerificationError,
      "expected",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureKernel fetches, verifies, and is idempotent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pins = makeTestPins();
    const digest = await sha256Hex(FIXTURE);
    pins.kernel.perArch.aarch64.sha256 = digest;
    const destPath = join(dir, "kernels", "aarch64", "vmlinux");

    const urls: string[] = [];
    const fetchBytes = (url: string) => {
      urls.push(url);
      return Promise.resolve(FIXTURE);
    };

    const first = await ensureKernel({
      pins,
      arch: "aarch64",
      destPath,
      fetchBytes,
    });
    assertEquals(first.fetched, true);
    assertEquals(first.sha256, digest);
    assertEquals(urls, [pins.kernel.perArch.aarch64.url]);
    assertEquals(await Deno.readFile(destPath), FIXTURE);

    const second = await ensureKernel({
      pins,
      arch: "aarch64",
      destPath,
      fetchBytes,
    });
    assertEquals(second.fetched, false);
    assertEquals(urls.length, 1, "matching kernels are never re-fetched");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureKernel refuses bytes that miss the pin", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pins = makeTestPins();
    const destPath = join(dir, "vmlinux");
    await assertRejects(
      () =>
        ensureKernel({
          pins,
          arch: "aarch64",
          destPath,
          fetchBytes: () => Promise.resolve(FIXTURE),
        }),
      KernelVerificationError,
      "expected",
    );
    // A rejected download must never land at the destination.
    await assertRejects(() => Deno.stat(destPath), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureKernel replaces a stale on-disk kernel", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pins = makeTestPins();
    const digest = await sha256Hex(FIXTURE);
    pins.kernel.perArch.x86_64.sha256 = digest;
    const destPath = join(dir, "vmlinux");
    await Deno.writeFile(destPath, new TextEncoder().encode("stale"));

    const result = await ensureKernel({
      pins,
      arch: "x86_64",
      destPath,
      fetchBytes: () => Promise.resolve(FIXTURE),
    });
    assertEquals(result.fetched, true);
    assertEquals(await Deno.readFile(destPath), FIXTURE);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
