/**
 * Backend-agnostic recursion behind {@linkcode SandboxFs.upload} and
 * {@linkcode SandboxFs.download}.
 *
 * Both directions are pure SDK-side composition over the primitive `fs.*`
 * surface every backend already carries — there is no dedicated upload/download
 * wire method. {@linkcode uploadTree} copies a HOST path INTO the sandbox,
 * reading the host with `Deno.*` and writing the guest through the
 * {@linkcode SandboxFs} it is handed; {@linkcode downloadTree} is the mirror,
 * reading the guest through `fs` and writing the host with `Deno.*`. The same
 * helper serves the in-process fake (`testing/mod.ts`) and the real wire-backed
 * facade (`src/sdk/sandbox.ts`).
 *
 * Semantics match `@deno/sandbox@0.13.2`:
 *
 * - A single **file** copies to the exact destination path (file → file); the
 *   destination's parent directory is assumed to exist, as upstream does.
 * - A **directory** is copied recursively into the destination under its own
 *   basename — `upload("src", "dst")` yields `dst/src/...` — computed with the
 *   same `join(dest, relative(dirname(root), entry))` path arithmetic upstream
 *   uses. Intermediate directories are created with a recursive `mkdir`, so
 *   empty directories round-trip and missing parents are filled in.
 * - **Symlinks** encountered inside a tree are recreated with their LITERAL
 *   target — read via `Deno.readLink` on upload and `fs.readLink` on download,
 *   copied verbatim and never followed or canonicalised, so relative AND
 *   absolute targets round-trip byte-for-byte (and a dangling link does not
 *   abort the transfer). The top-level path is still resolved first
 *   (`Deno.realPath` on upload, `fs.stat` on download), so a symlink AT the
 *   root dispatches on its target. NOTE: recreating a symlink needs a backend
 *   that wires `fs.symlink` / `fs.readLink` — the in-process fake does, but the
 *   real wire backend (`src/sdk/wire_agent.ts`) currently answers those with
 *   `ImplementationPendingError`, so a tree containing a symlink aborts there
 *   (typed not-yet) until those primitives land.
 *
 * The download recursion deliberately dispatches on `fs.stat` / `fs.readDir` /
 * `fs.open` (the wired core) rather than `fs.realPath` / `fs.lstat` / `fs.walk`,
 * so a plain file-or-directory download works on the real backend even while
 * those richer primitives remain typed not-yet.
 *
 * @module
 */

import { dirname, fromFileUrl, join, relative } from "@std/path";

import type { SandboxFs } from "./fs.ts";

/** Coerce a `string | URL` path to a string, resolving `file:` URLs. */
function toPathString(path: string | URL): string {
  return path instanceof URL ? fromFileUrl(path) : path;
}

/**
 * Copy a HOST file or directory tree INTO the sandbox.
 *
 * `localPath` is read from the host filesystem with `Deno.*`; `sandboxPath` is
 * written through `fs`. A file lands at `sandboxPath`; a directory is copied
 * recursively into `sandboxPath` under its own basename (upstream's
 * target-is-a-directory convention). See the {@link ./fs_transfer.ts module
 * doc} for the full contract.
 *
 * @param fs the {@linkcode SandboxFs} whose guest side receives the tree
 * @param localPath the host file or directory to upload
 * @param sandboxPath the in-sandbox destination
 */
export async function uploadTree(
  fs: SandboxFs,
  localPath: string | URL,
  sandboxPath: string | URL,
): Promise<void> {
  // realPath collapses any symlink in the source path so the top-level entry
  // dispatches on its real target and the basename used for the nested-copy
  // convention is the target's, exactly as upstream normalizes it.
  const root = await Deno.realPath(toPathString(localPath));
  const dest = toPathString(sandboxPath);
  const info = await Deno.lstat(root); // post-realPath: never a symlink
  if (info.isDirectory) {
    await uploadDirectory(fs, root, dirname(root), dest);
  } else {
    await uploadFile(fs, root, dest);
  }
}

/**
 * Recurse a host directory into the sandbox. `dirRoot` is fixed at
 * `dirname(uploadRoot)` so every node's guest path is
 * `join(dest, relative(dirRoot, hostEntry))` — the same arithmetic upstream's
 * `walk` drives, which nests the upload root's basename under `dest`.
 */
async function uploadDirectory(
  fs: SandboxFs,
  hostDir: string,
  dirRoot: string,
  dest: string,
): Promise<void> {
  await fs.mkdir(join(dest, relative(dirRoot, hostDir)), { recursive: true });
  for await (const entry of Deno.readDir(hostDir)) {
    const hostEntry = join(hostDir, entry.name);
    const target = join(dest, relative(dirRoot, hostEntry));
    if (entry.isSymlink) {
      await uploadSymlink(fs, hostEntry, target);
    } else if (entry.isDirectory) {
      await uploadDirectory(fs, hostEntry, dirRoot, dest);
    } else {
      await uploadFile(fs, hostEntry, target);
    }
  }
}

