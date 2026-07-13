import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import type {
  JailedRestoreOptions,
  JailRecord,
  MachineOptions,
  ReconcileResult,
  RestoreOptions,
  VmmExit,
  VsockConn,
} from "@nullstyle/firecracker";
import {
  type AtomicJailRecordStore,
  CreateOnlyVmRegistry,
  FirecrackerAdapter,
  FirecrackerAdapterError,
  type FirecrackerRuntime,
  type RuntimeMachine,
} from "../../../src/rootd/firecracker/mod.ts";

const EXIT: VmmExit = {
  code: 0,
  signal: null,
  observedVia: "child-status",
  stderrTail: "",
};

Deno.test("adapter forces copied staging and binds package metadata", async () => {
  const registry = testRegistry();
  const machine = new FakeMachine("sbx-exec-one");
  let captured: MachineOptions | undefined;
  const runtime = fakeRuntime({
    launch: (options) => {
      captured = options;
      return Promise.resolve(machine);
    },
  });
  const adapter = new FirecrackerAdapter({ registry, runtime });

  const launched = await adapter.launch({
    sandboxId: "sandbox-stable",
    executionId: "sbx-exec-one",
    jailer: baseJailer(),
    stage: [
      { hostPath: "/artifacts/kernel", jailPath: "/vmlinux" },
      // Simulate an untyped caller trying to smuggle in the unsafe mode.
      {
        hostPath: "/artifacts/rootfs",
        jailPath: "/rootfs.ext4",
        readWrite: true,
        mode: "hardlink",
      } as unknown as {
        hostPath: string;
        jailPath: string;
        readWrite: boolean;
      },
    ],
    config: baseConfig(),
    metadata: { tenant: "test" },
  });

  assert(captured?.jailer !== undefined);
  assertEquals(captured.jailer.id, "sbx-exec-one");
  assertEquals(captured.jailer.stage, [
    {
      hostPath: "/artifacts/kernel",
      jailPath: "/vmlinux",
      mode: "copy",
    },
    {
      hostPath: "/artifacts/rootfs",
      jailPath: "/rootfs.ext4",
      mode: "copy",
      readWrite: true,
    },
  ]);
  assertEquals(captured.metadata, {
    tenant: "test",
    "studiobox.sandbox-id": "sandbox-stable",
    "studiobox.execution-id": "sbx-exec-one",
  });
  assertEquals(launched.executionId, "sbx-exec-one");
  assertEquals(adapter.compatibility.pinned, "v1.16.1");
});

