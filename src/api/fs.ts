export interface ReadFileOptions {
  signal?: AbortSignal;
}

export interface WriteFileOptions {
  append?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
  signal?: AbortSignal;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface OpenOptions {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  truncate?: boolean;
  create?: boolean;
  createNew?: boolean;
  mode?: number;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface WalkEntry extends DirEntry {
  path: string;
}

export interface WalkOptions {
  maxDepth?: number;
  includeFiles?: boolean;
  includeDirs?: boolean;
  includeSymlinks?: boolean;
  followSymlinks?: boolean;
  canonicalize?: boolean;
  exts?: string[];
  match?: RegExp[];
  skip?: RegExp[];
}

export interface ExpandGlobOptions {
  extended?: boolean;
  globstar?: boolean;
  caseInsensitive?: boolean;
  root?: string;
  exclude?: string[];
  includeDirs?: boolean;
  followSymlinks?: boolean;
  canonicalize?: boolean;
}

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date;
  atime: Date;
  birthtime: Date;
  ctime: Date;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  blocks: number;
  isBlockDevice: boolean;
  isCharDevice: boolean;
  isFifo: boolean;
  isSocket: boolean;
}

export enum SeekMode {
  Start = 0,
  Current = 1,
  End = 2,
}

/** A runtime-neutral file capability returned by {@link SandboxFs.open}. */
export abstract class FsFile implements AsyncDisposable {
  abstract get readable(): ReadableStream<Uint8Array<ArrayBuffer>>;
  abstract get writable(): WritableStream<Uint8Array<ArrayBuffer>>;
  abstract write(data: Uint8Array<ArrayBuffer>): Promise<number>;
  abstract truncate(length?: number): Promise<void>;
  abstract read(data: Uint8Array<ArrayBufferLike>): Promise<number | null>;
  abstract seek(offset: number | bigint, whence: SeekMode): Promise<number>;
  abstract stat(): Promise<FileInfo>;
  abstract sync(): Promise<void>;
  abstract syncData(): Promise<void>;
  abstract utime(atime: number | Date, mtime: number | Date): Promise<void>;
  abstract lock(exclusive?: boolean): Promise<void>;
  abstract unlock(): Promise<void>;
  abstract close(): Promise<void>;
  abstract [Symbol.asyncDispose](): Promise<void>;
}

export interface SandboxFs {
  readFile(
    path: string | URL,
    options?: ReadFileOptions,
  ): Promise<Uint8Array<ArrayBuffer>>;
  writeFile(
    path: string | URL,
    data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<void>;
  readTextFile(path: string | URL, options?: ReadFileOptions): Promise<string>;
  writeTextFile(
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void>;
  readDir(path: string | URL): AsyncIterable<DirEntry>;
  remove(path: string | URL, options?: RemoveOptions): Promise<void>;
  mkdir(path: string | URL, options?: MkdirOptions): Promise<void>;
  rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  stat(path: string | URL): Promise<FileInfo>;
  chmod(path: string | URL, mode: number): Promise<void>;
  chown(
    path: string | URL,
    uid: number | null,
    gid: number | null,
  ): Promise<void>;
  copyFile(fromPath: string | URL, toPath: string | URL): Promise<void>;
  walk(path: string, options?: WalkOptions): AsyncIterableIterator<WalkEntry>;
  expandGlob(
    glob: string,
    options?: ExpandGlobOptions,
  ): AsyncIterableIterator<WalkEntry>;
  create(path: string | URL): Promise<FsFile>;
  link(target: string | URL, path: string | URL): Promise<void>;
  lstat(path: string | URL): Promise<FileInfo>;
  makeTempDir(options?: TempOptions): Promise<string>;
  makeTempFile(options?: TempOptions): Promise<string>;
  open(path: string | URL, options?: OpenOptions): Promise<FsFile>;
  readLink(path: string | URL): Promise<string>;
  realPath(path: string | URL): Promise<string>;
  symlink(
    target: string | URL,
    path: string | URL,
    options?: { type?: "file" | "dir" | "junction" },
  ): Promise<void>;
  truncate(name: string | URL, length?: number): Promise<void>;
  umask(mask?: number): Promise<number>;
  utime(
    path: string | URL,
    atime: number | Date,
    mtime: number | Date,
  ): Promise<void>;
  upload(localPath: string | URL, sandboxPath: string | URL): Promise<void>;
  download(sandboxPath: string | URL, localPath: string | URL): Promise<void>;
}

interface TempOptions {
  dir?: string;
  prefix?: string;
  suffix?: string;
}
