import { assert, assertEquals, assertRejects } from "@std/assert";
import type { JailRecord } from "@nullstyle/firecracker";
import {
  newSandboxRecord,
  type SandboxRecord,
} from "../../../src/state/model.ts";
import {
  type SandboxStateStore,
  StateConflictError,
} from "../../../src/state/store.ts";
import {
  type AtomicJailRecordStore,
  CreateOnlyVmRegistry,
  EXECUTION_ID_METADATA,
  ExecutionIdConflictError,
  SANDBOX_ID_METADATA,
  SandboxStateJailRecordStore,
  scopeRegistry,
  StaleExecutionIdError,
} from "../../../src/rootd/firecracker/mod.ts";

Deno.test("create-only registry rejects an execution id collision", async () => {
  const store = new MemoryJailRecordStore();
  const registry = new CreateOnlyVmRegistry(store);
  const record = jailRecord("sbx-collision");

  await registry.put(record);
  await assertRejects(
    () => registry.put({ ...record, apiSocketPath: "/attacker.sock" }),
    ExecutionIdConflictError,
  );

  assertEquals((await registry.list())[0].apiSocketPath, record.apiSocketPath);
});

Deno.test("scoped registry cannot expose or mutate another execution", async () => {
  const store = new MemoryJailRecordStore();
  const registry = new CreateOnlyVmRegistry(store);
  await registry.put(jailRecord("sbx-one"));
  await registry.put(jailRecord("sbx-two"));
  const scoped = scopeRegistry(registry, "sbx-one");

  assertEquals((await scoped.list()).map((record) => record.vmId), ["sbx-one"]);
  await assertRejects(() => scoped.remove("sbx-two"));
  assertEquals((await registry.list()).length, 2);
});

Deno.test("sandbox state adapter nests and removes only the package record", async () => {
  const state = new MemorySandboxStateStore();
  await state.create(newSandboxRecord({
    id: "sandbox-one",
    createdAt: "2026-07-10T00:00:00.000Z",
  }));
  const registry = new CreateOnlyVmRegistry(
    new SandboxStateJailRecordStore(state, {
      now: () => "2026-07-10T00:00:01.000Z",
    }),
  );
  const record = boundJailRecord("sandbox-one", "sbx-nested");

  await registry.put(record);
  const journaled = await state.get("sandbox-one");
  assertEquals(journaled?.machine?.executionId, "sbx-nested");
  assertEquals(journaled?.machine?.jailRecord, record);

  await registry.remove("sbx-nested");
  const reclaimed = await state.get("sandbox-one");
  assertEquals(reclaimed?.machine?.executionId, "sbx-nested");
  assertEquals(reclaimed?.machine?.phase, "reclaiming");
  assertEquals(reclaimed?.machine?.jailRecord, undefined);

  await assertRejects(
    () => registry.put(boundJailRecord("sandbox-one", "sbx-new-attempt")),
    ExecutionIdConflictError,
  );
});

Deno.test("sandbox state adapter rejects mismatched execution metadata", async () => {
  const state = new MemorySandboxStateStore();
  await state.create(newSandboxRecord({ id: "sandbox-mismatch" }));
  const registry = new CreateOnlyVmRegistry(
    new SandboxStateJailRecordStore(state),
  );
  const record = boundJailRecord("sandbox-mismatch", "sbx-actual");
  record.metadata![EXECUTION_ID_METADATA] = "sbx-substituted";

  await assertRejects(
    () => registry.put(record),
    StaleExecutionIdError,
  );
  assertEquals((await state.get("sandbox-mismatch"))?.machine, undefined);
});

