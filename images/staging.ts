/**
 * Copy-only staging of an artifact set into a jail-root layout
 * (PLAN.md M4 item 3, DESIGN.md §7).
 *
 * **Never hardlink.** Hardlink staging shares inodes, so an in-jail
 * chmod/chown would mutate the golden source — the exact regression the
 * design forbids (`stage: { mode: "copy" }` in firecracker-deno terms).
 * Every staged file is a full copy with its own inode (verified after the
 * copy, fail closed), plus a fresh *sparse* overlay file sized to the
 * sandbox's disk budget.
 *
 * The overlay is created as a sparse, unformatted file: mkfs is not
 * portable to the macOS host, so the in-guest `overlay-init` stub formats
 * `/dev/vdb` as ext4 on first boot (see `images/overlay_init/`).
 */

import { join } from "@std/path";
import { assertArtifactFileName } from "./manifest.ts";
import { assertUnsignedInteger } from "./validate.ts";

export const OVERLAY_MIN_BYTES = 1024 * 1024;
export const OVERLAY_MAX_BYTES = 1024 * 1024 * 1024 * 1024;

export class StagingError extends Error {
  readonly code = "SBX_STAGING";

  constructor(message: string) {
    super(message);
    this.name = "StagingError";
  }
}

export interface StageArtifactsOptions {
  /** Golden (cached) kernel file. */
  kernelSourcePath: string;
  /** Golden (cached) rootfs ext4 image. Never mutated. */
  rootfsSourcePath: string;
  /** Target jail-root directory; created if missing. */
  jailRoot: string;
  /** Sparse overlay size from the sandbox disk budget. */
  overlaySizeBytes: number;
  kernelFileName?: string;
  rootfsFileName?: string;
  overlayFileName?: string;
}

export interface StagedArtifacts {
  kernelPath: string;
  rootfsPath: string;
  overlayPath: string;
}

async function copyFresh(
  sourcePath: string,
  destPath: string,
  mode: number,
): Promise<void> {
  const source = await Deno.stat(sourcePath);
  if (!source.isFile) {
    throw new StagingError(`staging source ${sourcePath} is not a file`);
  }
  try {
    await Deno.lstat(destPath);
    throw new StagingError(
      `staging target ${destPath} already exists (jails must be fresh)`,
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.copyFile(sourcePath, destPath);
  await Deno.chmod(destPath, mode);
  const staged = await Deno.stat(destPath);
  if (staged.dev === source.dev && staged.ino === source.ino) {
    // A copy that shares the source inode is a hardlink in disguise; an
    // in-jail chmod would reach back into the golden artifact. Refuse.
    await Deno.remove(destPath).catch(() => {});
    throw new StagingError(
      `staging ${destPath} shares an inode with golden ${sourcePath}`,
    );
  }
}

/**
 * Stage a kernel + golden rootfs copy and a fresh sparse overlay into
 * `jailRoot`. Refuses to overwrite anything already present.
 */
export async function stageArtifacts(
  options: StageArtifactsOptions,
): Promise<StagedArtifacts> {
  assertUnsignedInteger(
    options.overlaySizeBytes,
    "overlaySizeBytes",
    OVERLAY_MAX_BYTES,
    OVERLAY_MIN_BYTES,
  );
  const kernelFileName = options.kernelFileName ?? "vmlinux";
  const rootfsFileName = options.rootfsFileName ?? "rootfs.ext4";
  const overlayFileName = options.overlayFileName ?? "overlay.ext4";
  for (
    const [name, field] of [
      [kernelFileName, "kernelFileName"],
      [rootfsFileName, "rootfsFileName"],
      [overlayFileName, "overlayFileName"],
    ] as const
  ) {
    assertArtifactFileName(name, field);
  }
  if (new Set([kernelFileName, rootfsFileName, overlayFileName]).size !== 3) {
    throw new StagingError("staged file names must be distinct");
  }

  await Deno.mkdir(options.jailRoot, { recursive: true });
  const staged: StagedArtifacts = {
    kernelPath: join(options.jailRoot, kernelFileName),
    rootfsPath: join(options.jailRoot, rootfsFileName),
    overlayPath: join(options.jailRoot, overlayFileName),
  };

  const created: string[] = [];
  try {
    await copyFresh(options.kernelSourcePath, staged.kernelPath, 0o644);
    created.push(staged.kernelPath);
    await copyFresh(options.rootfsSourcePath, staged.rootfsPath, 0o644);
    created.push(staged.rootfsPath);
    const overlay = await Deno.open(staged.overlayPath, {
      create: true,
      createNew: true,
      write: true,
      mode: 0o600,
    });
    created.push(staged.overlayPath);
    try {
      await overlay.truncate(options.overlaySizeBytes);
    } finally {
      overlay.close();
    }
  } catch (error) {
    for (const path of created) {
      await Deno.remove(path).catch(() => {});
    }
    throw error;
  }
  return staged;
}
