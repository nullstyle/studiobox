/**
 * On-disk warm-template store for snapshot-restore
 * (`docs/snapshot-restore.md` §1.2, WI-5).
 *
 * A **warm template** is a paused, un-personalized microVM captured to disk,
 * specific to one golden **manifest hash** (`images/manifest.ts` — the same
 * hash keying the artifact cache). This module owns the template's on-disk
 * home and its integrity contract; the snapshot planner (WI-6) resolves a
 * template through it and stages `{snapshot, mem, overlay.ext4}` into a fresh
 * jail, and the builder (`builder.ts` / `tools/build_warm_template.ts`)
 * publishes into it.
 *
 * Layout, per hash, under the store root (`<cache>/templates` by default):
 *
 * ```
 * <root>/<manifestHash>/
 *   snapshot       # Firecracker snapshot state file (SnapshotCreateParams.snapshot_path)
 *   mem            # guest memory image (SnapshotCreateParams.mem_file_path)  ~= mem_size_mib
 *   overlay.ext4   # the EXACT overlay the template VM had mounted at snapshot time (§3)
 *   template.json  # metadata + integrity contract (validated on every read)
 *   refcount.json  # GC guard: a live restore holds a ref so the set can't be reaped
 * ```
 *
 * **Integrity contract.** `template.json` records the manifest hash it was
 * built from, the `schemaSha256` it was captured under (which MUST match the
 * running studioboxd — `compat/wire.json`'s `schemaSha256`, e57b47d0… — or the
 * template is stale and rejected, because a schema change rolls the compiled
 * studioboxd bytes and thus the whole snapshot), the Firecracker version it was
 * captured under (for the `vsock_override` ≥ v1.16 gate, §5.5), the guest shape
 * (arch / vcpu / memMib / vsock port), the captured artifact sizes, and a
 * created marker. {@linkcode TemplateStore.resolve} re-validates all of it —
 * hash match, schema match, files present, sizes intact — before a restore is
 * allowed to trust the template.
 *
 * **Refcount tie-in.** Mirrors the artifact cache refcount
 * (`images/cache.ts`): a restore plan acquires the template's ref when it
 * resolves and releases it on terminate, so GC can never reclaim a template out
 * from under a live restore. The `Pick<…, "list" | "refcount">` shape matches
 * `artifactRefcountEnumerator` (`tools/soak/leak_audit.ts`) so the soak leak
 * audit (WI-8) can enumerate stuck template refs with no new plumbing.
 *
 * **Durability.** Every mutation runs on a per-instance promise-chain mutex and
 * publishes atomically (temp dir + `rename`), the exact stance of
 * `ArtifactCache` and `JsonFileSandboxStore` — a crash never leaves a
 * half-visible template and a corrupt copy never becomes visible.
 *
 * @module
 */

import { join } from "@std/path";
import type { ArtifactArch } from "../../../images/pins.ts";
import { assertArtifactArch } from "../../../images/pins.ts";
import {
  assertKeys,
  assertRecord,
  assertSha256,
  assertText,
  assertTimestamp,
  assertUnsignedInteger,
  isSha256Hex,
} from "../../../images/validate.ts";

/** `template.json` — the per-template metadata + integrity file name. */
export const TEMPLATE_METADATA_FILE_NAME = "template.json";
/** Firecracker snapshot state file name inside a template dir. */
export const TEMPLATE_SNAPSHOT_FILE_NAME = "snapshot";
/** Guest memory image file name inside a template dir. */
export const TEMPLATE_MEM_FILE_NAME = "mem";
/** Captured overlay file name inside a template dir. */
export const TEMPLATE_OVERLAY_FILE_NAME = "overlay.ext4";
/** Refcount GC-guard file name inside a template dir. */
export const TEMPLATE_REFCOUNT_FILE_NAME = "refcount.json";

/** `template.json` schema version (the metadata file's own format version). */
export const TEMPLATE_METADATA_VERSION = 1 as const;

