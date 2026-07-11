import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { stageArtifacts, StagingError } from "../../../images/staging.ts";

const KERNEL_BYTES = new TextEncoder().encode("fixture kernel bytes\n");
const ROOTFS_BYTES = new TextEncoder().encode("fixture golden rootfs bytes\n");
const MIB = 1024 * 1024;

async function makeGolden(dir: string) {
  const kernelSourcePath = join(dir, "golden", "vmlinux");
  const rootfsSourcePath = join(dir, "golden", "rootfs.ext4");
  await Deno.mkdir(join(dir, "golden"), { recursive: true });
  await Deno.writeFile(kernelSourcePath, KERNEL_BYTES, { mode: 0o644 });
  await Deno.writeFile(rootfsSourcePath, ROOTFS_BYTES, { mode: 0o644 });
  return { kernelSourcePath, rootfsSourcePath };
}

Deno.test("staging copies into the jail layout with a sparse overlay", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const golden = await makeGolden(dir);
    const jailRoot = join(dir, "jail", "root");
    const staged = await stageArtifacts({
      ...golden,
      jailRoot,
      overlaySizeBytes: 64 * MIB,
    });

    assertEquals(staged.kernelPath, join(jailRoot, "vmlinux"));
    assertEquals(staged.rootfsPath, join(jailRoot, "rootfs.ext4"));
    assertEquals(staged.overlayPath, join(jailRoot, "overlay.ext4"));
    assertEquals(await Deno.readFile(staged.kernelPath), KERNEL_BYTES);
    assertEquals(await Deno.readFile(staged.rootfsPath), ROOTFS_BYTES);

    const overlay = await Deno.stat(staged.overlayPath);
    assertEquals(overlay.size, 64 * MIB, "overlay is sized to the budget");
    assert(overlay.blocks !== null);
    assert(
      overlay.blocks * 512 < MIB,
      `overlay must be sparse, found ${overlay.blocks} blocks allocated`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("REGRESSION: staging never mutates the golden source", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const golden = await makeGolden(dir);
    const goldenRootfsBefore = await Deno.stat(golden.rootfsSourcePath);
    const goldenKernelBefore = await Deno.stat(golden.kernelSourcePath);

    const staged = await stageArtifacts({
      ...golden,
      jailRoot: join(dir, "jail"),
      overlaySizeBytes: 8 * MIB,
    });

    // Distinct inodes: copy-only, never hardlink.
    const stagedRootfs = await Deno.stat(staged.rootfsPath);
    const stagedKernel = await Deno.stat(staged.kernelPath);
    assert(stagedRootfs.ino !== null && goldenRootfsBefore.ino !== null);
    assertNotEquals(stagedRootfs.ino, goldenRootfsBefore.ino);
    assertNotEquals(stagedKernel.ino, goldenKernelBefore.ino);

    // The in-jail mutation drill: chmod + rewrite the staged copies.
    await Deno.chmod(staged.rootfsPath, 0o777);
    await Deno.chmod(staged.kernelPath, 0o700);
    await Deno.writeFile(
      staged.rootfsPath,
      new TextEncoder().encode("scribbled by the jail\n"),
    );

    // Golden bytes and mode are untouched.
    const goldenRootfsAfter = await Deno.stat(golden.rootfsSourcePath);
    assertEquals(
      goldenRootfsAfter.mode! & 0o7777,
      goldenRootfsBefore.mode! & 0o7777,
      "golden rootfs mode must not change",
    );
    assertEquals(
      (await Deno.stat(golden.kernelSourcePath)).mode! & 0o7777,
      goldenKernelBefore.mode! & 0o7777,
      "golden kernel mode must not change",
    );
    assertEquals(
      await Deno.readFile(golden.rootfsSourcePath),
      ROOTFS_BYTES,
      "golden rootfs bytes must not change",
    );
    assertEquals(await Deno.readFile(golden.kernelSourcePath), KERNEL_BYTES);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("staging refuses to overwrite an occupied jail", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const golden = await makeGolden(dir);
    const jailRoot = join(dir, "jail");
    await Deno.mkdir(jailRoot, { recursive: true });
    await Deno.writeTextFile(join(jailRoot, "rootfs.ext4"), "occupied");

    await assertRejects(
      () => stageArtifacts({ ...golden, jailRoot, overlaySizeBytes: 8 * MIB }),
      StagingError,
      "already exists",
    );
    // Failed staging rolls its partial copies back.
    await assertRejects(
      () => Deno.stat(join(jailRoot, "vmlinux")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("staging bounds the overlay budget and file names", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const golden = await makeGolden(dir);
    const jailRoot = join(dir, "jail");
    await assertRejects(
      () => stageArtifacts({ ...golden, jailRoot, overlaySizeBytes: 4096 }),
      TypeError,
      "overlaySizeBytes",
    );
    await assertRejects(
      () =>
        stageArtifacts({
          ...golden,
          jailRoot,
          overlaySizeBytes: 8 * MIB + 0.5,
        }),
      TypeError,
      "overlaySizeBytes",
    );
    await assertRejects(
      () =>
        stageArtifacts({
          ...golden,
          jailRoot,
          overlaySizeBytes: 8 * MIB,
          kernelFileName: "../vmlinux",
        }),
      TypeError,
      "file name",
    );
    await assertRejects(
      () =>
        stageArtifacts({
          ...golden,
          jailRoot,
          overlaySizeBytes: 8 * MIB,
          kernelFileName: "same",
          rootfsFileName: "same",
        }),
      StagingError,
      "distinct",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