Deno.test("CAS retries only while the same execution remains current", async () => {
  const state = new MemorySandboxStateStore();
  await state.create(newSandboxRecord({ id: "sandbox-cas" }));
  const registry = new CreateOnlyVmRegistry(
    new SandboxStateJailRecordStore(state, {
      now: () => "2026-07-10T00:00:02.000Z",
    }),
  );
  await registry.put(boundJailRecord("sandbox-cas", "sbx-current"));

  state.conflict = { kind: "same-execution" };
  await registry.update("sbx-current", { pid: 100 });
  assertEquals(
    (await state.get("sandbox-cas"))?.machine?.jailRecord?.pid,
    100,
  );

  state.conflict = {
    kind: "replacement",
    record: boundJailRecord("sandbox-cas", "sbx-replacement"),
  };
  await assertRejects(
    () => registry.update("sbx-current", { pid: 999 }),
    StaleExecutionIdError,
  );
  await registry.remove("sbx-current");

  const replacement = await state.get("sandbox-cas");
  assertEquals(replacement?.machine?.executionId, "sbx-replacement");
  assertEquals(replacement?.machine?.jailRecord?.pid, null);
});

class MemoryJailRecordStore implements AtomicJailRecordStore {
  readonly records = new Map<string, JailRecord>();

  create(record: JailRecord): Promise<boolean> {
    if (this.records.has(record.vmId)) return Promise.resolve(false);
    this.records.set(record.vmId, structuredClone(record));
    return Promise.resolve(true);
  }

  update(vmId: string, patch: Partial<JailRecord>): Promise<boolean> {
    const current = this.records.get(vmId);
    if (current === undefined) return Promise.resolve(false);
    this.records.set(vmId, { ...current, ...structuredClone(patch) });
    return Promise.resolve(true);
  }

  remove(vmId: string): Promise<void> {
    this.records.delete(vmId);
    return Promise.resolve();
  }

  list(): Promise<JailRecord[]> {
    return Promise.resolve(structuredClone([...this.records.values()]));
  }
}

function jailRecord(vmId: string): JailRecord {
  return {
    version: 1,
    vmId,
    pid: null,
    apiSocketPath: `/run/${vmId}.sock`,
    stateDir: `/srv/${vmId}`,
    ownsStateDir: false,
    vsockListenerPaths: [],
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function boundJailRecord(sandboxId: string, vmId: string): JailRecord {
  return {
    ...jailRecord(vmId),
    metadata: {
      [SANDBOX_ID_METADATA]: sandboxId,
      [EXECUTION_ID_METADATA]: vmId,
    },
  };
}

type InjectedConflict =
  | { kind: "same-execution" }
  | { kind: "replacement"; record: JailRecord };

class MemorySandboxStateStore implements SandboxStateStore {
  readonly records = new Map<string, SandboxRecord>();
  conflict: InjectedConflict | undefined;

  create(record: SandboxRecord): Promise<void> {
    if (this.records.has(record.id)) {
      return Promise.reject(new StateConflictError("already exists"));
    }
    this.records.set(record.id, structuredClone(record));
    return Promise.resolve();
  }

  get(id: string): Promise<SandboxRecord | null> {
    const record = this.records.get(id);
    return Promise.resolve(
      record === undefined ? null : structuredClone(record),
    );
  }

  list(): Promise<SandboxRecord[]> {
    return Promise.resolve(structuredClone([...this.records.values()]));
  }

  compareAndSwap(
    id: string,
    expectedRevision: number,
    update: (record: SandboxRecord) => SandboxRecord,
  ): Promise<SandboxRecord> {
    const current = this.records.get(id);
    if (current === undefined || current.revision !== expectedRevision) {
      return Promise.reject(new StateConflictError("revision conflict"));
    }
    const conflict = this.conflict;
    this.conflict = undefined;
    if (conflict !== undefined) {
      const changed = structuredClone(current);
      changed.revision++;
      if (conflict.kind === "replacement") {
        assert(changed.machine !== undefined);
        changed.machine = {
          ...changed.machine,
          executionId: conflict.record.vmId,
          jailRecord: structuredClone(conflict.record),
        };
      }
      this.records.set(id, changed);
      return Promise.reject(new StateConflictError("injected conflict"));
    }
    const next = structuredClone(update(structuredClone(current)));
    next.revision = expectedRevision + 1;
    this.records.set(id, next);
    return Promise.resolve(structuredClone(next));
  }

  remove(id: string, expectedRevision: number): Promise<void> {
    const current = this.records.get(id);
    if (current === undefined || current.revision !== expectedRevision) {
      return Promise.reject(new StateConflictError("revision conflict"));
    }
    this.records.delete(id);
    return Promise.resolve();
  }
}