const TEMP_DIR_PREFIX = ".tmp-";
/** Max guest memory a template may declare (bounds the mem size validator). */
const MAX_MEM_SIZE_MIB = 1_048_576;
/** Max AF_VSOCK port (u32 on the wire, but a real port is ≤ 65535). */
const MAX_VSOCK_PORT = 65_535;
/** Max vCPU count a template may declare. */
const MAX_VCPU_COUNT = 64;
/** Firecracker version strings are short (`1.16.1`); bound them tightly. */
const MAX_FC_VERSION_BYTES = 64;

export class TemplateStoreError extends Error {
  readonly code = "SBX_TEMPLATE_STORE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemplateStoreError";
  }
}

/** Byte sizes of the three captured artifacts (an integrity belt on resolve). */
export interface TemplateArtifactSizes {
  readonly snapshot: number;
  readonly mem: number;
  readonly overlay: number;
}

/** Fully validated `template.json` contents. */
export interface TemplateMetadata {
  readonly schemaVersion: typeof TEMPLATE_METADATA_VERSION;
  /** Golden manifest hash this template was built from (its dir key). */
  readonly manifestHash: string;
  /**
   * `compat/wire.json`'s `schemaSha256` the template was captured under. MUST
   * equal the running studioboxd's or the template is stale and rejected.
   */
  readonly schemaSha256: string;
  /** Firecracker version the snapshot was captured under (≥ v1.16 gate, §5.5). */
  readonly firecrackerVersion: string;
  readonly arch: ArtifactArch;
  readonly vcpuCount: number;
  readonly memSizeMib: number;
  /** Guest AF_VSOCK port studioboxd listens on in the captured snapshot. */
  readonly vsockPort: number;
  readonly sizes: TemplateArtifactSizes;
  /** Created marker (ISO 8601). */
  readonly createdAt: string;
}

/** The expected identity a resolve/validate checks a template against. */
export interface TemplateExpectation {
  /** The running studioboxd's schema hash (`compat/wire.json.schemaSha256`). */
  readonly schemaSha256: string;
}

/** A resolved, validated template ready to stage into a restore jail. */
export interface ResolvedTemplate {
  readonly hash: string;
  readonly dir: string;
  readonly snapshotPath: string;
  readonly memPath: string;
  readonly overlayPath: string;
  readonly metadata: TemplateMetadata;
}

/** Metadata a publish records, minus the fields the store derives itself. */
export interface PublishTemplateMetadata {
  readonly manifestHash: string;
  readonly schemaSha256: string;
  readonly firecrackerVersion: string;
  readonly arch: ArtifactArch;
  readonly vcpuCount: number;
  readonly memSizeMib: number;
  readonly vsockPort: number;
  /** Created marker; defaults to now. Injected for deterministic tests. */
  readonly createdAt?: string;
}

/** Source host paths of the three artifacts a publish copies in. */
export interface PublishTemplateFiles {
  readonly snapshot: string;
  readonly mem: string;
  readonly overlay: string;
}

export interface PublishTemplateOptions {
  readonly metadata: PublishTemplateMetadata;
  readonly files: PublishTemplateFiles;
}

export interface PublishTemplateResult {
  readonly hash: string;
  readonly dir: string;
  /**
   * True when a template was written for the hash — either a fresh install OR an
   * atomic REPLACE of a present-but-INVALID one (FINDING 4). `false` only when a
   * VALID existing template was reused untouched (idempotent).
   */
  readonly created: boolean;
  /**
   * True when this publish REPLACED a present-but-invalid template (corrupt /
   * stale / missing-artifact) rather than freshly installing one. Implies
   * `created`. Lets the builder report a truthful outcome — a rebuild over a
   * corrupt hash is never a false `reused` (FINDING 4).
   */
  readonly replaced: boolean;
}

/**
 * Copy a whole file, host path → host path. The default is `Deno.copyFile`
 * (byte-correct, host-safe, no extra permissions). Production may inject a
 * sparse-aware copier (`cp --sparse=always` / `SEEK_HOLE`/`SEEK_DATA`) so the
 * ~512 MiB `mem` image and the mostly-sparse `overlay.ext4` publish cheaply;
 * the store never needs `--allow-run` because the seam is optional.
 */
