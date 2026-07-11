/**
 * Manifest-addressed artifact cache + refcount GC (PLAN.md M4 item 4).
 *
 * Layout: `<root>/<manifest-hash>/` holding `manifest.json`,
 * `refcount.json` and the artifact files (kernel, golden rootfs, agent
 * binary). The root defaults to `~/.studiobox/artifacts` and is always
 * overridable (tests never touch the real home directory).
 *
 * GC has two independent guards and both must clear before a set is
 * deleted: the local refcount must be zero **and** the journal must not
 * reference the manifest hash. The journal side is a narrow, read-only
 * dependency ({@link ArtifactReferenceReader}) rather than a hard import
 * of the state store, so hostd can hand in whatever SandboxRecord-derived
 * view it owns.
 *
 * Single-process, single-writer by design — the same stance as
 * `src/state/store.ts`; cross-process mutation goes through the daemon
 * that owns the cache. Within the process, every mutating operation
 * (`store`/`acquire`/`release`/`gc`) runs on a per-instance promise-chain
 * mutex (the `JsonFileSandboxStore#exclusive` pattern), so concurrent
 * refcount updates never lose writes and gc can never reap a set between
 * a concurrent acquire's read and its write.
 */

import { join } from "@std/path";
import {
  type ArtifactManifest,
  assertArtifactFileName,
  manifestHash,
  readArtifactManifest,
  writeArtifactManifest,
} from "./manifest.ts";
import {
  assertKeys,
  assertRecord,
  assertUnsignedInteger,
  isSha256Hex,
  sha256HexOfFile,
} from "./validate.ts";

export const MANIFEST_FILE_NAME = "manifest.json";
export const REFCOUNT_FILE_NAME = "refcount.json";

/** Conventional kernel file name inside an artifact set (see staging.ts). */
export const KERNEL_FILE_NAME = "vmlinux";
/** Conventional golden-rootfs file name inside an artifact set. */
export const ROOTFS_FILE_NAME = "rootfs.ext4";

/**
 * Root-level `.tmp-*` set directories older than this are treated as
 * abandoned (a crashed `store()`) and swept by {@link ArtifactCache.gc}.
 * The age gate keeps gc from racing an in-flight store in another
 * process.
 */
export const ABANDONED_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

const TEMP_DIR_PREFIX = ".tmp-";

export class ArtifactCacheError extends Error {
  readonly code = "SBX_ARTIFACT_CACHE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactCacheError";
  }
}

/**
 * Narrow read-only view of the sandbox journal: every manifest hash any
 * live SandboxRecord still references. Implemented by the journal owner;
 * the cache never imports the store.
 *
 * The reader is awaited while `gc()` holds the cache's internal mutex, so
 * an implementation must never call back into any method of the same
 * `ArtifactCache` instance — doing so self-deadlocks. Read the journal
 * (or any other source); do not touch the cache.
 */
export interface ArtifactReferenceReader {
  listReferencedManifestHashes(): Promise<string[]>;
}

interface RefcountFile {
  schemaVersion: 1;
  count: number;
}

function validateRefcountFile(value: unknown): RefcountFile {
  const parsed = assertRecord(value, "refcount file") as Partial<RefcountFile>;
  assertKeys(parsed, ["schemaVersion", "count"], "refcount file");
  if (parsed.schemaVersion !== 1) {
    throw new TypeError("unsupported refcount file schema version");
  }
  assertUnsignedInteger(
    parsed.count,
    "refcount count",
    Number.MAX_SAFE_INTEGER,
  );
  return { schemaVersion: 1, count: parsed.count };
}

/**
 * Write `text` to a brand-new file and fsync it before returning — the
 * same durability discipline as `JsonFileSandboxStore#write`. The caller
 * owns temp naming and the atomic rename.
 */
async function writeTextFileDurable(
  path: string,
  text: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { createNew: true, write: true });
    let offset = 0;
    while (offset < bytes.length) {
      offset += await file.write(bytes.subarray(offset));
    }
    await file.sync();
  } finally {
    file?.close();
  }
}

/** fsync an already-written file in place. */
async function syncFile(path: string): Promise<void> {
  const file = await Deno.open(path, { write: true });
  try {
    await file.sync();
  } finally {
    file.close();
  }
}

export interface ArtifactCacheOptions {
  /** Cache root; defaults to `~/.studiobox/artifacts`. */
  root?: string;
}

