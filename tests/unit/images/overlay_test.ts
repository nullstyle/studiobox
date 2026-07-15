import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createSparseOverlay,
  OVERLAY_MAX_BYTES,
} from "../../../images/overlay.ts";

const MIB = 1024 * 1024;

Deno.test("the overlay is sized to the budget but allocates nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "overlay.ext4");
    await createSparseOverlay(path, 64 * MIB);

    const overlay = await Deno.stat(path);
    assertEquals(overlay.size, 64 * MIB, "overlay is sized to the budget");
    assertEquals(overlay.mode! & 0o777, 0o600);

    // The whole point: a 256 MiB-per-sandbox overlay that is actually written
    // out would burn real disk. Sparseness is the invariant, and size alone
    // cannot see the difference — only the allocated block count can.
    assert(overlay.blocks !== null);
    assert(
      overlay.blocks * 512 < MIB,
      `overlay must be sparse, found ${overlay.blocks} blocks allocated`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the overlay budget is bounded", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "overlay.ext4");
    // Below the floor: too small to hold a filesystem.
    await assertRejects(
      () => createSparseOverlay(path, 4096),
      TypeError,
      "overlaySizeBytes",
    );
    // Not an integer.
    await assertRejects(
      () => createSparseOverlay(path, 8 * MIB + 0.5),
      TypeError,
      "overlaySizeBytes",
    );
    // Above the ceiling.
    await assertRejects(
      () => createSparseOverlay(path, OVERLAY_MAX_BYTES + 1),
      TypeError,
      "overlaySizeBytes",
    );
    // A rejected budget creates nothing.
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a collision propagates so callers can apply their own policy", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "overlay.ext4");
    await createSparseOverlay(path, 8 * MIB);

    // The launch path turns this into SBX_SUP_STATE (execution-id reuse); the
    // template baker discards and retries. Neither works if it is swallowed.
    await assertRejects(
      () => createSparseOverlay(path, 8 * MIB),
      Deno.errors.AlreadyExists,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