export type TemplateCopyFile = (src: string, dst: string) => Promise<void>;

export interface TemplateStoreOptions {
  /** Store root; template dirs live at `<root>/<hash>/`. */
  readonly root: string;
  /** File-copy seam for {@linkcode TemplateStore.publish}. @default Deno.copyFile */
  readonly copyFile?: TemplateCopyFile;
}

interface RefcountFile {
  schemaVersion: 1;
  count: number;
}

function validateRefcountFile(value: unknown): RefcountFile {
  const parsed = assertRecord(value, "template refcount file") as Partial<
    RefcountFile
  >;
  assertKeys(parsed, ["schemaVersion", "count"], "template refcount file");
  if (parsed.schemaVersion !== 1) {
    throw new TypeError("unsupported template refcount file schema version");
  }
  assertUnsignedInteger(
    parsed.count,
    "template refcount count",
    Number.MAX_SAFE_INTEGER,
  );
  return { schemaVersion: 1, count: parsed.count };
}

function validateSizes(value: unknown): TemplateArtifactSizes {
  const sizes = assertRecord(value, "template sizes") as Partial<
    TemplateArtifactSizes
  >;
  assertKeys(sizes, ["snapshot", "mem", "overlay"], "template sizes");
  // A zero-length capture is corrupt; every artifact is at least one byte.
  assertUnsignedInteger(
    sizes.snapshot,
    "template sizes.snapshot",
    Number.MAX_SAFE_INTEGER,
    1,
  );
  assertUnsignedInteger(
    sizes.mem,
    "template sizes.mem",
    Number.MAX_SAFE_INTEGER,
    1,
  );
  assertUnsignedInteger(
    sizes.overlay,
    "template sizes.overlay",
    Number.MAX_SAFE_INTEGER,
    1,
  );
  return { snapshot: sizes.snapshot, mem: sizes.mem, overlay: sizes.overlay };
}

/**
 * Validate `template.json` in the fail-closed, unknown-key-rejecting style of
 * `src/state/model.ts` / `images/manifest.ts`. Throws {@linkcode TypeError} on
 * any malformed field. Does NOT check the on-disk artifacts or the running
 * schema — that is {@linkcode TemplateStore.resolve}.
 */
export function validateTemplateMetadata(value: unknown): TemplateMetadata {
  const meta = assertRecord(value, "template metadata") as Partial<
    TemplateMetadata
  >;
  assertKeys(meta, [
    "schemaVersion",
    "manifestHash",
    "schemaSha256",
    "firecrackerVersion",
    "arch",
    "vcpuCount",
    "memSizeMib",
    "vsockPort",
    "sizes",
    "createdAt",
  ], "template metadata");
  if (meta.schemaVersion !== TEMPLATE_METADATA_VERSION) {
    throw new TypeError("unsupported template metadata schema version");
  }
  assertSha256(meta.manifestHash, "template manifestHash");
  assertSha256(meta.schemaSha256, "template schemaSha256");
  assertText(
    meta.firecrackerVersion,
    "template firecrackerVersion",
    MAX_FC_VERSION_BYTES,
  );
  assertArtifactArch(meta.arch, "template arch");
  assertUnsignedInteger(
    meta.vcpuCount,
    "template vcpuCount",
    MAX_VCPU_COUNT,
    1,
  );
  assertUnsignedInteger(
    meta.memSizeMib,
    "template memSizeMib",
    MAX_MEM_SIZE_MIB,
    1,
  );
  assertUnsignedInteger(
    meta.vsockPort,
    "template vsockPort",
    MAX_VSOCK_PORT,
    1,
  );
  const sizes = validateSizes(meta.sizes);
  assertTimestamp(meta.createdAt, "template createdAt");
  return {
    schemaVersion: TEMPLATE_METADATA_VERSION,
    manifestHash: meta.manifestHash,
    schemaSha256: meta.schemaSha256,
    firecrackerVersion: meta.firecrackerVersion,
    arch: meta.arch,
    vcpuCount: meta.vcpuCount,
    memSizeMib: meta.memSizeMib,
    vsockPort: meta.vsockPort,
    sizes,
    createdAt: meta.createdAt,
  };
}

