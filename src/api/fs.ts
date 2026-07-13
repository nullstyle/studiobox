/** Options for {@link SandboxFs.readFile} / {@link SandboxFs.readTextFile}. */
export interface ReadFileOptions {
  /** Abort signal that cancels the read. */
  signal?: AbortSignal;
}

/** Options for {@link SandboxFs.writeFile} / {@link SandboxFs.writeTextFile}. */
export interface WriteFileOptions {
  /** Append to the file instead of truncating it. */
  append?: boolean;
  /** Create the file if it does not exist (default `true`). */
  create?: boolean;
  /** Fail if the file already exists. */
  createNew?: boolean;
  /** Permission mode for a newly created file. */
  mode?: number;
  /** Abort signal that cancels the write. */
  signal?: AbortSignal;
}

/** Options for {@link SandboxFs.mkdir}. */
export interface MkdirOptions {
  /** Create parent directories as needed. */
  recursive?: boolean;
  /** Permission mode for created directories. */
  mode?: number;
}

/** Options for {@link SandboxFs.remove}. */
export interface RemoveOptions {
  /** Remove directories and their contents recursively. */
  recursive?: boolean;
}

/** Options for {@link SandboxFs.open}, mirroring Deno's `OpenOptions`. */
export interface OpenOptions {
  /** Open for reading. */
  read?: boolean;
  /** Open for writing. */
  write?: boolean;
  /** Open in append mode. */
  append?: boolean;
  /** Truncate the file to zero length on open. */
  truncate?: boolean;
  /** Create the file if it does not exist. */
  create?: boolean;
  /** Fail if the file already exists. */
  createNew?: boolean;
  /** Permission mode for a newly created file. */
  mode?: number;
}

/** A single directory entry yielded by {@link SandboxFs.readDir}. */
export interface DirEntry {
  /** Entry name (basename, not a full path). */
  name: string;
  /** True when the entry is a regular file. */
  isFile: boolean;
  /** True when the entry is a directory. */
  isDirectory: boolean;
  /** True when the entry is a symbolic link. */
  isSymlink: boolean;
}

/** A {@link DirEntry} plus its path, yielded by walk/glob traversals. */
export interface WalkEntry extends DirEntry {
  /** Full path to the entry. */
  path: string;
}

/** Options for {@link SandboxFs.walk}, mirroring std `walk`. */
export interface WalkOptions {
  /** Maximum directory depth to descend. */
  maxDepth?: number;
  /** Include regular files (default `true`). */
  includeFiles?: boolean;
  /** Include directories (default `true`). */
  includeDirs?: boolean;
  /** Include symlinks (default `true`). */
  includeSymlinks?: boolean;
  /** Follow symlinks while descending. */
  followSymlinks?: boolean;
  /** Resolve entries to their canonical (real) path. */
  canonicalize?: boolean;
  /** Only include files with one of these extensions. */
  exts?: string[];
  /** Only include paths matching one of these patterns. */
  match?: RegExp[];
  /** Skip paths matching one of these patterns. */
  skip?: RegExp[];
}

/** Options for {@link SandboxFs.expandGlob}, mirroring std `expandGlob`. */
export interface ExpandGlobOptions {
  /** Enable extended glob syntax. */
  extended?: boolean;
  /** Enable `**` globstar matching (default `true`). */
  globstar?: boolean;
  /** Match case-insensitively. */
  caseInsensitive?: boolean;
  /** Base directory the glob is resolved against. */
  root?: string;
  /** Glob patterns to exclude from the results. */
  exclude?: string[];
  /** Include directories in the results (default `true`). */
  includeDirs?: boolean;
  /** Follow symlinks while expanding. */
  followSymlinks?: boolean;
  /** Resolve entries to their canonical (real) path. */
  canonicalize?: boolean;
}

/** Metadata about a filesystem path, mirroring Deno's `FileInfo`. */
export interface FileInfo {
  /** True for a regular file. */
  isFile: boolean;
  /** True for a directory. */
  isDirectory: boolean;
  /** True for a symbolic link. */
  isSymlink: boolean;
  /** Size in bytes. */
  size: number;
  /** Last modification time. */
  mtime: Date;
  /** Last access time. */
  atime: Date;
  /** Creation (birth) time. */
  birthtime: Date;
  /** Last status-change time. */
  ctime: Date;
  /** ID of the device containing the file. */
  dev: number;
  /** Inode number. */
  ino: number;
  /** Permission and type bits. */
  mode: number;
  /** Number of hard links. */
  nlink: number;
  /** Owner user id. */
  uid: number;
  /** Owner group id. */
  gid: number;
  /** Device id (if the file is a device). */
  rdev: number;
  /** Preferred I/O block size. */
  blksize: number;
  /** Number of 512-byte blocks allocated. */
  blocks: number;
  /** True for a block device. */
  isBlockDevice: boolean;
  /** True for a character device. */
  isCharDevice: boolean;
  /** True for a FIFO/pipe. */
  isFifo: boolean;
  /** True for a socket. */
  isSocket: boolean;
}

/** Reference point for {@link FsFile.seek}, mirroring Deno's `SeekMode`. */
export enum SeekMode {
  /** Seek relative to the start of the file. */
  Start = 0,
  /** Seek relative to the current position. */
  Current = 1,
  /** Seek relative to the end of the file. */
  End = 2,
}

