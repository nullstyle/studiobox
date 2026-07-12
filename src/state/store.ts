/** Transactional storage for authoritative sandbox records. */

import { basename, dirname, join } from "@std/path";
import { type SandboxRecord, validateSandboxRecord } from "./model.ts";

/**
 * Sibling `<state>.<uuid>.tmp` files older than this are treated as
 * abandoned — a process crashed (e.g. `kill -9`) between {@link
 * JsonFileSandboxStore#write}'s temp write and its atomic rename — and are
 * swept before the next write. The age gate keeps the sweep from deleting a
 * temp file a concurrent in-flight writer is still filling (mirrors the
 * `ABANDONED_TEMP_MAX_AGE_MS` guard in `images/cache.ts`).
 */
export const ABANDONED_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

interface StateFile {
  schemaVersion: 1;
  records: Record<string, SandboxRecord>;
}

export interface SandboxStateStore {
  create(record: SandboxRecord): Promise<void>;
  get(id: string): Promise<SandboxRecord | null>;
  list(): Promise<SandboxRecord[]>;
  compareAndSwap(
    id: string,
    expectedRevision: number,
    update: (record: SandboxRecord) => SandboxRecord,
  ): Promise<SandboxRecord>;
  remove(id: string, expectedRevision: number): Promise<void>;
}

export class StateConflictError extends Error {
  readonly code = "SBX_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

export class StateCorruptError extends Error {
  readonly code = "SBX_STATE_CORRUPT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StateCorruptError";
  }
}

export interface JsonFileSandboxStoreOptions {
  now?: () => string;
}

/**
 * A single-process, crash-safe JSON state store.
 *
 * studiobox-hostd is the only writer. Operations are serialized in-process and each
 * mutation is fsync'd to a temporary file before an atomic rename. Cross-
 * process writers are deliberately unsupported; studiobox-rootd must mutate this
 * state through the supervisor protocol.
 */
export class JsonFileSandboxStore implements SandboxStateStore {
  readonly path: string;
  readonly #now: () => string;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: JsonFileSandboxStoreOptions = {}) {
    this.path = path;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  create(record: SandboxRecord): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#read();
      if (Object.hasOwn(state.records, record.id)) {
        throw new StateConflictError(`sandbox ${record.id} already exists`);
      }
      const validated = validateSandboxRecord(record);
      if (validated.revision !== 0) {
        throw new StateConflictError("new sandbox revision must be zero");
      }
      state.records[validated.id] = validated;
      await this.#write(state);
    });
  }

  get(id: string): Promise<SandboxRecord | null> {
    return this.#exclusive(async () => {
      const records = (await this.#read()).records;
      return Object.hasOwn(records, id) ? structuredClone(records[id]!) : null;
    });
  }

  list(): Promise<SandboxRecord[]> {
    return this.#exclusive(async () => {
      const records = Object.values((await this.#read()).records);
      records.sort((left, right) => left.id.localeCompare(right.id));
      return structuredClone(records);
    });
  }

  compareAndSwap(
    id: string,
    expectedRevision: number,
    update: (record: SandboxRecord) => SandboxRecord,
  ): Promise<SandboxRecord> {
    return this.#exclusive(async () => {
      const state = await this.#read();
      const current = state.records[id];
      if (!Object.hasOwn(state.records, id)) {
        throw new StateConflictError(`sandbox ${id} does not exist`);
      }
      if (current.revision !== expectedRevision) {
        throw new StateConflictError(
          `sandbox ${id} revision ${current.revision} does not match ${expectedRevision}`,
        );
      }
      const candidate = update(structuredClone(current));
      if (candidate.id !== id) {
        throw new StateConflictError(
          "sandbox id cannot change during an update",
        );
      }
      const next = validateSandboxRecord({
        ...candidate,
        revision: expectedRevision + 1,
        updatedAt: this.#now(),
      });
      state.records[id] = next;
      await this.#write(state);
      return structuredClone(next);
    });
  }

  remove(id: string, expectedRevision: number): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#read();
      const current = state.records[id];
      if (
        !Object.hasOwn(state.records, id) ||
        current!.revision !== expectedRevision
      ) {
        throw new StateConflictError(
          `sandbox ${id} does not exist at revision ${expectedRevision}`,
        );
      }
      delete state.records[id];
      await this.#write(state);
    });
  }

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

  async #read(): Promise<StateFile> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { schemaVersion: 1, records: emptyRecordMap() };
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<StateFile>;
      if (
        parsed.schemaVersion !== 1 || typeof parsed.records !== "object" ||
        parsed.records === null
      ) {
        throw new TypeError("invalid state-file envelope");
      }
      const records = emptyRecordMap();
      for (const [id, record] of Object.entries(parsed.records)) {
        const validated = validateSandboxRecord(record);
        if (id !== validated.id) {
          throw new TypeError(
            `state key ${id} does not match record id ${validated.id}`,
          );
        }
        records[id] = validated;
      }
      return { schemaVersion: 1, records };
    } catch (error) {
      throw new StateCorruptError(`cannot read sandbox state at ${this.path}`, {
        cause: error,
      });
    }
  }

  async #write(state: StateFile): Promise<void> {
    const directory = dirname(this.path);
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#sweepAbandonedTempFiles(directory);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(state, null, 2)}\n`,
    );
    let file: Deno.FsFile | undefined;
    try {
      file = await Deno.open(temporary, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      let offset = 0;
      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
      await file.sync();
      await Deno.chmod(temporary, 0o600);
      file.close();
      file = undefined;
      await Deno.rename(temporary, this.path);
    } catch (error) {
      file?.close();
      try {
        await Deno.remove(temporary);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Deno.errors.NotFound)) throw cleanupError;
      }
      throw error;
    }
  }

  /**
   * Remove orphaned `<state>.<uuid>.tmp` siblings left by a writer that
   * crashed between the temp write and the atomic rename. Only files older
   * than {@link ABANDONED_TEMP_MAX_AGE_MS} are removed so a concurrent
   * in-flight writer's fresh temp is never destroyed; a temp with no mtime
   * is kept (fail closed). Runs inside the write critical section, so it
   * never races another temp from this same process.
   */
  async #sweepAbandonedTempFiles(directory: string): Promise<void> {
    const prefix = `${basename(this.path)}.`;
    const suffix = ".tmp";
    const candidates: string[] = [];
    try {
      for await (const entry of Deno.readDir(directory)) {
        if (
          entry.isFile && entry.name.startsWith(prefix) &&
          entry.name.endsWith(suffix)
        ) {
          candidates.push(entry.name);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const now = Date.now();
    for (const name of candidates) {
      const path = join(directory, name);
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      const mtime = info.mtime?.getTime();
      if (mtime === undefined || now - mtime < ABANDONED_TEMP_MAX_AGE_MS) {
        continue;
      }
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
}

function emptyRecordMap(): Record<string, SandboxRecord> {
  return Object.create(null) as Record<string, SandboxRecord>;
}
