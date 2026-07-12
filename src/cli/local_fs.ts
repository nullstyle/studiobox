/**
 * The host filesystem seam the provisioner uses for local (macOS/Linux) writes
 * — the SDK token file and the throwaway temp files staged for `limactl cp`
 * (PLAN.md §M9).
 *
 * Injecting it keeps token minting off real disk in tests (a memory fake) while
 * the real {@linkcode DenoLocalFs} writes `~/.studiobox/token` at mode 0600.
 *
 * @module
 */

import { dirname } from "@std/path";

/** Local-host filesystem operations the provisioner needs. */
export interface LocalFs {
  /** Whether a host path exists. */
  exists(path: string): Promise<boolean>;
  /** Write a secret file (parent created; mode 0600). */
  writeSecretFile(path: string, contents: string): Promise<void>;
  /** Stage `contents` in a fresh temp file; returns its path. */
  makeTempFile(contents: string): Promise<string>;
  /** Remove a host path (best-effort; missing is not an error). */
  remove(path: string): Promise<void>;
}

/** Real filesystem backing, used outside tests. */
export class DenoLocalFs implements LocalFs {
  async exists(path: string): Promise<boolean> {
    try {
      await Deno.lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  async writeSecretFile(path: string, contents: string): Promise<void> {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, contents, { mode: 0o600 });
    // writeTextFile only sets mode on create; enforce it on an existing file.
    await Deno.chmod(path, 0o600).catch(() => {});
  }

  async makeTempFile(contents: string): Promise<string> {
    const path = await Deno.makeTempFile({ prefix: "studiobox-token-" });
    await Deno.writeTextFile(path, contents);
    return path;
  }

  async remove(path: string): Promise<void> {
    await Deno.remove(path).catch(() => {});
  }
}
