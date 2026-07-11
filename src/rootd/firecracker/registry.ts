import type { JailRecord, VmRegistry } from "@nullstyle/firecracker";
import type { JailRecordState, SandboxRecord } from "../../state/model.ts";
import {
  type SandboxStateStore,
  StateConflictError,
} from "../../state/store.ts";
import { ExecutionIdConflictError, StaleExecutionIdError } from "./errors.ts";

export const SANDBOX_ID_METADATA = "studiobox.sandbox-id";
export const EXECUTION_ID_METADATA = "studiobox.execution-id";

/**
 * Atomic persistence operations required by the package registry adapter.
 * The authoritative Studiobox state store supplies this surface; this module
 * deliberately does not create a second persistence engine.
 */
export interface AtomicJailRecordStore {
  /** Return false without overwriting when the execution id already exists. */
  create(record: JailRecord): Promise<boolean>;
  /** Atomically merge a patch; return false when the record is absent. */
  update(
    executionId: string,
    patch: Partial<JailRecord>,
  ): Promise<boolean>;
  /** Idempotently delete the low-level subrecord. */
  remove(executionId: string): Promise<void>;
  list(): Promise<JailRecord[]>;
}

/** VmRegistry backed by atomic, create-only authoritative state operations. */
export class CreateOnlyVmRegistry implements VmRegistry {
  readonly #store: AtomicJailRecordStore;

  constructor(store: AtomicJailRecordStore) {
    this.#store = store;
  }

  async put(record: JailRecord): Promise<void> {
    if (!await this.#store.create(structuredClone(record))) {
      throw new ExecutionIdConflictError(record.vmId);
    }
  }

  async update(
    executionId: string,
    patch: Partial<JailRecord>,
  ): Promise<void> {
    if (!await this.#store.update(executionId, structuredClone(patch))) {
      throw new StaleExecutionIdError(executionId);
    }
  }

  remove(executionId: string): Promise<void> {
    return this.#store.remove(executionId);
  }

  async list(): Promise<JailRecord[]> {
    return structuredClone(await this.#store.list());
  }
}

export interface SandboxStateJailRecordStoreOptions {
  readonly now?: () => string;
  readonly maxCasAttempts?: number;
}

/**
 * Stores the package JailRecord inside the authoritative SandboxRecord.
 * Removing a package record retains the surrounding execution and Studiobox
 * resources so composed reconciliation can finish them before reuse.
 */
export class SandboxStateJailRecordStore implements AtomicJailRecordStore {
  readonly #state: SandboxStateStore;
  readonly #now: () => string;
  readonly #maxCasAttempts: number;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    state: SandboxStateStore,
    options: SandboxStateJailRecordStoreOptions = {},
  ) {
    this.#state = state;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxCasAttempts = options.maxCasAttempts ?? 16;
  }