export interface StoreArtifactSetOptions {
  manifest: ArtifactManifest;
  /**
   * Artifact files to copy in, keyed by their in-set file name (e.g.
   * `{ vmlinux: "...", "rootfs.ext4": "...", studioboxd: "..." }`).
   */
  files: Record<string, string>;
}

export interface StoreArtifactSetResult {
  hash: string;
  dir: string;
  /** False when the set already existed (left untouched). */
  created: boolean;
}

export interface ArtifactGcResult {
  deleted: string[];
  kept: string[];
}

/**
 * Default cache root. Reads `HOME` lazily so permission-restricted
 * callers that always override `root` never need `--allow-env`.
 */
export function defaultArtifactCacheRoot(): string {
  const home = Deno.env.get("HOME");
  if (home === undefined || home === "") {
    throw new ArtifactCacheError(
      "cannot locate the default artifact cache root without HOME",
    );
  }
  return join(home, ".studiobox", "artifacts");
}

export class ArtifactCache {
  readonly root: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ArtifactCacheOptions = {}) {
    this.root = options.root ?? defaultArtifactCacheRoot();
  }

  setPath(hash: string): string {
    if (!isSha256Hex(hash)) {
      throw new ArtifactCacheError(
        "artifact set key must be a sha256 hex hash",
      );
    }
    return join(this.root, hash);
  }

  #refcountPath(hash: string): string {
    return join(this.setPath(hash), REFCOUNT_FILE_NAME);
  }

  /**
   * Serialize mutating operations per cache instance — the promise-chain
   * mutex from `JsonFileSandboxStore#exclusive`.
   */
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      const info = await Deno.stat(this.setPath(hash));
      return info.isDirectory;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  /** Hashes of every complete set in the cache (temp dirs excluded). */
  async list(): Promise<string[]> {
    const hashes: string[] = [];
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(this.root);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    try {
      for await (const entry of entries) {
        if (entry.isDirectory && isSha256Hex(entry.name)) {
          hashes.push(entry.name);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    return hashes.sort();
  }

  async readManifest(hash: string): Promise<ArtifactManifest> {
    return await readArtifactManifest(
      join(this.setPath(hash), MANIFEST_FILE_NAME),
    );
  }

  /**
   * The sha256 pins the manifest carries for in-set file names: the
   * kernel and agent binary always, the rootfs bytes only when
   * `identity.kind === "imageBytes"` (a content-manifest identity does
   * not pin the raw ext4 bytes).
   */
  #expectedFileHashes(manifest: ArtifactManifest): Map<string, string> {
    const expected = new Map<string, string>();
    expected.set(KERNEL_FILE_NAME, manifest.kernel.sha256);
    expected.set(manifest.agentBinary.filename, manifest.agentBinary.sha256);
    if (manifest.rootfs.identity.kind === "imageBytes") {
      expected.set(ROOTFS_FILE_NAME, manifest.rootfs.identity.sha256);
    }
    return expected;
  }

  /**
   * Import a built artifact set. The target directory is assembled under
   * a temp name, every file is fsync'd and verified against the
   * manifest's sha256 pins, then the directory is atomically renamed —
   * a crash never leaves a half-visible set and a corrupt copy never
   * becomes visible. Returns `created: false` if the hash was already
   * cached (the existing set wins).
   */
  store(options: StoreArtifactSetOptions): Promise<StoreArtifactSetResult> {
    return this.#exclusive(() => this.#storeLocked(options));
  }

  async #storeLocked(
    options: StoreArtifactSetOptions,
  ): Promise<StoreArtifactSetResult> {
    const hash = await manifestHash(options.manifest);
    const dir = this.setPath(hash);
    if (await this.has(hash)) {
      return { hash, dir, created: false };
    }
    for (const name of Object.keys(options.files)) {
      assertArtifactFileName(name, "artifact file name");
      if (name === MANIFEST_FILE_NAME || name === REFCOUNT_FILE_NAME) {
        throw new ArtifactCacheError(
          `artifact file name ${name} is reserved`,
        );
      }
    }
    const expected = this.#expectedFileHashes(options.manifest);
    const tempDir = join(this.root, `${TEMP_DIR_PREFIX}${crypto.randomUUID()}`);
    await Deno.mkdir(tempDir, { recursive: true });
    try {
      for (const [name, sourcePath] of Object.entries(options.files)) {
        const destPath = join(tempDir, name);
        await Deno.copyFile(sourcePath, destPath);
        const pin = expected.get(name);
        if (pin !== undefined) {
          const actual = await sha256HexOfFile(destPath);
          if (actual !== pin) {
            throw new ArtifactCacheError(
              `artifact file ${name} has sha256 ${actual}, expected ${pin} from the manifest`,
            );
          }
        }
        await syncFile(destPath);
      }
      const manifestPath = join(tempDir, MANIFEST_FILE_NAME);
      await writeArtifactManifest(manifestPath, options.manifest);
      await syncFile(manifestPath);
      await writeTextFileDurable(
        join(tempDir, REFCOUNT_FILE_NAME),
        JSON.stringify({ schemaVersion: 1, count: 0 } satisfies RefcountFile) +
          "\n",
      );
      try {
        await Deno.rename(tempDir, dir);
      } catch (error) {
        if (await this.has(hash)) {
          // Lost a store race; the winner's set is equivalent.
          await Deno.remove(tempDir, { recursive: true }).catch(() => {});
          return { hash, dir, created: false };
        }
        throw error;
      }
    } catch (error) {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
      throw error;
    }
    return { hash, dir, created: true };
  }

  refcount(hash: string): Promise<number> {
    return this.#readRefcount(hash);
  }

  async #readRefcount(hash: string): Promise<number> {
    if (!(await this.has(hash))) {
      throw new ArtifactCacheError(`artifact set ${hash} is not cached`);
    }
    let text: string;
    try {
      text = await Deno.readTextFile(this.#refcountPath(hash));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return 0;
      throw error;
    }
    try {
      return validateRefcountFile(JSON.parse(text)).count;
    } catch (cause) {
      throw new ArtifactCacheError(
        `refcount file for artifact set ${hash} is corrupt`,
        { cause },
      );
    }
  }

  async #writeRefcount(hash: string, count: number): Promise<void> {
    const path = this.#refcountPath(hash);
    const tempPath = `${path}${TEMP_DIR_PREFIX}${crypto.randomUUID()}`;
    try {
      await writeTextFileDurable(
        tempPath,
        JSON.stringify({ schemaVersion: 1, count } satisfies RefcountFile) +
          "\n",
      );
      await Deno.rename(tempPath, path);
    } catch (error) {
      await Deno.remove(tempPath).catch(() => {});
      throw error;
    }
  }

  acquire(hash: string): Promise<number> {
    return this.#exclusive(async () => {
      const next = (await this.#readRefcount(hash)) + 1;
      await this.#writeRefcount(hash, next);
      return next;
    });
  }

  release(hash: string): Promise<number> {
    return this.#exclusive(async () => {
      const current = await this.#readRefcount(hash);
      if (current === 0) {
        throw new ArtifactCacheError(
          `artifact set ${hash} released below zero`,
        );
      }
      const next = current - 1;
      await this.#writeRefcount(hash, next);
      return next;
    });
  }

  /**
   * Delete every cached set that is (a) at refcount zero **and** (b) not
   * referenced by any journal record. A set whose refcount file is
   * corrupt is kept (fail closed) — never silently reaped. Root-level
   * `.tmp-*` directories abandoned by a crashed store are swept once
   * they are older than {@link ABANDONED_TEMP_MAX_AGE_MS}.
   */
  gc(reader: ArtifactReferenceReader): Promise<ArtifactGcResult> {
    return this.#exclusive(async () => {
      await this.#sweepAbandonedTempDirs();
      const referenced = new Set(await reader.listReferencedManifestHashes());
      const deleted: string[] = [];
      const kept: string[] = [];
      for (const hash of await this.list()) {
        if (referenced.has(hash)) {
          kept.push(hash);
          continue;
        }
        let count: number;
        try {
          count = await this.#readRefcount(hash);
        } catch {
          kept.push(hash);
          continue;
        }
        if (count > 0) {
          kept.push(hash);
          continue;
        }
        await Deno.remove(this.setPath(hash), { recursive: true });
        deleted.push(hash);
      }
      return { deleted, kept };
    });
  }

  async #sweepAbandonedTempDirs(): Promise<void> {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.root)) {
        if (entry.name.startsWith(TEMP_DIR_PREFIX)) names.push(entry.name);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const now = Date.now();
    for (const name of names) {
      const path = join(this.root, name);
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      const mtime = info.mtime?.getTime();
      // No mtime → cannot age-gate → keep (fail closed, same stance as
      // corrupt refcounts).
      if (mtime === undefined || now - mtime < ABANDONED_TEMP_MAX_AGE_MS) {
        continue;
      }
      try {
        await Deno.remove(path, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
}