/** A runtime-neutral file capability returned by {@link SandboxFs.open}. */
export abstract class FsFile implements AsyncDisposable {
  /** Readable stream over the file's remaining bytes. */
  abstract get readable(): ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Writable stream into the file. */
  abstract get writable(): WritableStream<Uint8Array<ArrayBuffer>>;
  /** Write `data` at the current position; returns the byte count written. */
  abstract write(data: Uint8Array<ArrayBuffer>): Promise<number>;
  /** Truncate the file to `length` bytes (default 0). */
  abstract truncate(length?: number): Promise<void>;
  /** Read into `data`; returns bytes read, or `null` at end of file. */
  abstract read(data: Uint8Array<ArrayBufferLike>): Promise<number | null>;
  /** Move the file cursor to `offset` relative to `whence`; returns the new position. */
  abstract seek(offset: number | bigint, whence: SeekMode): Promise<number>;
  /** Return {@link FileInfo} for the open file. */
  abstract stat(): Promise<FileInfo>;
  /** Flush all buffered data and metadata to disk. */
  abstract sync(): Promise<void>;
  /** Flush buffered data (not metadata) to disk. */
  abstract syncData(): Promise<void>;
  /** Set the file's access and modification times. */
  abstract utime(atime: number | Date, mtime: number | Date): Promise<void>;
  /** Acquire an advisory lock (exclusive by default). */
  abstract lock(exclusive?: boolean): Promise<void>;
  /** Release a previously acquired advisory lock. */
  abstract unlock(): Promise<void>;
  /** Close the file handle. */
  abstract close(): Promise<void>;
  /** Dispose semantics: close the file. */
  abstract [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The `sandbox.fs` surface (Tier A) — the full Deno-mirroring filesystem API,
 * plus the studiobox-side {@link upload}/{@link download} host transfers.
 */
export interface SandboxFs {
  /** Read the whole file as bytes. */
  readFile(
    path: string | URL,
    options?: ReadFileOptions,
  ): Promise<Uint8Array<ArrayBuffer>>;
  /** Write bytes (or a byte stream) to `path`. */
  writeFile(
    path: string | URL,
    data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<void>;
  /** Read the whole file as UTF-8 text. */
  readTextFile(path: string | URL, options?: ReadFileOptions): Promise<string>;
  /** Write text (or a text stream) to `path`. */
  writeTextFile(
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void>;
  /** Async-iterate the entries of a directory. */
  readDir(path: string | URL): AsyncIterable<DirEntry>;
  /** Remove a file or directory. */
  remove(path: string | URL, options?: RemoveOptions): Promise<void>;
  /** Create a directory. */
  mkdir(path: string | URL, options?: MkdirOptions): Promise<void>;
  /** Rename (move) `oldPath` to `newPath`. */
  rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  /** Return {@link FileInfo} for `path` (follows symlinks). */
  stat(path: string | URL): Promise<FileInfo>;
  /** Change the permission mode of `path`. */
  chmod(path: string | URL, mode: number): Promise<void>;
  /** Change the owner uid/gid of `path` (`null` leaves that field unchanged). */
  chown(
    path: string | URL,
    uid: number | null,
    gid: number | null,
  ): Promise<void>;
  /** Copy a file from `fromPath` to `toPath`. */
  copyFile(fromPath: string | URL, toPath: string | URL): Promise<void>;
  /** Recursively walk a directory tree, yielding {@link WalkEntry} items. */
  walk(path: string, options?: WalkOptions): AsyncIterableIterator<WalkEntry>;
  /** Expand a glob pattern, yielding matching {@link WalkEntry} items. */
  expandGlob(
    glob: string,
    options?: ExpandGlobOptions,
  ): AsyncIterableIterator<WalkEntry>;
  /** Create (or truncate) a file and return an open {@link FsFile}. */
  create(path: string | URL): Promise<FsFile>;
  /** Create a hard link at `path` pointing to `target`. */
  link(target: string | URL, path: string | URL): Promise<void>;
  /** Return {@link FileInfo} for `path` without following symlinks. */
  lstat(path: string | URL): Promise<FileInfo>;
  /** Create a temporary directory and return its path. */
  makeTempDir(options?: TempOptions): Promise<string>;
  /** Create a temporary file and return its path. */
  makeTempFile(options?: TempOptions): Promise<string>;
  /** Open `path` and return an {@link FsFile}. */
  open(path: string | URL, options?: OpenOptions): Promise<FsFile>;
  /** Read the target of a symbolic link. */
  readLink(path: string | URL): Promise<string>;
  /** Resolve `path` to its canonical absolute path. */
  realPath(path: string | URL): Promise<string>;
  /** Create a symbolic link at `path` pointing to `target`. */
  symlink(
    target: string | URL,
    path: string | URL,
    options?: { type?: "file" | "dir" | "junction" },
  ): Promise<void>;
  /** Truncate the file at `name` to `length` bytes (default 0). */
  truncate(name: string | URL, length?: number): Promise<void>;
  /** Get or set the process umask; returns the previous value. */
  umask(mask?: number): Promise<number>;
  /** Set the access and modification times of `path`. */
  utime(
    path: string | URL,
    atime: number | Date,
    mtime: number | Date,
  ): Promise<void>;
  /** Upload a host path into the sandbox (studiobox host transfer). */
  upload(localPath: string | URL, sandboxPath: string | URL): Promise<void>;
  /** Download a sandbox path to the host (studiobox host transfer). */
  download(sandboxPath: string | URL, localPath: string | URL): Promise<void>;
}

/** Options for {@linkcode SandboxFs.makeTempDir} / {@linkcode SandboxFs.makeTempFile}. */
export interface TempOptions {
  /** Parent directory to create the temp entry in (default: the sandbox's temp dir). */
  dir?: string;
  /** Prefix for the generated name. */
  prefix?: string;
  /** Suffix for the generated name. */
  suffix?: string;
}
