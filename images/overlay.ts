/**
 * The host half of the per-boot overlay contract (DESIGN.md §7).
 *
 * Every sandbox boots the golden rootfs read-only (`root=/dev/vda ro`) with a
 * fresh writable overlay on `/dev/vdb`. The host creates that overlay as a
 * *sparse, unformatted* file — `mkfs` is not portable to the macOS host — and
 * the guest half of the contract, the `overlay-init` pid-1 stub in
 * `images/overlay_init/`, formats `/dev/vdb` as ext4 on first boot and mounts a
 * writable overlayfs over the read-only golden root.
 *
 * Both halves live in `images/` on purpose: they are one contract, and a change
 * to either is a change to the artifact identity (`overlay-init.sh`'s sha256 is
 * an input pin — see `manifest.ts`).
 *
 * @module
 */

import { assertUnsignedInteger } from "./validate.ts";

/** Floor of the overlay size window: smaller than this cannot hold a filesystem. */
export const OVERLAY_MIN_BYTES = 1024 * 1024;

/** Ceiling of the overlay size window. */
export const OVERLAY_MAX_BYTES = 1024 * 1024 * 1024 * 1024;

/**
 * Check an overlay budget against the size window, eagerly.
 *
 * {@linkcode createSparseOverlay} applies this itself; call it directly to
 * reject a bad deploy-time constant at construction rather than on the first
 * launch that tries to use it.
 *
 * @param value Candidate overlay size in bytes.
 * @param field Name to attribute the failure to.
 * @throws {TypeError} If `value` is not an integer within the size window.
 */
export function assertOverlaySizeBytes(
  value: unknown,
  field = "overlaySizeBytes",
): asserts value is number {
  assertUnsignedInteger(value, field, OVERLAY_MAX_BYTES, OVERLAY_MIN_BYTES);
}

/**
 * Create a fresh sparse, unformatted overlay file. The guest's `overlay-init`
 * formats it on first boot.
 *
 * `Deno.errors.AlreadyExists` propagates deliberately: callers disagree about
 * what a collision *means* — in the launch path it is an execution-id reuse bug
 * and must fail the launch, while in the template path it is a stale bake to be
 * discarded and retried — so the policy stays at the call site.
 *
 * @param path Destination file; must not already exist.
 * @param sizeBytes Overlay budget, within the overlay size window.
 * @throws {TypeError} If `sizeBytes` is outside the size window.
 * @throws {Deno.errors.AlreadyExists} If `path` already exists.
 */
export async function createSparseOverlay(
  path: string,
  sizeBytes: number,
): Promise<void> {
  assertOverlaySizeBytes(sizeBytes);
  const file = await Deno.open(path, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    await file.truncate(sizeBytes);
  } finally {
    file.close();
  }
}
