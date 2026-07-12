/**
 * {@linkcode AgentFileSystem} over the host `Deno.*` filesystem, rooted at
 * a configurable sandbox root (Track B of the M3 agent plane — see
 * `./api.ts` for the contract, including the normative sandbox-root
 * confinement rules this module implements).
 *
 * Every path is an in-sandbox path: relative paths resolve against the
 * configured cwd (default `/home/app`), `..` clamps at the sandbox root,
 * and the resulting host path is verified post-symlink-resolution to lie
 * within the root — an escape throws {@linkcode AgentError}
 * `SBX_AGENT_PATH_ESCAPE`. Upstream has no such concept (the microVM
 * boundary is the real jail); the confinement here is a correctness
 * contract for the fake host, and is kept strict anyway.
 *
 * Implementation caveats (documented divergences, none observable through
 * upstream-shaped usage):
 *
 * - **`umask` is process-global.** `Deno.umask` mutates the whole host
 *   process, so in the fake host a sandbox's `umask()` bleeds across
 *   co-resident sandboxes and the test runner itself. In the real guest
 *   the agent process IS the sandbox, so the global is correct there.
 * - **`chown` surfaces the real OS error.** Unprivileged hosts cannot
 *   change ownership; callers get the untouched `Deno.errors.*` failure
 *   (tests exercise the `uid`/`gid` `null` no-op path).
 * - **Stream/handle lifetime.** Unlike `Deno.FsFile`, neither draining
 *   {@linkcode AgentFsFile.readable} nor closing
 *   {@linkcode AgentFsFile.writable} closes the handle — the contract
 *   makes `close()` the only closer (and idempotent), because the wire
 *   adapter multiplexes many streams over one `RemoteFile`.
 * - **Absolute symlink targets are host-meaningless in the fake.** They
 *   are stored verbatim (upstream behavior); when followed they resolve
 *   against the HOST root, which lands outside the sandbox root and
 *   throws `SBX_AGENT_PATH_ESCAPE`. In the real guest (`root: "/"`) the
 *   same verbatim target resolves correctly.
 *
 * @module
 */

import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "@std/path";
import {
  join as posixJoin,
  normalize as posixNormalize,
} from "@std/path/posix";
import { walk as stdWalk } from "@std/fs/walk";
import { expandGlob as stdExpandGlob } from "@std/fs/expand-glob";

import { AgentError } from "./api.ts";
import type {
  AgentFileSystem,
  AgentFsFile,
  AgentMakeTempOptions,
  AgentRootConfig,
  AgentSymlinkOptions,
  DirEntry,
  ExpandGlobOptions,
  FileInfo,
  MkdirOptions,
  OpenOptions,
  ReadFileOptions,
  RemoveOptions,
  SeekMode,
  WalkEntry,
  WalkOptions,
  WriteFileOptions,
} from "./api.ts";

/** Upstream `FsFile.readable` pull-chunk size (64 KiB). */
const READABLE_CHUNK_SIZE = 64 * 1024;

/** In-sandbox default parent for `makeTempDir`/`makeTempFile`. */
const SANDBOX_TEMP_ROOT = "/tmp";

/** Symlink-resolution depth bound (mirrors the kernel's ELOOP guard). */
const MAX_SYMLINK_DEPTH = 32;

/** Upstream guest home (user `sandbox`, uid 1000). */
const DEFAULT_HOME = "/home/app";

/**
 * Coerce a `Deno.FileInfo` (nullable fields on some platforms) into the
 * contract's non-null {@linkcode FileInfo} shape.
 */
function toFileInfo(info: Deno.FileInfo): FileInfo {
  return {
    isFile: info.isFile,
    isDirectory: info.isDirectory,
    isSymlink: info.isSymlink,
    size: info.size,
    mtime: info.mtime ?? new Date(0),
    atime: info.atime ?? new Date(0),
    birthtime: info.birthtime ?? new Date(0),
    ctime: info.ctime ?? new Date(0),
    dev: info.dev,
    ino: info.ino ?? 0,
    mode: info.mode ?? 0,
    nlink: info.nlink ?? 0,
    uid: info.uid ?? 0,
    gid: info.gid ?? 0,
    rdev: info.rdev ?? 0,
    blksize: info.blksize ?? 0,
    blocks: info.blocks ?? 0,
    isBlockDevice: info.isBlockDevice ?? false,
    isCharDevice: info.isCharDevice ?? false,
    isFifo: info.isFifo ?? false,
    isSocket: info.isSocket ?? false,
  };
}