Deno.test("adapter restore stages copy-mode + issues loadSnapshot with the overrides, and returns a drivable machine", async () => {
  const registry = testRegistry();
  const machine = new FakeMachine("sbx-restore-one");
  let captured: RestoreOptions | undefined;
  const runtime = fakeRuntime({
    restore: (options) => {
      captured = options;
      return Promise.resolve(machine);
    },
  });
  const adapter = new FirecrackerAdapter({ registry, runtime });

  const restored = await adapter.restore({
    sandboxId: "sandbox-restore",
    executionId: "sbx-restore-one",
    jailer: baseJailer(),
    stage: [
      { hostPath: "/templates/hash/snapshot", jailPath: "/snapshot" },
      { hostPath: "/templates/hash/mem", jailPath: "/mem" },
      { hostPath: "/artifacts/rootfs", jailPath: "/rootfs.ext4" },
      // A caller trying to smuggle in hardlink mode is forced to copy.
      {
        hostPath: "/templates/hash/overlay.ext4",
        jailPath: "/overlay.ext4",
        readWrite: true,
        mode: "hardlink",
      } as unknown as {
        hostPath: string;
        jailPath: string;
        readWrite: boolean;
      },
    ],
    snapshot: {
      snapshot_path: "/snapshot",
      mem_backend: { backend_type: "File", backend_path: "/mem" },
      resume_vm: true,
      clock_realtime: true,
      network_overrides: [{ iface_id: "eth0", host_dev_name: "sbxtap5" }],
      vsock_override: { uds_path: "v.sock" },
    },
    metadata: { tenant: "test" },
  });

  // Jailed restore: id + forced copy staging, exactly like launch.
  assert(captured !== undefined);
  const jailed = captured as JailedRestoreOptions;
  assertEquals(jailed.jailer.id, "sbx-restore-one");
  assertEquals(jailed.jailer.stage, [
    {
      hostPath: "/templates/hash/snapshot",
      jailPath: "/snapshot",
      mode: "copy",
    },
    { hostPath: "/templates/hash/mem", jailPath: "/mem", mode: "copy" },
    { hostPath: "/artifacts/rootfs", jailPath: "/rootfs.ext4", mode: "copy" },
    {
      hostPath: "/templates/hash/overlay.ext4",
      jailPath: "/overlay.ext4",
      mode: "copy",
      readWrite: true,
    },
  ]);
  // The snapshot load params pass through verbatim (in-jail paths + overrides).
  assertEquals(jailed.snapshot.snapshot_path, "/snapshot");
  assertEquals(jailed.snapshot.mem_backend, {
    backend_type: "File",
    backend_path: "/mem",
  });
  assertEquals(jailed.snapshot.resume_vm, true);
  assertEquals(jailed.snapshot.clock_realtime, true);
  assertEquals(jailed.snapshot.network_overrides, [
    { iface_id: "eth0", host_dev_name: "sbxtap5" },
  ]);
  assertEquals(jailed.snapshot.vsock_override, { uds_path: "v.sock" });
  assertEquals(jailed.registry, registry);
  assertEquals(jailed.metadata, {
    tenant: "test",
    "studiobox.sandbox-id": "sandbox-restore",
    "studiobox.execution-id": "sbx-restore-one",
  });

  // The supervisor drives a restored machine exactly like a launched one.
  assertEquals(restored.executionId, "sbx-restore-one");
  assertEquals(restored.pid, 42);
  const conn = await restored.connectVsock(1024);
  assertExists(conn);
  await restored.kill();
  assertEquals(machine.killCalls, 1);
  await restored[Symbol.asyncDispose]();
});

Deno.test("failed restore reconciles only its execution id", async () => {
  const registry = testRegistry([
    jailRecord("sbx-restore-fail"),
    jailRecord("sbx-restore-live"),
  ]);
  let reconciledIds: string[] = [];
  const runtime = fakeRuntime({
    restore: () => Promise.reject({ code: "FC_API", status: 400 }),
    reconcile: async (scoped) => {
      reconciledIds = (await scoped.list()).map((record) => record.vmId);
      return cleanReconcile(reconciledIds);
    },
  });
  const adapter = new FirecrackerAdapter({ registry, runtime });

  const error = await assertRejects(
    () =>
      adapter.restore({
        sandboxId: "sandbox-restore-fail",
        executionId: "sbx-restore-fail",
        jailer: baseJailer(),
        stage: [],
        snapshot: { snapshot_path: "/snapshot", resume_vm: true },
      }),
    FirecrackerAdapterError,
  );

  assertEquals(reconciledIds, ["sbx-restore-fail"]);
  assertEquals(error.code, "SBX_FC_API");
});

Deno.test("failed launch reconciles only its execution id", async () => {
  const registry = testRegistry([
    jailRecord("sbx-failed"),
    jailRecord("sbx-running"),
  ]);
  let reconciledIds: string[] = [];
  const runtime = fakeRuntime({
    launch: () => Promise.reject({ code: "FC_JAILER" }),
    reconcile: async (scoped) => {
      reconciledIds = (await scoped.list()).map((record) => record.vmId);
      return cleanReconcile(reconciledIds);
    },
  });
  const adapter = new FirecrackerAdapter({ registry, runtime });

  const error = await assertRejects(
    () =>
      adapter.launch({
        sandboxId: "sandbox-failed",
        executionId: "sbx-failed",
        jailer: baseJailer(),
        stage: [],
        config: baseConfig(),
      }),
    FirecrackerAdapterError,
  );

  assertEquals(reconciledIds, ["sbx-failed"]);
  assertEquals(error.code, "SBX_FC_JAILER");
});

Deno.test("incomplete launch reconciliation is never hidden", async () => {
  const registry = testRegistry([jailRecord("sbx-leaked")]);
  const runtime = fakeRuntime({
    launch: () => Promise.reject({ code: "FC_API", status: 400 }),
    reconcile: () =>
      Promise.resolve({
        reclaimed: [],
        stillRunning: [],
        failures: [{ vmId: "sbx-leaked", error: new Error("busy") }],
      }),
  });
  const adapter = new FirecrackerAdapter({ registry, runtime });

  const error = await assertRejects(
    () =>
      adapter.launch({
        sandboxId: "sandbox-leaked",
        executionId: "sbx-leaked",
        jailer: baseJailer(),
        stage: [],
        config: baseConfig(),
      }),
    FirecrackerAdapterError,
  );

  assertEquals(error.code, "SBX_FC_CLEANUP");
});