/** Stream one host file's bytes into the sandbox at `sandboxPath`. */
async function uploadFile(
  fs: SandboxFs,
  hostPath: string,
  sandboxPath: string,
): Promise<void> {
  const file = await Deno.open(hostPath, { read: true });
  try {
    await fs.writeFile(sandboxPath, file.readable);
  } catch (error) {
    // On success `writeFile` drains and closes the readable (and its fd); only
    // close explicitly when the write did NOT run to completion.
    try {
      file.close();
    } catch {
      // Already closed / not closeable — ignore.
    }
    throw error;
  }
}

/** Recreate a host symlink inside the sandbox, preserving its literal target. */
async function uploadSymlink(
  fs: SandboxFs,
  hostPath: string,
  sandboxPath: string,
): Promise<void> {
  // Copy the target VERBATIM (as `downloadSymlink` does with `fs.readLink`).
  // `Deno.readLink` reads the link's own bytes without following or
  // canonicalising it, so relative and absolute targets round-trip unchanged
  // and a dangling link no longer aborts the whole tree. (`Deno.realPath`
  // would follow the link — rewriting absolute targets into upward-traversing
  // relative ones, and throwing `NotFound` on a dangling link.)
  const target = await Deno.readLink(hostPath);
  await fs.symlink(target, sandboxPath);
}

/**
 * Copy a SANDBOX file or directory tree OUT to the host.
 *
 * `sandboxPath` is read through `fs`; `localPath` is written to the host
 * filesystem with `Deno.*`. A file lands at `localPath`; a directory is copied
 * recursively into `localPath` under its own basename. See the
 * {@link ./fs_transfer.ts module doc} for the full contract.
 *
 * @param fs the {@linkcode SandboxFs} whose guest side supplies the tree
 * @param sandboxPath the in-sandbox file or directory to download
 * @param localPath the host destination
 */
export async function downloadTree(
  fs: SandboxFs,
  sandboxPath: string | URL,
  localPath: string | URL,
): Promise<void> {
  const root = toPathString(sandboxPath);
  const dest = toPathString(localPath);
  // Dispatch on `stat` (follows the link at the root, as upstream's
  // realPath-then-lstat does) rather than `lstat`/`realPath`, which remain
  // typed not-yet on the real wire backend.
  const info = await fs.stat(root);
  if (info.isDirectory) {
    await downloadDirectory(fs, root, dirname(root), dest);
  } else {
    await downloadFile(fs, root, dest);
  }
}

/** Recurse a sandbox directory out to the host (mirror of uploadDirectory). */
async function downloadDirectory(
  fs: SandboxFs,
  sandboxDir: string,
  dirRoot: string,
  dest: string,
): Promise<void> {
  await Deno.mkdir(join(dest, relative(dirRoot, sandboxDir)), {
    recursive: true,
  });
  for await (const entry of fs.readDir(sandboxDir)) {
    const sandboxEntry = join(sandboxDir, entry.name);
    const target = join(dest, relative(dirRoot, sandboxEntry));
    if (entry.isSymlink) {
      await downloadSymlink(fs, sandboxEntry, target);
    } else if (entry.isDirectory) {
      await downloadDirectory(fs, sandboxEntry, dirRoot, dest);
    } else {
      await downloadFile(fs, sandboxEntry, target);
    }
  }
}

/** Stream one sandbox file's bytes out to the host at `hostPath`. */
async function downloadFile(
  fs: SandboxFs,
  sandboxPath: string,
  hostPath: string,
): Promise<void> {
  const file = await fs.open(sandboxPath, { read: true });
  try {
    await Deno.writeFile(hostPath, file.readable);
  } finally {
    // Unlike `uploadFile` — whose source is a native `Deno.FsFile` that closes
    // its fd when `.readable` reaches EOF — the guest `FsFile`'s `.readable`
    // ends WITHOUT closing the handle (`AgentFsFileImpl`/`WireAgentFsFile`
    // close only the stream controller). So close on EVERY path, success or
    // failure, or each downloaded file leaks a guest fd / `RemoteFile` cap.
    try {
      await file.close();
    } catch {
      // Already closed / not closeable — ignore.
    }
  }
}

/** Recreate a sandbox symlink on the host, preserving its stored target. */
async function downloadSymlink(
  fs: SandboxFs,
  sandboxPath: string,
  hostPath: string,
): Promise<void> {
  const target = await fs.readLink(sandboxPath);
  await Deno.symlink(target, hostPath);
}