/**
 * {@linkcode AgentFsFile} over a `Deno.FsFile`. `close()` is idempotent;
 * every other member throws {@linkcode AgentError} `SBX_AGENT_CLOSED`
 * once closed. `readable` pulls 64 KiB chunks and ends (without closing
 * the handle) at EOF; closing `writable` likewise leaves the handle open.
 */
class AgentFsFileImpl implements AgentFsFile {
  #file: Deno.FsFile;
  #closed = false;
  #readable: ReadableStream<Uint8Array<ArrayBuffer>> | undefined;
  #writable: WritableStream<Uint8Array<ArrayBuffer>> | undefined;

  constructor(file: Deno.FsFile) {
    this.#file = file;
  }

  #guard(): Deno.FsFile {
    if (this.#closed) {
      throw new AgentError(
        "SBX_AGENT_CLOSED",
        "file handle was used after close()",
      );
    }
    return this.#file;
  }

  get readable(): ReadableStream<Uint8Array<ArrayBuffer>> {
    this.#readable ??= new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        const buffer = new Uint8Array(READABLE_CHUNK_SIZE);
        const read = await this.#guard().read(buffer);
        if (read === null) {
          controller.close();
        } else {
          controller.enqueue(buffer.subarray(0, read));
        }
      },
    });
    return this.#readable;
  }

  get writable(): WritableStream<Uint8Array<ArrayBuffer>> {
    this.#writable ??= new WritableStream<Uint8Array<ArrayBuffer>>({
      write: async (chunk) => {
        let written = 0;
        while (written < chunk.byteLength) {
          written += await this.#guard().write(chunk.subarray(written));
        }
      },
    });
    return this.#writable;
  }

  async read(data: Uint8Array<ArrayBufferLike>): Promise<number | null> {
    return await this.#guard().read(data);
  }

  async write(data: Uint8Array<ArrayBuffer>): Promise<number> {
    return await this.#guard().write(data);
  }

  async seek(offset: number | bigint, whence: SeekMode): Promise<number> {
    // The contract's SeekMode enum is value-identical to Deno.SeekMode.
    return await this.#guard().seek(offset, whence as number as Deno.SeekMode);
  }

  async truncate(length?: number): Promise<void> {
    await this.#guard().truncate(length);
  }

  async stat(): Promise<FileInfo> {
    return toFileInfo(await this.#guard().stat());
  }

  async sync(): Promise<void> {
    await this.#guard().sync();
  }

  async syncData(): Promise<void> {
    await this.#guard().syncData();
  }

  async utime(atime: number | Date, mtime: number | Date): Promise<void> {
    await this.#guard().utime(atime, mtime);
  }

  async lock(exclusive?: boolean): Promise<void> {
    await this.#guard().lock(exclusive);
  }

  async unlock(): Promise<void> {
    await this.#guard().unlock();
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#file.close();
    }
    return Promise.resolve();
  }
}

/**
 * The Track B {@linkcode AgentFileSystem}: host `Deno.*` calls confined
 * to {@linkcode AgentRootConfig.root} per the `./api.ts` module contract.
 * OS failures surface as untouched `Deno.errors.*`; {@linkcode AgentError}
 * is reserved for agent-plane failures (escape, closed handle, bad
 * config).
 */
export class AgentFs implements AgentFileSystem {
  /** Absolute host root (lexical, as configured). */
  #root: string;
  /** In-sandbox home ($HOME). */
  #home: string;
  /** In-sandbox cwd for relative-path resolution. */
  #cwd: string;
  /** Memoized `realpath(root)` — containment checks compare against it. */
  #realRoot: string | undefined;

  constructor(config: AgentRootConfig) {
    if (!isAbsolute(config.root)) {
      throw new AgentError(
        "SBX_AGENT_VALIDATION",
        `sandbox root must be an absolute host path, got ${
          JSON.stringify(config.root)
        }`,
      );
    }
    this.#root = resolve(config.root);
    const home = config.home ?? DEFAULT_HOME;
    const cwd = config.cwd ?? home;
    for (const [name, value] of [["home", home], ["cwd", cwd]] as const) {
      if (!value.startsWith("/")) {
        throw new AgentError(
          "SBX_AGENT_VALIDATION",
          `${name} must be an absolute in-sandbox path, got ${
            JSON.stringify(value)
          }`,
        );
      }
    }
    this.#home = posixNormalize(home);
    this.#cwd = posixNormalize(cwd);
  }