Deno.test("machine tracks and closes outbound vsock connections on exit", async () => {
  const registry = testRegistry();
  const machine = new FakeMachine("sbx-vsock");
  let closes = 0;
  machine.connection = {
    close: () => closes++,
  } as unknown as VsockConn;
  const adapter = new FirecrackerAdapter({
    registry,
    runtime: fakeRuntime({ launch: () => Promise.resolve(machine) }),
  });
  const launched = await adapter.launch({
    sandboxId: "sandbox-vsock",
    executionId: "sbx-vsock",
    jailer: baseJailer(),
    stage: [],
    config: baseConfig(),
  });

  await launched.connectVsock(5000);
  machine.resolveExit(EXIT);
  await Promise.resolve();
  assertEquals(closes, 1);
});

Deno.test("shutdown outer deadline triggers kill and a stable timeout", async () => {
  const machine = new FakeMachine("sbx-timeout");
  machine.shutdownResult = new Promise(() => {});
  const adapter = new FirecrackerAdapter({
    registry: testRegistry(),
    runtime: fakeRuntime({ launch: () => Promise.resolve(machine) }),
  });
  const launched = await adapter.launch({
    sandboxId: "sandbox-timeout",
    executionId: "sbx-timeout",
    jailer: baseJailer(),
    stage: [],
    config: baseConfig(),
  });

  const error = await assertRejects(
    () => launched.shutdown({ timeoutMs: 1 }),
    FirecrackerAdapterError,
  );
  await Promise.resolve();
  assertEquals(error.code, "SBX_FC_TIMEOUT");
  assertEquals(machine.killCalls, 1);
});

function baseJailer() {
  return {
    jailerBin: "/usr/bin/jailer",
    firecrackerBin: "/usr/bin/firecracker",
    uid: 10001,
    gid: 10001,
    newPidNs: true,
  };
}

function baseConfig() {
  return {
    boot_source: { kernel_image_path: "/vmlinux" },
  };
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

class MemoryJailRecordStore implements AtomicJailRecordStore {
  readonly records = new Map<string, JailRecord>();

  constructor(records: JailRecord[] = []) {
    for (const record of records) this.records.set(record.vmId, record);
  }

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

function testRegistry(records: JailRecord[] = []): CreateOnlyVmRegistry {
  return new CreateOnlyVmRegistry(new MemoryJailRecordStore(records));
}

class FakeMachine implements RuntimeMachine {
  readonly vmId: string;
  readonly pid = 42;
  readonly state = "running" as const;
  readonly #exit = Promise.withResolvers<VmmExit>();
  readonly exited = this.#exit.promise;
  connection = { close() {} } as unknown as VsockConn;
  shutdownResult: Promise<VmmExit> = Promise.resolve(EXIT);
  killCalls = 0;

  constructor(vmId: string) {
    this.vmId = vmId;
  }

  readonly vsock = {
    connect: (): Promise<VsockConn> => Promise.resolve(this.connection),
  };

  shutdown(): Promise<VmmExit> {
    return this.shutdownResult;
  }

  kill(): Promise<VmmExit> {
    this.killCalls++;
    return Promise.resolve(EXIT);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return Promise.resolve();
  }

  resolveExit(exit: VmmExit): void {
    this.#exit.resolve(exit);
  }
}

function fakeRuntime(
  overrides: Partial<FirecrackerRuntime> = {},
): FirecrackerRuntime {
  return {
    compatibility: { pinned: "v1.16.1", min: "v1.15.0" },
    launch: () => Promise.resolve(new FakeMachine("sbx-default")),
    restore: () => Promise.resolve(new FakeMachine("sbx-default")),
    reconcile: () => Promise.resolve(cleanReconcile([])),
    ...overrides,
  };
}

function cleanReconcile(ids: string[]): ReconcileResult {
  return { reclaimed: ids, stillRunning: [], failures: [] };
}