async function readTemplateMetadataFile(
  path: string,
): Promise<TemplateMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new TemplateStoreError(`template metadata at ${path} is unreadable`, {
      cause,
    });
  }
  try {
    return validateTemplateMetadata(parsed);
  } catch (cause) {
    throw new TemplateStoreError(`template metadata at ${path} is invalid`, {
      cause,
    });
  }
}

/**
 * Write `text` to a brand-new file and fsync it before returning — the same
 * durability discipline as `ArtifactCache`. The caller owns temp naming and
 * the atomic rename.
 */
async function writeTextFileDurable(path: string, text: string): Promise<void> {
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

/**
 * The on-disk warm-template store. One instance per rootd process (or per build
 * tool run); pair its {@linkcode TemplateStore.reclaimHook}-free refcount with
 * the restore plan's acquire/release so a live restore pins its template.
 */
export class TemplateStore {
  readonly root: string;
  readonly #copyFile: TemplateCopyFile;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: TemplateStoreOptions) {
    this.root = options.root;
    this.#copyFile = options.copyFile ??
      ((src, dst) => Deno.copyFile(src, dst));
  }

  /** Absolute directory for a template hash. Validates the hash shape. */
  templateDir(hash: string): string {
    if (!isSha256Hex(hash)) {
      throw new TemplateStoreError(
        "template key must be a sha256 hex hash",
      );
    }
    return join(this.root, hash);
  }

  #snapshotPath(hash: string): string {
    return join(this.templateDir(hash), TEMPLATE_SNAPSHOT_FILE_NAME);
  }

  #memPath(hash: string): string {
    return join(this.templateDir(hash), TEMPLATE_MEM_FILE_NAME);
  }

  #overlayPath(hash: string): string {
    return join(this.templateDir(hash), TEMPLATE_OVERLAY_FILE_NAME);
  }

  #metadataPath(hash: string): string {
    return join(this.templateDir(hash), TEMPLATE_METADATA_FILE_NAME);
  }

  #refcountPath(hash: string): string {
    return join(this.templateDir(hash), TEMPLATE_REFCOUNT_FILE_NAME);
  }

  /** Serialize mutations per instance — the `ArtifactCache#exclusive` mutex. */
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

  /** Does a template directory exist for this hash? (Not a validity check.) */
  async has(hash: string): Promise<boolean> {
    try {
      const info = await Deno.stat(this.templateDir(hash));
      return info.isDirectory;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  /** Hashes of every template dir present (temp dirs excluded). */
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

  /** Read + validate `template.json`. Throws if absent or malformed. */
  async readMetadata(hash: string): Promise<TemplateMetadata> {
    return await readTemplateMetadataFile(this.#metadataPath(hash));
  }

  /**
   * Resolve a template for `hash`, verifying it is present and VALID against
   * `expected`: the metadata's manifest hash must equal `hash` (guards a
   * mislabeled dir), its `schemaSha256` must equal the running studioboxd's
   * (else it is stale — a schema change rolls the compiled agent and thus the
   * whole snapshot), and all three artifacts must be present with the sizes
   * `template.json` recorded (a truncation/corruption belt). Throws
   * {@linkcode TemplateStoreError} on any failure.
   */
  async resolve(
    hash: string,
    expected: TemplateExpectation,
  ): Promise<ResolvedTemplate> {
    const dir = this.templateDir(hash);
    if (!(await this.has(hash))) {
      throw new TemplateStoreError(`template ${hash} is not present`);
    }
    const metadata = await this.readMetadata(hash);
    if (metadata.manifestHash !== hash) {
      throw new TemplateStoreError(
        `template ${hash} metadata records manifest hash ${metadata.manifestHash}`,
      );
    }
    if (metadata.schemaSha256 !== expected.schemaSha256) {
      throw new TemplateStoreError(
        `template ${hash} was captured under schema ${metadata.schemaSha256}, ` +
          `but the running studioboxd is ${expected.schemaSha256} (stale template)`,
      );
    }
    const snapshotPath = this.#snapshotPath(hash);
    const memPath = this.#memPath(hash);
    const overlayPath = this.#overlayPath(hash);
    await this.#assertArtifactSize(snapshotPath, metadata.sizes.snapshot, hash);
    await this.#assertArtifactSize(memPath, metadata.sizes.mem, hash);
    await this.#assertArtifactSize(overlayPath, metadata.sizes.overlay, hash);
    return { hash, dir, snapshotPath, memPath, overlayPath, metadata };
  }

  async #assertArtifactSize(
    path: string,
    expectedSize: number,
    hash: string,
  ): Promise<void> {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new TemplateStoreError(
          `template ${hash} is missing ${path}`,
        );
      }
      throw error;
    }
    if (!info.isFile) {
      throw new TemplateStoreError(
        `template ${hash} artifact ${path} is not a file`,
      );
    }
    if (info.size !== expectedSize) {
      throw new TemplateStoreError(
        `template ${hash} artifact ${path} is ${info.size} bytes, ` +
          `template.json records ${expectedSize} (corrupt)`,
      );
    }
  }

  /**
   * Non-throwing validity check: absent OR failing {@linkcode
   * TemplateStore.resolve} ⇒ `false`. The lazy-first-use trigger (WI-6) builds
   * whenever this returns `false`. Only a {@linkcode TemplateStoreError}
   * (missing / stale / corrupt) is swallowed; a real I/O fault propagates.
   */
  async isValid(hash: string, expected: TemplateExpectation): Promise<boolean> {
    try {
      await this.resolve(hash, expected);
      return true;
    } catch (error) {
      if (error instanceof TemplateStoreError) return false;
      throw error;
    }
  }

  /**
   * Publish a freshly-baked template atomically: assemble it under a temp dir
   * (copy the three artifacts, measure their sizes, write validated
   * `template.json` + a zero refcount), fsync, then `rename` into place. A crash
   * never leaves a half-visible template.
   *
   * Existence is NOT validity (FINDING 4): a VALID existing template (resolvable
   * under the schema being published) wins — idempotent reuse, `created: false`.
   * But a present-but-INVALID one (bad schema hash, size drift, missing artifact)
   * is atomically REPLACED by the fresh bake — `created: true, replaced: true` —
   * so a corrupt hash is never permanently un-restorable behind a false reuse.
   * Each move is a single `rename`, so a reader never observes a half-written
   * template.
   */
  publish(options: PublishTemplateOptions): Promise<PublishTemplateResult> {
    return this.#exclusive(() => this.#publishLocked(options));
  }

  async #publishLocked(
    options: PublishTemplateOptions,
  ): Promise<PublishTemplateResult> {
    const hash = options.metadata.manifestHash;
    const dir = this.templateDir(hash); // validates the hash shape
    const existed = await this.has(hash);
    // A VALID existing template (under the schema we are publishing) wins — the
    // idempotent-reuse contract. A present-but-INVALID one must be REPLACED, not
    // silently reused as a false success (FINDING 4).
    if (
      existed &&
      await this.isValid(hash, { schemaSha256: options.metadata.schemaSha256 })
    ) {
      return { hash, dir, created: false, replaced: false };
    }
    await Deno.mkdir(this.root, { recursive: true });
    const tempDir = join(this.root, `${TEMP_DIR_PREFIX}${crypto.randomUUID()}`);
    await Deno.mkdir(tempDir, { recursive: true });
    try {
      const snapshotDest = join(tempDir, TEMPLATE_SNAPSHOT_FILE_NAME);
      const memDest = join(tempDir, TEMPLATE_MEM_FILE_NAME);
      const overlayDest = join(tempDir, TEMPLATE_OVERLAY_FILE_NAME);
      await this.#copyFile(options.files.snapshot, snapshotDest);
      await this.#copyFile(options.files.mem, memDest);
      await this.#copyFile(options.files.overlay, overlayDest);
      await syncFile(snapshotDest);
      await syncFile(memDest);
      await syncFile(overlayDest);
      const sizes: TemplateArtifactSizes = {
        snapshot: (await Deno.stat(snapshotDest)).size,
        mem: (await Deno.stat(memDest)).size,
        overlay: (await Deno.stat(overlayDest)).size,
      };
      const metadata = validateTemplateMetadata(
        {
          schemaVersion: TEMPLATE_METADATA_VERSION,
          manifestHash: options.metadata.manifestHash,
          schemaSha256: options.metadata.schemaSha256,
          firecrackerVersion: options.metadata.firecrackerVersion,
          arch: options.metadata.arch,
          vcpuCount: options.metadata.vcpuCount,
          memSizeMib: options.metadata.memSizeMib,
          vsockPort: options.metadata.vsockPort,
          sizes,
          createdAt: options.metadata.createdAt ?? new Date().toISOString(),
        } satisfies TemplateMetadata,
      );
      await writeTextFileDurable(
        join(tempDir, TEMPLATE_METADATA_FILE_NAME),
        JSON.stringify(metadata, null, 2) + "\n",
      );
      await writeTextFileDurable(
        join(tempDir, TEMPLATE_REFCOUNT_FILE_NAME),
        JSON.stringify({ schemaVersion: 1, count: 0 } satisfies RefcountFile) +
          "\n",
      );
      if (existed) {
        // REPLACE an INVALID existing template. `rename` cannot atomically swap a
        // non-empty dir, so move the stale one aside first, swing the fresh one
        // in, then drop the stale copy. Each `rename` is atomic — a concurrent
        // reader sees either the old (complete) or new (complete) template, never
        // a torn one (a brief absence between the two renames only ever resolves
        // to "not present", which falls SAFE to cold).
        const staleDir = join(
          this.root,
          `${TEMP_DIR_PREFIX}stale-${crypto.randomUUID()}`,
        );
        await Deno.rename(dir, staleDir);
        try {
          await Deno.rename(tempDir, dir);
        } catch (error) {
          // Swing failed: restore the stale template so the slot is not stranded
          // empty, then surface the failure (the temp dir is cleaned by catch).
          await Deno.rename(staleDir, dir).catch(() => {});
          throw error;
        }
        await Deno.remove(staleDir, { recursive: true }).catch(() => {});
        return { hash, dir, created: true, replaced: true };
      }
      try {
        await Deno.rename(tempDir, dir);
      } catch (error) {
        if (await this.has(hash)) {
          // Lost a publish race; the winner's template is equivalent.
          await Deno.remove(tempDir, { recursive: true }).catch(() => {});
          return { hash, dir, created: false, replaced: false };
        }
        throw error;
      }
    } catch (error) {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
      throw error;
    }
    return { hash, dir, created: true, replaced: false };
  }

  /** Current refcount for a template. Throws if the template is absent. */
  refcount(hash: string): Promise<number> {
    return this.#readRefcount(hash);
  }

  async #readRefcount(hash: string): Promise<number> {
    if (!(await this.has(hash))) {
      throw new TemplateStoreError(`template ${hash} is not present`);
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
      throw new TemplateStoreError(
        `refcount file for template ${hash} is corrupt`,
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

  /** Acquire (increment) the template's refcount; a live restore holds one. */
  acquire(hash: string): Promise<number> {
    return this.#exclusive(async () => {
      const next = (await this.#readRefcount(hash)) + 1;
      await this.#writeRefcount(hash, next);
      return next;
    });
  }

  /** Release (decrement) the template's refcount. Throws below zero. */
  release(hash: string): Promise<number> {
    return this.#exclusive(async () => {
      const current = await this.#readRefcount(hash);
      if (current === 0) {
        throw new TemplateStoreError(
          `template ${hash} released below zero`,
        );
      }
      const next = current - 1;
      await this.#writeRefcount(hash, next);
      return next;
    });
  }
}