  create(record: JailRecord): Promise<boolean> {
    return this.#exclusive(async () => {
      const sandboxId = sandboxIdFrom(record);
      for (let attempt = 0; attempt < this.#maxCasAttempts; attempt++) {
        const records = await this.#state.list();
        if (
          records.some((candidate) =>
            candidate.machine?.executionId === record.vmId
          )
        ) {
          return false;
        }
        const sandbox = records.find((candidate) => candidate.id === sandboxId);
        if (sandbox === undefined) {
          throw new StaleExecutionIdError(record.vmId, "journal execution");
        }
        if (sandbox.machine !== undefined) return false;
        try {
          await this.#state.compareAndSwap(
            sandbox.id,
            sandbox.revision,
            (current) => {
              if (current.machine !== undefined) {
                throw new ExecutionIdConflictError(record.vmId);
              }
              const timestamp = this.#now();
              return {
                ...current,
                machine: {
                  executionId: record.vmId,
                  phase: "launching",
                  jailRecord: toStateRecord(record),
                  updatedAt: timestamp,
                },
              };
            },
          );
          return true;
        } catch (error) {
          if (error instanceof ExecutionIdConflictError) return false;
          if (!(error instanceof StateConflictError)) throw error;
        }
      }
      throw new StateConflictError(
        "Firecracker journal create exceeded its CAS retry bound",
      );
    });
  }

  update(
    executionId: string,
    patch: Partial<JailRecord>,
  ): Promise<boolean> {
    return this.#exclusive(async () => {
      for (let attempt = 0; attempt < this.#maxCasAttempts; attempt++) {
        const sandbox = await this.#findExecution(executionId);
        if (sandbox?.machine?.jailRecord === undefined) return false;
        try {
          await this.#state.compareAndSwap(
            sandbox.id,
            sandbox.revision,
            (current) => {
              if (
                current.machine?.executionId !== executionId ||
                current.machine.jailRecord === undefined
              ) {
                throw new StaleExecutionIdError(executionId);
              }
              const jailRecord = {
                ...current.machine.jailRecord,
                ...structuredClone(patch),
                vmId: executionId,
              } satisfies JailRecordState;
              return {
                ...current,
                machine: {
                  ...current.machine,
                  jailRecord,
                  updatedAt: this.#now(),
                },
              };
            },
          );
          return true;
        } catch (error) {
          if (error instanceof StaleExecutionIdError) return false;
          if (!(error instanceof StateConflictError)) throw error;
        }
      }
      throw new StateConflictError(
        "Firecracker journal update exceeded its CAS retry bound",
      );
    });
  }

  remove(executionId: string): Promise<void> {
    return this.#exclusive(async () => {
      for (let attempt = 0; attempt < this.#maxCasAttempts; attempt++) {
        const sandbox = await this.#findExecution(executionId);
        if (sandbox?.machine?.jailRecord === undefined) return;
        try {
          await this.#state.compareAndSwap(
            sandbox.id,
            sandbox.revision,
            (current) => {
              if (current.machine?.executionId !== executionId) {
                throw new StaleExecutionIdError(
                  executionId,
                  "remove execution journal",
                );
              }
              const { jailRecord: _removed, ...machine } = current.machine;
              return {
                ...current,
                machine: {
                  ...machine,
                  phase: "reclaiming",
                  updatedAt: this.#now(),
                },
              };
            },
          );
          return;
        } catch (error) {
          // A replacement execution owns this sandbox now. A stale package
          // cleanup must not clear the replacement's journal.
          if (error instanceof StaleExecutionIdError) return;
          if (!(error instanceof StateConflictError)) throw error;
        }
      }
      throw new StateConflictError(
        "Firecracker journal removal exceeded its CAS retry bound",
      );
    });
  }

  list(): Promise<JailRecord[]> {
    return this.#exclusive(async () => {
      const records = (await this.#state.list()).flatMap((sandbox) => {
        const record = sandbox.machine?.jailRecord;
        return record === undefined ? [] : [toPackageRecord(record)];
      });
      records.sort((left, right) => left.vmId.localeCompare(right.vmId));
      return records;
    });
  }

  async #findExecution(executionId: string): Promise<SandboxRecord | null> {
    return (await this.#state.list()).find((sandbox) =>
      sandbox.machine?.executionId === executionId
    ) ?? null;
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
}

/** Restrict a reconciliation sweep to one execution id. */
export function scopeRegistry(
  registry: VmRegistry,
  executionId: string,
): VmRegistry {
  return {
    put: async (record) => {
      assertScope(record.vmId, executionId);
      await registry.put(record);
    },
    update: async (vmId, patch) => {
      assertScope(vmId, executionId);
      await registry.update(vmId, patch);
    },
    remove: async (vmId) => {
      assertScope(vmId, executionId);
      await registry.remove(vmId);
    },
    list: async () =>
      (await registry.list()).filter((record) => record.vmId === executionId),
  };
}

function assertScope(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("a scoped Firecracker registry rejected another execution");
  }
}

function sandboxIdFrom(record: JailRecord): string {
  const sandboxId = record.metadata?.[SANDBOX_ID_METADATA];
  const metadataExecutionId = record.metadata?.[EXECUTION_ID_METADATA];
  if (sandboxId === undefined || metadataExecutionId !== record.vmId) {
    throw new StaleExecutionIdError(record.vmId, "journal execution");
  }
  return sandboxId;
}

function toStateRecord(record: JailRecord): JailRecordState {
  return structuredClone(record) satisfies JailRecordState;
}

function toPackageRecord(record: JailRecordState): JailRecord {
  return structuredClone(record) satisfies JailRecord;
}