  /** Effective in-sandbox home directory. */
  get home(): string {
    return this.#home;
  }

  /** Effective in-sandbox working directory (relative-path base). */
  get cwd(): string {
    return this.#cwd;
  }

  // -------------------------------------------------------------------
  // Confinement (rules 1-5 of the api.ts module contract)
  // -------------------------------------------------------------------

  /** Rules 1+2: cwd-resolve, lexically normalize, clamp `..` at `/`. */
  #toSandboxPath(path: string): string {
    const absolute = path.startsWith("/") ? path : posixJoin(this.#cwd, path);
    const normalized = posixNormalize(absolute);
    return normalized === "" ? "/" : normalized;
  }

  /** Rule 3: map a normalized in-sandbox path under the host root. */
  #toHostPath(sandboxPath: string): string {
    return sandboxPath === "/"
      ? this.#root
      : join(this.#root, sandboxPath.slice(1));
  }

  async #realRootPath(): Promise<string> {
    this.#realRoot ??= await Deno.realPath(this.#root);
    return this.#realRoot;
  }

  #contained(resolvedHostPath: string, realRoot: string): boolean {
    // When the sandbox root IS the filesystem root ("/"), the containment
    // prefix is "/" (every absolute path is inside it) — NOT "//", which
    // would reject everything. This is the chroot/pivot_root case where
    // studioboxd runs rooted at the writable overlay (DESIGN.md §7/§10).
    if (realRoot === "/") return resolvedHostPath.startsWith("/");
    return resolvedHostPath === realRoot ||
      resolvedHostPath.startsWith(realRoot + "/");
  }

  /**
   * Resolve a host path as the OS would follow it: `realpath` when it
   * fully exists; otherwise resolve dangling symlinks manually (an
   * `open(..., { create: true })` through a dangling link creates the
   * link's TARGET, so the target is what containment must judge) and
   * fall back to `realpath(deepest existing ancestor) + suffix`.
   *
   * `symlinkDepth` counts only symlink redirections (`readLink` hops),
   * mirroring the OS `ELOOP` budget. The deepest-existing-ancestor walk
   * (`parent` recursion) is bounded by path length, not by the symlink
   * budget, so it does NOT consume `symlinkDepth` — otherwise a path with
   * more than `MAX_SYMLINK_DEPTH` plain directory components would falsely
   * throw `FilesystemLoop`.
   */
  async #resolveDeep(hostPath: string, symlinkDepth: number): Promise<string> {
    if (symlinkDepth > MAX_SYMLINK_DEPTH) {
      throw new Deno.errors.FilesystemLoop(
        `too many levels of symbolic links resolving ${hostPath}`,
      );
    }
    try {
      return await Deno.realPath(hostPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    // The path does not fully exist. A dangling symlink at this node
    // still redirects creation to its target - chase it by hand.
    let linkTarget: string | null = null;
    try {
      const info = await Deno.lstat(hostPath);
      if (info.isSymlink) linkTarget = await Deno.readLink(hostPath);
    } catch {
      // The node itself does not exist; fall through to the ancestor walk.
    }
    if (linkTarget !== null) {
      const target = isAbsolute(linkTarget)
        ? normalize(linkTarget)
        : join(dirname(hostPath), linkTarget);
      // A symlink redirect consumes the ELOOP budget.
      return await this.#resolveDeep(target, symlinkDepth + 1);
    }
    const parent = dirname(hostPath);
    if (parent === hostPath) return hostPath;
    // Descending to the parent is a directory-tree walk, not a symlink
    // hop: carry the same symlink budget rather than incrementing it.
    return join(
      await this.#resolveDeep(parent, symlinkDepth),
      basename(hostPath),
    );
  }

  /**
   * Rules 1-4 in one step: resolve an in-sandbox path to the host path
   * to touch, verifying post-symlink containment. `follow` selects
   * whether the FINAL component's symlink is chased (stat/readFile/open
   * follow it; lstat/remove/rename/readLink/symlink operate on the link
   * itself, so only their parent directory is verified).
   */
  async #resolveHost(path: string, follow: boolean): Promise<string> {
    const sandboxPath = this.#toSandboxPath(path);
    const hostPath = this.#toHostPath(sandboxPath);
    const realRoot = await this.#realRootPath();
    const probe = follow || sandboxPath === "/" ? hostPath : dirname(hostPath);
    const resolved = await this.#resolveDeep(probe, 0);
    if (!this.#contained(resolved, realRoot)) {
      throw new AgentError(
        "SBX_AGENT_PATH_ESCAPE",
        `path resolves outside the sandbox root: ${sandboxPath}`,
      );
    }
    return hostPath;
  }

  /** Rule 5: map a resolved host path back to an in-sandbox path. */
  #hostToSandbox(resolvedHostPath: string, realRoot: string): string {
    if (resolvedHostPath === realRoot) return "/";
    // Root "/" is the identity map: the in-sandbox path IS the host path
    // (slicing realRoot.length=1 would wrongly drop the leading "/").
    if (realRoot === "/") return resolvedHostPath;
    if (resolvedHostPath.startsWith(realRoot + "/")) {
      return resolvedHostPath.slice(realRoot.length);
    }
    throw new AgentError(
      "SBX_AGENT_PATH_ESCAPE",
      `path resolves outside the sandbox root: ${resolvedHostPath}`,
    );
  }

  // -------------------------------------------------------------------
  // AgentFileSystem surface
  // -------------------------------------------------------------------

  async readFile(
    path: string,
    options?: ReadFileOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return await Deno.readFile(await this.#resolveHost(path, true), options);
  }

  async writeFile(
    path: string,
    data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<void> {
    await Deno.writeFile(await this.#resolveHost(path, true), data, options);
  }

  async readTextFile(
    path: string,
    options?: ReadFileOptions,
  ): Promise<string> {
    return await Deno.readTextFile(
      await this.#resolveHost(path, true),
      options,
    );
  }

  async writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void> {
    await Deno.writeTextFile(
      await this.#resolveHost(path, true),
      data,
      options,
    );
  }

  async *readDir(path: string): AsyncIterableIterator<DirEntry> {
    const host = await this.#resolveHost(path, true);
    for await (const entry of Deno.readDir(host)) {
      yield {
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
      };
    }
  }

  async remove(path: string, options?: RemoveOptions): Promise<void> {
    await Deno.remove(await this.#resolveHost(path, false), options);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await Deno.mkdir(await this.#resolveHost(path, false), options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await Deno.rename(
      await this.#resolveHost(oldPath, false),
      await this.#resolveHost(newPath, false),
    );
  }

  async stat(path: string): Promise<FileInfo> {
    return toFileInfo(await Deno.stat(await this.#resolveHost(path, true)));
  }

  async lstat(path: string): Promise<FileInfo> {
    return toFileInfo(await Deno.lstat(await this.#resolveHost(path, false)));
  }

  async chmod(path: string, mode: number): Promise<void> {
    await Deno.chmod(await this.#resolveHost(path, true), mode);
  }

  async chown(
    path: string,
    uid: number | null,
    gid: number | null,
  ): Promise<void> {
    await Deno.chown(await this.#resolveHost(path, true), uid, gid);
  }

  async copyFile(fromPath: string, toPath: string): Promise<void> {
    await Deno.copyFile(
      await this.#resolveHost(fromPath, true),
      await this.#resolveHost(toPath, true),
    );
  }

  async link(target: string, path: string): Promise<void> {
    await Deno.link(
      await this.#resolveHost(target, true),
      await this.#resolveHost(path, false),
    );
  }

  async symlink(
    target: string,
    path: string,
    options?: AgentSymlinkOptions,
  ): Promise<void> {
    // The target is stored VERBATIM (confinement rule 4: enforcement
    // happens at traversal, so dangling / out-of-root links may exist).
    await Deno.symlink(
      target,
      await this.#resolveHost(path, false),
      options?.type === undefined ? undefined : { type: options.type },
    );
  }

  async readLink(path: string): Promise<string> {
    return await Deno.readLink(await this.#resolveHost(path, false));
  }

  async realPath(path: string): Promise<string> {
    const host = await this.#resolveHost(path, true);
    const [resolved, realRoot] = [
      await Deno.realPath(host),
      await this.#realRootPath(),
    ];
    return this.#hostToSandbox(resolved, realRoot);
  }

  async truncate(path: string, length?: number): Promise<void> {
    await Deno.truncate(await this.#resolveHost(path, true), length);
  }

  umask(mask?: number): Promise<number> {
    // Process-global: see the module doc caveat.
    return Promise.resolve(Deno.umask(mask));
  }

  async utime(
    path: string,
    atime: number | Date,
    mtime: number | Date,
  ): Promise<void> {
    await Deno.utime(await this.#resolveHost(path, true), atime, mtime);
  }

  makeTempDir(options?: AgentMakeTempOptions): Promise<string> {
    return this.#makeTemp("dir", options);
  }

  makeTempFile(options?: AgentMakeTempOptions): Promise<string> {
    return this.#makeTemp("file", options);
  }

  async #makeTemp(
    kind: "dir" | "file",
    options?: AgentMakeTempOptions,
  ): Promise<string> {
    const sandboxDir = this.#toSandboxPath(options?.dir ?? SANDBOX_TEMP_ROOT);
    const hostDir = await this.#resolveHost(sandboxDir, true);
    if (options?.dir === undefined) {
      // The sandbox temp root is provisioned lazily; an explicit `dir`
      // mirrors Deno and fails with NotFound when missing.
      await Deno.mkdir(hostDir, { recursive: true });
    }
    const hostOptions = {
      dir: hostDir,
      prefix: options?.prefix,
      suffix: options?.suffix,
    };
    const created = kind === "dir"
      ? await Deno.makeTempDir(hostOptions)
      : await Deno.makeTempFile(hostOptions);
    return posixJoin(sandboxDir, basename(created));
  }

  async open(path: string, options?: OpenOptions): Promise<AgentFsFile> {
    const host = await this.#resolveHost(path, true);
    return new AgentFsFileImpl(await Deno.open(host, options));
  }

  async create(path: string): Promise<AgentFsFile> {
    const host = await this.#resolveHost(path, true);
    return new AgentFsFileImpl(await Deno.create(host));
  }

  async *walk(
    path: string,
    options?: WalkOptions,
  ): AsyncIterableIterator<WalkEntry> {
    const host = await this.#resolveHost(path, true);
    const realRoot = await this.#realRootPath();
    // Walk from the realpath so every yielded path (canonicalized or
    // not) shares the realRoot prefix and translates back cleanly.
    const walkRoot = await Deno.realPath(host);
    for await (const entry of stdWalk(walkRoot, options)) {
      yield await this.#toWalkEntry(entry, realRoot, options?.followSymlinks);
    }
  }

  async *expandGlob(
    glob: string,
    options?: ExpandGlobOptions,
  ): AsyncIterableIterator<WalkEntry> {
    let pattern = glob;
    let sandboxRoot: string;
    if (glob.startsWith("/")) {
      // An absolute glob is absolute IN-SANDBOX: re-root it so @std/fs
      // never interprets it against the host filesystem.
      sandboxRoot = "/";
      pattern = glob.replace(/^\/+/, "");
    } else {
      sandboxRoot = options?.root !== undefined
        ? this.#toSandboxPath(options.root)
        : this.#cwd;
    }
    const hostRoot = await this.#resolveHost(sandboxRoot, true);
    const realRoot = await this.#realRootPath();
    const walkRoot = await Deno.realPath(hostRoot);
    const { root: _root, ...rest } = options ?? {};
    for await (
      const entry of stdExpandGlob(pattern, {
        ...rest,
        root: walkRoot,
      })
    ) {
      yield await this.#toWalkEntry(entry, realRoot, options?.followSymlinks);
    }
  }

  /**
   * Translate an @std/fs entry to an in-sandbox {@linkcode WalkEntry},
   * enforcing confinement rule 4 for followed symlinks (a traversal that
   * escaped the root throws instead of yielding).
   */
  async #toWalkEntry(
    entry: WalkEntry,
    realRoot: string,
    followSymlinks: boolean | undefined,
  ): Promise<WalkEntry> {
    if (followSymlinks) {
      const resolved = await Deno.realPath(entry.path);
      if (!this.#contained(resolved, realRoot)) {
        throw new AgentError(
          "SBX_AGENT_PATH_ESCAPE",
          `traversal followed a symlink outside the sandbox root at ${
            JSON.stringify(entry.name)
          }`,
        );
      }
    }
    return {
      path: this.#hostToSandbox(entry.path, realRoot),
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
    };
  }
}
