/**
 * Pinned guest kernel fetch + verification (PLAN.md M4 item 1).
 *
 * The pinned Firecracker-CI `vmlinux` per arch lives in `images/pins.json`;
 * this module verifies on-disk kernels against those sha256 pins and can
 * fetch a missing/stale kernel. The network is only touched through the
 * injected `fetchBytes` hook's default, and nothing in `tests/unit/` uses
 * that default: real downloads happen via `tools/images_fetch_kernel.ts`
 * (explicit task) or the `SBX_QUALIFY=1` qualification test.
 */

import { dirname } from "@std/path";
import type { ArtifactArch, ImagePins } from "./pins.ts";
import { sha256Hex, sha256HexOfFile } from "./validate.ts";

/** Thrown when an on-disk or fetched kernel fails its sha256 pin check. */
export class KernelVerificationError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "SBX_KERNEL_VERIFY";

  /** Construct with a human-readable description of the mismatch. */
  constructor(message: string) {
    super(message);
    this.name = "KernelVerificationError";
  }
}

/**
 * Digest the file at `path` and fail closed unless it matches the pin.
 * Returns the (matching) digest.
 */
export async function verifyKernelFile(
  path: string,
  expectedSha256: string,
): Promise<string> {
  const actual = await sha256HexOfFile(path);
  if (actual !== expectedSha256) {
    throw new KernelVerificationError(
      `kernel at ${path} has sha256 ${actual}, expected ${expectedSha256}`,
    );
  }
  return actual;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export interface EnsureKernelOptions {
  pins: ImagePins;
  arch: ArtifactArch;
  /** Where the verified kernel must end up. */
  destPath: string;
  /**
   * Byte source for the pinned URL. Defaults to a real network fetch;
   * unit tests always inject fixture bytes instead.
   */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export interface EnsureKernelResult {
  path: string;
  sha256: string;
  /** False when the on-disk kernel already matched the pin. */
  fetched: boolean;
}

/**
 * Idempotently make `destPath` hold the pinned kernel for `arch`.
 *
 * Existing matching bytes are kept untouched. Fetched bytes are verified
 * against the pin *before* they are moved into place (temp file + atomic
 * rename), so a corrupt download can never land at the destination.
 */
export async function ensureKernel(
  options: EnsureKernelOptions,
): Promise<EnsureKernelResult> {
  const pin = options.pins.kernel.perArch[options.arch];
  if (pin === undefined) {
    throw new KernelVerificationError(
      `no kernel pin for arch ${options.arch}`,
    );
  }
  try {
    const existing = await sha256HexOfFile(options.destPath);
    if (existing === pin.sha256) {
      return { path: options.destPath, sha256: existing, fetched: false };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const bytes = await fetchBytes(pin.url);
  const actual = await sha256Hex(bytes);
  if (actual !== pin.sha256) {
    throw new KernelVerificationError(
      `fetched kernel from ${pin.url} has sha256 ${actual}, expected ${pin.sha256}`,
    );
  }
  await Deno.mkdir(dirname(options.destPath), { recursive: true });
  const tempPath = `${options.destPath}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeFile(tempPath, bytes, { mode: 0o644 });
    await Deno.rename(tempPath, options.destPath);
  } catch (error) {
    await Deno.remove(tempPath).catch(() => {});
    throw error;
  }
  return { path: options.destPath, sha256: actual, fetched: true };
}
