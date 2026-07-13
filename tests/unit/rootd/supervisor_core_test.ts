import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type {
  JailRecord,
  MachineOptions,
  ReconcileResult,
  VmmExit,
  VmRegistry,
  VsockConn,
} from "@nullstyle/firecracker";
import {
  CreateOnlyVmRegistry,
  FirecrackerAdapterError,
  type FirecrackerRuntime,
  type RuntimeMachine,
  SandboxStateJailRecordStore,
  StaleExecutionIdError,
} from "../../../src/rootd/firecracker/mod.ts";
import {
  type PortForwardInstaller,
  type ReclaimHook,
  SupervisorCore,
  type SupervisorLaunchPlanner,
} from "../../../src/rootd/supervisor_core.ts";
import {
  type SubnetAllocation,
  subnetForSlot,
} from "../../../src/rootd/network/allocator.ts";
import {
  PortForwardError,
  portForwardTableName,
} from "../../../src/rootd/network/port_forward.ts";
import {
  type SupervisorBridgeRequest,
  SupervisorError,
  type SupervisorLaunchRequest,
} from "../../../src/rootd/supervisor_core_api.ts";
import type {
  ArtifactReference,
  SandboxRecord,
  SandboxResources,
} from "../../../src/state/model.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";
import {
  BitmapSubnetAllocator,
  DnsmasqController,
  EgressController,
  NetworkController,
  NetworkReclaimHook,
} from "../../../src/rootd/network/mod.ts";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../src/rootd/network/apply.ts";

interface RecordedCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

/** Records every host command and always succeeds (the reclaim path never fails). */
class FakeRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];
  run(
    bin: string,
    args: readonly string[],
    stdin: string,
  ): Promise<EgressCommandResult> {
    this.calls.push({ bin, args: [...args], stdin });
    return Promise.resolve({ success: true, code: 0, stderr: "" });
  }
}

const EXIT: VmmExit = {
  code: 0,
  signal: null,
  observedVia: "child-status",
  stderrTail: "",
};

function launchRequest(
  sandboxId: string,
  executionId: string,
): SupervisorLaunchRequest {
  return {
    sandboxId,
    executionId,
    artifactId: "artifact-fixture",
    allocationId: "alloc-fixture",
    bootNonce: new Uint8Array(32),
    idempotencyKey: new Uint8Array(16),
  };
}

function bridgeRequest(
  sandboxId: string,
  executionId: string,
  expiresAtUnixMs = Date.now() + 10_000,
): SupervisorBridgeRequest {
  return {
    sandboxId,
    executionId,
    leaseId: "lease-fixture",
    leaseGeneration: 1,
    tunnelNonce: new Uint8Array(32),
    expiresAtUnixMs,
  };
}

const PLANNER: SupervisorLaunchPlanner = {
  resolve: () =>
    Promise.resolve({
      jailer: {
        jailerBin: "/usr/bin/jailer",
        firecrackerBin: "/usr/bin/firecracker",
        uid: 10_001,
        gid: 10_001,
        newPidNs: true,
      },
      stage: [{ hostPath: "/artifacts/kernel", jailPath: "/vmlinux" }],
      config: { boot_source: { kernel_image_path: "/vmlinux" } },
    }),
};

/**
 * A planner that journals the network resources a `slot`'s launch would (the
 * TAP + `/30` addresses), so `exposeHttp` can reconstruct the allocation from
 * `resources.tapName` exactly as the real dataplane path does (§9).
 */
function networkPlanner(slot: number): SupervisorLaunchPlanner {
  const alloc = subnetForSlot(slot);
  return {
    resolve: () =>
      Promise.resolve({
        jailer: {
          jailerBin: "/usr/bin/jailer",
          firecrackerBin: "/usr/bin/firecracker",
          uid: 10_001,
          gid: 10_001,
          newPidNs: true,
        },
        stage: [{ hostPath: "/artifacts/kernel", jailPath: "/vmlinux" }],
        config: { boot_source: { kernel_image_path: "/vmlinux" } },
        resources: {
          tapName: alloc.tapName,
          hostIp: alloc.hostIp,
          guestIp: alloc.guestIp,
          subnet: alloc.subnet,
        },
      }),
  };
}

/**
 * A fake port-forward installer that records `expose` / `reclaim` (§6). It
 * MODELS the full-table replace: each `expose` records the COMPLETE `forwards`
 * list it was handed (a snapshot), so a test can prove a later call carried
 * every forward, not just the newest one.
 */
class FakePortForward implements PortForwardInstaller {
  readonly exposeCalls: Array<{
    alloc: SubnetAllocation;
    sandboxId: string;
    forwards: ReadonlyArray<{ hostPort: number; guestPort: number }>;
  }> = [];
  readonly reclaimed: string[] = [];
  /** When set, `expose` rejects with it (a real nftables install failure). */
  exposeError?: Error;

  expose(
    alloc: SubnetAllocation,
    request: {
      readonly sandboxId: string;
      readonly forwards: readonly {
        readonly hostPort: number;
        readonly guestPort: number;
      }[];
    },
  ): Promise<string> {
    if (this.exposeError !== undefined) return Promise.reject(this.exposeError);
    this.exposeCalls.push({
      alloc,
      sandboxId: request.sandboxId,
      // Snapshot the full set as passed, so a later mutation cannot rewrite it.
      forwards: request.forwards.map((f) => ({
        hostPort: f.hostPort,
        guestPort: f.guestPort,
      })),
    });
    return Promise.resolve(portForwardTableName(request.sandboxId));
  }

  reclaim(sandboxId: string): Promise<void> {
    this.reclaimed.push(sandboxId);
    return Promise.resolve();
  }
}

class FakeMachine implements RuntimeMachine {
  readonly vmId: string;
  readonly pid = 4242;
  readonly state = "running" as const;
  readonly #exit = Promise.withResolvers<VmmExit>();
  readonly exited = this.#exit.promise;
  registry: VmRegistry | undefined;
  killCalls = 0;
  shutdownCalls = 0;
  disposed = false;

  constructor(vmId: string) {
    this.vmId = vmId;
  }

  readonly vsock = {
    connect: (): Promise<VsockConn> =>
      Promise.resolve({ close() {} } as unknown as VsockConn),
  };

  shutdown(): Promise<VmmExit> {
    this.shutdownCalls++;
    this.#exit.resolve(EXIT);
    return Promise.resolve(EXIT);
  }

  kill(): Promise<VmmExit> {
    this.killCalls++;
    const exit = { ...EXIT, code: null, signal: "SIGKILL" as const };
    this.#exit.resolve(exit);
    return Promise.resolve(exit);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
    // The real package reclaims files and removes the jail journal record
    // at disposal (not at shutdown/kill); mirror that contract.
    await this.registry?.remove(this.vmId);
  }
}

interface Harness {
  readonly core: SupervisorCore;
  readonly store: JsonFileSandboxStore;
  readonly machines: Map<string, FakeMachine>;
  launches: number;
}

/**
 * A runtime whose launch honors journal-before-spawn against the injected
 * registry, exactly like the real package: put the jail record, learn the
 * pid, hand back a machine whose disposal removes the record. Its
 * reconcile sweep reclaims every journaled record.
 */
function makeHarness(
  dir: string,
  overrides: {
    launch?: (options: MachineOptions) => Promise<RuntimeMachine>;
    reconcile?: (registry: VmRegistry) => Promise<ReconcileResult>;
    reclaimHooks?: readonly ReclaimHook[];
    store?: JsonFileSandboxStore;
    planner?: SupervisorLaunchPlanner;
    portForward?: PortForwardInstaller;
  } = {},
): Harness {
  const store = overrides.store ??
    new JsonFileSandboxStore(join(dir, "state.json"));
  const machines = new Map<string, FakeMachine>();
  const counter = { launches: 0 };
  const runtime: FirecrackerRuntime = {
    compatibility: { pinned: "v1.16.1", min: "v1.15.0" },
    launch: async (options) => {
      counter.launches++;
      if (overrides.launch !== undefined) {
        return await overrides.launch(options);
      }
      const vmId = options.jailer!.id;
      const registry = options.registry!;
      await registry.put(jailRecord(vmId, options.metadata));
      await registry.update(vmId, { pid: 4242 });
      const machine = new FakeMachine(vmId);
      machine.registry = registry;
      machines.set(vmId, machine);
      return machine;
    },
    reconcile: async (registry) => {
      if (overrides.reconcile !== undefined) {
        return await overrides.reconcile(registry);
      }
      const reclaimed: string[] = [];
      for (const record of await registry.list()) {
        await registry.remove(record.vmId);
        reclaimed.push(record.vmId);
      }
      return { reclaimed, stillRunning: [], failures: [] };
    },
  };
  const core = new SupervisorCore({
    store,
    planner: overrides.planner ?? PLANNER,
    runtime,
    ...(overrides.reclaimHooks === undefined
      ? {}
      : { reclaimHooks: overrides.reclaimHooks }),
    ...(overrides.portForward === undefined
      ? {}
      : { portForward: overrides.portForward }),
    buildId: "test-build",
  });
  return {
    core,
    store,
    machines,
    get launches() {
      return counter.launches;
    },
  };
}

function jailRecord(
  vmId: string,
  metadata: Readonly<Record<string, string>> | undefined,
): JailRecord {
  return {
    version: 1,
    vmId,
    pid: null,
    apiSocketPath: `/tmp/${vmId}.sock`,
    stateDir: `/tmp/${vmId}`,
    ownsStateDir: false,
    vsockListenerPaths: [],
    createdAt: new Date().toISOString(),
    ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
  };
}

async function withDir(
  operation: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "sbx-sup-" });
  try {
    await operation(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("launch journals before spawn and converges to ready", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    const status = await harness.core.launch(
      launchRequest("sbx-one", "exec-one"),
    );

    assertEquals(status, {
      sandboxId: "sbx-one",
      executionId: "exec-one",
      state: "running",
      pid: 4242,
    });
    const record = await harness.store.get("sbx-one");
    assertEquals(record?.phase, "ready");
    assertEquals(record?.machine?.executionId, "exec-one");
    assertEquals(record?.machine?.jailRecord?.pid, 4242);

    const observed = await harness.core.status("exec-one");
    assertEquals(observed.state, "running");
    assertEquals(observed.pid, 4242);

    const health = await harness.core.health();
    assertEquals(health.buildId, "test-build");
    assertEquals(health.activeMachines, 1);
    assertEquals(health.reconciling, false);

    await harness.core.probeAgent("exec-one");
    assertEquals((await harness.core.usage("exec-one")).cpuTimeMicros, 0);
  });
});

Deno.test("launch on a duplicate sandbox id is rejected before any spawn", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    await harness.core.launch(launchRequest("sbx-dup", "exec-first"));

    const error = await assertRejects(
      () => harness.core.launch(launchRequest("sbx-dup", "exec-second")),
      SupervisorError,
    );
    assertEquals(error.code, "SBX_SUP_DUPLICATE");
    assertEquals(harness.launches, 1);
    assertEquals((await harness.store.get("sbx-dup"))?.phase, "ready");
  });
});

Deno.test("launch validation failures never touch the journal", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    const error = await assertRejects(
      () => harness.core.launch(launchRequest("not-a-sandbox-id", "exec-x")),
      SupervisorError,
    );
    assertEquals(error.code, "SBX_SUP_VALIDATION");
    assertEquals(harness.launches, 0);
    assertEquals(await harness.store.list(), []);
  });
});

Deno.test("failed launch parks the record terminated with a bounded reason", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir, {
      launch: () => Promise.reject({ code: "FC_JAILER" }),
    });

    const error = await assertRejects(
      () => harness.core.launch(launchRequest("sbx-fail", "exec-fail")),
      FirecrackerAdapterError,
    );
    assertEquals(error.code, "SBX_FC_JAILER");
    const record = await harness.store.get("sbx-fail");
    assertEquals(record?.phase, "terminated");
    assert(record?.terminationReason?.startsWith("launch failed:"));
  });
});

Deno.test("incomplete launch cleanup quarantines the record", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir, {
      launch: () => Promise.reject({ code: "FC_API", status: 400 }),
      reconcile: () =>
        Promise.resolve({
          reclaimed: [],
          stillRunning: [],
          failures: [{ vmId: "exec-leak", error: new Error("busy") }],
        }),
    });

    const error = await assertRejects(
      () => harness.core.launch(launchRequest("sbx-leak", "exec-leak")),
      FirecrackerAdapterError,
    );
    assertEquals(error.code, "SBX_FC_CLEANUP");
    assertEquals((await harness.store.get("sbx-leak"))?.phase, "quarantined");
  });
});

Deno.test("openBridge refuses unknown executions and non-ready sandboxes", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    await harness.core.launch(launchRequest("sbx-gate", "exec-gate"));

    const unknown = await assertRejects(
      () => harness.core.openBridge(bridgeRequest("sbx-gate", "exec-other")),
      SupervisorError,
    );
    assertEquals(unknown.code, "SBX_SUP_NOT_FOUND");

    const record = await harness.store.get("sbx-gate");
    await harness.store.compareAndSwap(
      "sbx-gate",
      record!.revision,
      (current) => ({ ...current, phase: "terminating" }),
    );
    const gated = await assertRejects(
      () => harness.core.openBridge(bridgeRequest("sbx-gate", "exec-gate")),
      SupervisorError,
    );
    assertEquals(gated.code, "SBX_SUP_STATE");
  });
});

Deno.test("openBridge issues a validated one-shot grant, no dialing", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    await harness.core.launch(launchRequest("sbx-br", "exec-br"));
    const expiresAtUnixMs = Date.now() + 10_000;

    const grant = await harness.core.openBridge(
      bridgeRequest("sbx-br", "exec-br", expiresAtUnixMs),
    );
    assertEquals(grant.socketPath, `/run/studiobox/b/${grant.bridgeId}`);
    assertEquals(grant.bridgeCredential.byteLength, 32);
    assertEquals(grant.agentCredential.byteLength, 32);
    assertEquals(grant.expiresAtUnixMs, expiresAtUnixMs);
    assertEquals((await harness.core.health()).activeBridges, 1);

    const taken = harness.core.takeBridgeGrant(grant.bridgeId);
    assertEquals(taken.bridgeId, grant.bridgeId);
    const reused = assertThrows(
      () => harness.core.takeBridgeGrant(grant.bridgeId),
      SupervisorError,
    );
    assertEquals(reused.code, "SBX_SUP_STATE");

    const spoofed = await assertRejects(
      () => harness.core.openBridge(bridgeRequest("sbx-nope", "exec-br")),
      SupervisorError,
    );
    assertEquals(spoofed.code, "SBX_SUP_STATE");
  });
});

Deno.test("openBridge returns the launch-scoped agentCredential the guest baked", async () => {
  await withDir(async (dir) => {
    // A planner that bakes a KNOWN per-launch credential (the studiobox.token
    // bytes) — the guest expects exactly these, so openBridge must return them
    // (not a fresh random) for the client to authenticate to studioboxd.
    const baked = new Uint8Array(32).fill(0xa7);
    const planner: SupervisorLaunchPlanner = {
      resolve: async (request) => ({
        ...(await PLANNER.resolve(request)),
        agentCredential: baked.slice(),
      }),
    };
    const harness = makeHarness(dir, { planner });
    await harness.core.launch(launchRequest("sbx-cred", "exec-cred"));

    const first = await harness.core.openBridge(
      bridgeRequest("sbx-cred", "exec-cred", Date.now() + 10_000),
    );
    assertEquals(first.agentCredential, baked, "grant returns the baked token");
    // Launch-scoped + stable: a second bridge for the same execution returns the
    // SAME credential (so hostd's eager reserve and the client's dial agree).
    const second = await harness.core.openBridge(
      bridgeRequest("sbx-cred", "exec-cred", Date.now() + 10_000),
    );
    assertEquals(
      second.agentCredential,
      baked,
      "credential is stable per launch",
    );

    // On terminate the credential is forgotten with the execution.
    await harness.core.kill("exec-cred");
    assertEquals(
      (await harness.core.status("exec-cred")).state,
      "exited",
    );
  });
});

Deno.test("kill escalates via the adapter and reclaims the journal", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    await harness.core.launch(launchRequest("sbx-kill", "exec-kill"));
    const machine = harness.machines.get("exec-kill")!;

    await harness.core.kill("exec-kill");

    assertEquals(machine.killCalls, 1);
    assertEquals(machine.disposed, true);
    const record = await harness.store.get("sbx-kill");
    assertEquals(record?.phase, "terminated");
    assertEquals(record?.terminationReason, "kill");
    assertEquals(record?.machine?.jailRecord, undefined);
    assertEquals((await harness.core.status("exec-kill")).state, "exited");

    const repeat = await assertRejects(
      () => harness.core.kill("exec-kill"),
      SupervisorError,
    );
    assertEquals(repeat.code, "SBX_SUP_STATE");
  });
});

Deno.test("shutdown stops gracefully and terminates the record", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    await harness.core.launch(launchRequest("sbx-stop", "exec-stop"));
    const machine = harness.machines.get("exec-stop")!;

    await harness.core.shutdown("exec-stop");

    assertEquals(machine.shutdownCalls, 1);
    assertEquals(machine.disposed, true);
    const record = await harness.store.get("sbx-stop");
    assertEquals(record?.phase, "terminated");
    assertEquals(record?.terminationReason, "shutdown");
  });
});

Deno.test("restart reconcile converges every record to terminated(host-restart)", async () => {
  await withDir(async (dir) => {
    const before = makeHarness(dir);
    await before.core.launch(launchRequest("sbx-ra", "exec-ra"));
    await before.core.launch(launchRequest("sbx-rb", "exec-rb"));

    // A fresh core over the same journal models the post-crash restart.
    const after = makeHarness(dir, { store: before.store });
    const summary = await after.core.reconcile();

    assertEquals(summary.examined, 2);
    assertEquals(summary.killed, 2);
    assertEquals(summary.reclaimed, 2);
    assertEquals(summary.quarantined, 0);
    assertEquals(summary.failures, []);
    for (const record of await after.store.list()) {
      assertEquals(record.phase, "terminated");
      assertEquals(record.terminationReason, "host-restart");
      assertEquals(record.machine?.jailRecord, undefined);
    }

    // The pre-crash execution can never CAS over the converged journal.
    const registry = new CreateOnlyVmRegistry(
      new SandboxStateJailRecordStore(after.store),
    );
    await assertRejects(
      () => registry.update("exec-ra", { pid: 99999 }),
      StaleExecutionIdError,
    );

    const again = await after.core.reconcile();
    assertEquals(again, {
      examined: 0,
      killed: 0,
      reclaimed: 0,
      quarantined: 0,
      failures: [],
    });
  });
});

Deno.test("a throwing reclaim hook parks the record in quarantined", async () => {
  await withDir(async (dir) => {
    const before = makeHarness(dir);
    await before.core.launch(launchRequest("sbx-q", "exec-q"));

    const after = makeHarness(dir, {
      store: before.store,
      reclaimHooks: [{
        name: "tap-reclaimer",
        reclaim: () => Promise.reject(new Error("tap0 refuses to die")),
      }],
    });
    const summary = await after.core.reconcile();

    assertEquals(summary.examined, 1);
    assertEquals(summary.quarantined, 1);
    assertEquals(summary.reclaimed, 0);
    assertEquals(summary.failures.length, 1);
    assertEquals(summary.failures[0]?.sandboxId, "sbx-q");
    const record = await after.store.get("sbx-q");
    assertEquals(record?.phase, "quarantined");
    assert(record?.terminationReason?.includes("tap-reclaimer"));
    assert(record?.terminationReason?.includes("tap0 refuses to die"));

    // Quarantine is terminal for reconcile: the next sweep skips it.
    const again = await after.core.reconcile();
    assertEquals(again.examined, 0);
  });
});

/**
 * A harness whose launch parks awaiting boot readiness AFTER the jail
 * record is journaled and the VMM pid is known — the exact window the
 * reconcile/launch races (scratchpad repro_reconcile_race{,2}.ts) hit.
 */
function makeGatedLaunchHarness(dir: string): {
  harness: Harness;
  gate: PromiseWithResolvers<void>;
  machines: Map<string, FakeMachine>;
} {
  const gate = Promise.withResolvers<void>();
  const machines = new Map<string, FakeMachine>();
  const harness = makeHarness(dir, {
    launch: async (options) => {
      const vmId = options.jailer!.id;
      const registry = options.registry!;
      await registry.put(jailRecord(vmId, options.metadata));
      await registry.update(vmId, { pid: 4242 });
      await gate.promise; // parked awaiting boot readiness
      const machine = new FakeMachine(vmId);
      machine.registry = registry;
      machines.set(vmId, machine);
      return machine;
    },
  });
  return { harness, gate, machines };
}

async function waitForRecord(
  store: JsonFileSandboxStore,
  sandboxId: string,
  description: string,
  predicate: (record: SandboxRecord) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const record = await store.get(sandboxId);
    if (record !== null && predicate(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`sandbox ${sandboxId} never reached ${description}`);
}

/** The gated launch is parked: booting journaled, jail pid known. */
function parkedAtReadiness(record: SandboxRecord): boolean {
  return record.phase === "booting" &&
    record.machine?.jailRecord?.pid === 4242;
}

// Regression: scratchpad repro_reconcile_race.ts — a sweep accepted
// mid-launch SIGKILLed the launching execution's VMM and reclaimed its
// jail out from under the launch.
Deno.test("reconcile fails fast with a typed error while a launch is in flight", async () => {
  await withDir(async (dir) => {
    const { harness, gate } = makeGatedLaunchHarness(dir);
    const launchPromise = harness.core.launch(
      launchRequest("sbx-race", "exec-race"),
    );
    launchPromise.catch(() => {});
    await waitForRecord(harness.store, "sbx-race", "parked", parkedAtReadiness);

    const rejected = await assertRejects(
      () => harness.core.reconcile(),
      SupervisorError,
    );
    assertEquals(rejected.code, "SBX_SUP_UNAVAILABLE");
    assert(rejected.message.includes("launch exec-race"));
    // The refused sweep never touched the in-flight record or its jail.
    const midFlight = await harness.store.get("sbx-race");
    assertEquals(midFlight?.phase, "booting");
    assertEquals(midFlight?.machine?.jailRecord?.pid, 4242);

    gate.resolve();
    assertEquals((await launchPromise).state, "running");
    assertEquals((await harness.store.get("sbx-race"))?.phase, "ready");
    assertEquals((await harness.core.health()).activeMachines, 1);

    // Once the launch settles, the (destructive) sweep runs normally.
    const summary = await harness.core.reconcile();
    assertEquals(summary.examined, 1);
    assertEquals((await harness.store.get("sbx-race"))?.phase, "terminated");
  });
});

Deno.test("reconcile fails fast while a kill is in flight", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    await harness.core.launch(launchRequest("sbx-k", "exec-k"));
    const machine = harness.machines.get("exec-k")!;
    const killGate = Promise.withResolvers<void>();
    const realKill = machine.kill.bind(machine);
    machine.kill = async () => {
      await killGate.promise;
      return await realKill();
    };
    const killPromise = harness.core.kill("exec-k");
    killPromise.catch(() => {});
    await waitForRecord(
      harness.store,
      "sbx-k",
      "terminating",
      (record) => record.phase === "terminating",
    );

    const rejected = await assertRejects(
      () => harness.core.reconcile(),
      SupervisorError,
    );
    assertEquals(rejected.code, "SBX_SUP_UNAVAILABLE");
    assert(rejected.message.includes("kill exec-k"));

    killGate.resolve();
    await killPromise;
    assertEquals((await harness.store.get("sbx-k"))?.phase, "terminated");
  });
});

// Regression: scratchpad repro_reconcile_race2.ts — the launch's
// phase-blind retry rewrote a record another writer had already
// converged (last-writer-wins) and left a phantom machine tracked.
Deno.test("a launch that lost its record to a converged sweep aborts stale and never clobbers", async () => {
  await withDir(async (dir) => {
    const { harness, gate, machines } = makeGatedLaunchHarness(dir);
    const launchPromise = harness.core.launch(
      launchRequest("sbx-lost", "exec-lost"),
    );
    launchPromise.catch(() => {});
    await waitForRecord(harness.store, "sbx-lost", "parked", parkedAtReadiness);

    // Another journal writer (a replacement supervisor's restart sweep)
    // converges the record while this launch still awaits readiness.
    const converged = await harness.store.compareAndSwap(
      "sbx-lost",
      (await harness.store.get("sbx-lost"))!.revision,
      (current) => ({
        ...current,
        phase: "terminated",
        terminationReason: "host-restart",
      }),
    );

    gate.resolve();
    const rejected = await assertRejects(
      () => launchPromise,
      SupervisorError,
    );
    assertEquals(rejected.code, "SBX_SUP_STALE");

    // The loser did NOT win: the converged phase and reason survive.
    const record = await harness.store.get("sbx-lost");
    assertEquals(record?.phase, "terminated");
    assertEquals(record?.terminationReason, "host-restart");
    assert(record!.revision >= converged.revision);

    // The doomed VMM was put down instead of becoming a phantom.
    const machine = machines.get("exec-lost")!;
    assertEquals(machine.killCalls, 1);
    assertEquals(machine.disposed, true);
    assertEquals((await harness.core.health()).activeMachines, 0);
    assertEquals((await harness.core.status("exec-lost")).state, "exited");
  });
});

Deno.test("a launch that lost its record to a newer execution leaves the winner alone", async () => {
  await withDir(async (dir) => {
    const { harness, gate, machines } = makeGatedLaunchHarness(dir);
    const launchPromise = harness.core.launch(
      launchRequest("sbx-claim", "exec-old"),
    );
    launchPromise.catch(() => {});
    await waitForRecord(
      harness.store,
      "sbx-claim",
      "parked",
      parkedAtReadiness,
    );

    const claimed = await harness.store.compareAndSwap(
      "sbx-claim",
      (await harness.store.get("sbx-claim"))!.revision,
      (current) => ({
        ...current,
        machine: {
          executionId: "exec-winner",
          phase: "launching",
          updatedAt: new Date().toISOString(),
        },
      }),
    );

    gate.resolve();
    const rejected = await assertRejects(
      () => launchPromise,
      SupervisorError,
    );
    assertEquals(rejected.code, "SBX_SUP_STALE");

    // The winner's claim is byte-for-byte untouched (not even a retry
    // wrote through): same revision, same owner, same phase.
    const record = await harness.store.get("sbx-claim");
    assertEquals(record?.revision, claimed.revision);
    assertEquals(record?.phase, "booting");
    assertEquals(record?.machine?.executionId, "exec-winner");
    const machine = machines.get("exec-old")!;
    assertEquals(machine.killCalls, 1);
    assertEquals(machine.disposed, true);
    assertEquals((await harness.core.health()).activeMachines, 0);
  });
});

const PLAN_ARTIFACT: ArtifactReference = {
  manifestHash: "a1".repeat(32),
  arch: "aarch64",
};

const ARTIFACT_PLANNER: SupervisorLaunchPlanner = {
  resolve: async (request) => ({
    ...(await PLANNER.resolve(request)),
    artifact: PLAN_ARTIFACT,
  }),
};

Deno.test("launch journals the plan's artifact reference before any spawn", async () => {
  await withDir(async (dir) => {
    const atSpawn: Array<
      { phase?: string; artifact?: ArtifactReference }
    > = [];
    const harness: Harness = makeHarness(dir, {
      planner: ARTIFACT_PLANNER,
      launch: async (options) => {
        const record = await harness.store.get("sbx-art");
        atSpawn.push({
          ...(record?.phase === undefined ? {} : { phase: record.phase }),
          ...(record?.artifact === undefined
            ? {}
            : { artifact: record.artifact }),
        });
        const vmId = options.jailer!.id;
        const registry = options.registry!;
        await registry.put(jailRecord(vmId, options.metadata));
        await registry.update(vmId, { pid: 4242 });
        const machine = new FakeMachine(vmId);
        machine.registry = registry;
        harness.machines.set(vmId, machine);
        return machine;
      },
    });

    await harness.core.launch(launchRequest("sbx-art", "exec-art"));

    // The reference was durable BEFORE the spawn started.
    assertEquals(atSpawn, [{ phase: "booting", artifact: PLAN_ARTIFACT }]);
    const record = await harness.store.get("sbx-art");
    assertEquals(record?.schemaVersion, 2);
    assertEquals(record?.artifact, PLAN_ARTIFACT);

    // Termination releases the reference by phase, not by erasing it.
    await harness.core.shutdown("exec-art");
    const terminated = await harness.store.get("sbx-art");
    assertEquals(terminated?.phase, "terminated");
    assertEquals(terminated?.artifact, PLAN_ARTIFACT);
  });
});

const PLAN_RESOURCES: Partial<SandboxResources> = {
  tapName: "sbxtap7",
  hostIp: "10.201.0.29",
  guestIp: "10.201.0.30",
  subnet: "10.201.0.28/30",
  dnsmasqPidfile: "/run/studiobox/dns/7.pid",
};

const RESOURCES_PLANNER: SupervisorLaunchPlanner = {
  resolve: async (request) => ({
    ...(await PLANNER.resolve(request)),
    resources: PLAN_RESOURCES,
  }),
};

Deno.test("launch merges the plan's network resources onto the record before spawn", async () => {
  await withDir(async (dir) => {
    const atSpawn: Array<
      { phase?: string; resources?: SandboxResources }
    > = [];
    const harness: Harness = makeHarness(dir, {
      planner: RESOURCES_PLANNER,
      launch: async (options) => {
        const record = await harness.store.get("sbx-res");
        atSpawn.push({
          ...(record?.phase === undefined ? {} : { phase: record.phase }),
          ...(record?.resources === undefined
            ? {}
            : { resources: record.resources }),
        });
        const vmId = options.jailer!.id;
        const registry = options.registry!;
        await registry.put(jailRecord(vmId, options.metadata));
        await registry.update(vmId, { pid: 4242 });
        const machine = new FakeMachine(vmId);
        machine.registry = registry;
        harness.machines.set(vmId, machine);
        return machine;
      },
    });

    await harness.core.launch(launchRequest("sbx-res", "exec-res"));

    // The network resources were durable at booting, BEFORE the spawn — and the
    // default exposedPorts: [] survived the partial (network-only) merge.
    const expected = { ...PLAN_RESOURCES, exposedPorts: [] };
    assertEquals(atSpawn, [{ phase: "booting", resources: expected }]);
    const record = await harness.store.get("sbx-res");
    assertEquals(record?.resources, expected);

    // The journaled resources survive termination (reclaim keys off them).
    await harness.core.shutdown("exec-res");
    assertEquals((await harness.store.get("sbx-res"))?.resources, expected);
  });
});

Deno.test("a failed launch reclaims the journaled dataplane before parking terminal", async () => {
  await withDir(async (dir) => {
    // The plan journals slot-7 network resources in the staging→booting commit;
    // the spawn then dies. A TERMINAL record is excluded from #reconcileSweep, so
    // the record must NOT go terminal until the NetworkReclaimHook has reaped the
    // TAP + released the slot — otherwise the whole dataplane leaks forever.
    const networkRunner = new FakeRunner();
    const egressRunner = new FakeRunner();
    const allocator = new BitmapSubnetAllocator();
    allocator.reserve(7); // the slot the plan journaled (sbxtap7)
    const networkReclaimHook = new NetworkReclaimHook({
      allocator,
      network: new NetworkController({ runner: networkRunner }),
      dnsmasq: new DnsmasqController({
        reader: { read: () => Promise.reject(new Error("pidfile gone")) },
        remover: { remove: () => Promise.resolve() },
        signaller: { signal: () => {} },
      }),
      egress: new EgressController({ runner: egressRunner }),
    });

    const harness = makeHarness(dir, {
      planner: RESOURCES_PLANNER,
      launch: () => Promise.reject({ code: "FC_JAILER" }),
      reclaimHooks: [networkReclaimHook],
    });

    await assertRejects(
      () => harness.core.launch(launchRequest("sbx-leak", "exec-leak")),
      FirecrackerAdapterError,
    );

    // The record parked terminal — but ONLY after the dataplane was reclaimed.
    const record = await harness.store.get("sbx-leak");
    assertEquals(record?.phase, "terminated");
    // TAP torn down (ip link del), slot released, egress table removed by name.
    assertEquals(networkRunner.calls.at(-1)?.args, [
      "link",
      "del",
      "dev",
      "sbxtap7",
    ]);
    assertEquals(allocator.inUse, 0, "slot released — no leak");
    assertEquals(
      egressRunner.calls.length,
      1,
      "egress table reclaimed by name",
    );
  });
});

Deno.test("a failed launch whose reclaim hook throws quarantines instead of terminating", async () => {
  await withDir(async (dir) => {
    // The dataplane leak is real (the hook could not reap it), so the failure
    // must be SURFACED as quarantined — not silently swallowed into terminated.
    const harness = makeHarness(dir, {
      planner: RESOURCES_PLANNER,
      launch: () => Promise.reject({ code: "FC_JAILER" }),
      reclaimHooks: [{
        name: "tap-reclaimer",
        reclaim: () => Promise.reject(new Error("sbxtap7 refuses to die")),
      }],
    });

    await assertRejects(
      () => harness.core.launch(launchRequest("sbx-stuck", "exec-stuck")),
      FirecrackerAdapterError,
    );

    const record = await harness.store.get("sbx-stuck");
    assertEquals(record?.phase, "quarantined");
    assert(record?.terminationReason?.includes("tap-reclaimer"));
    assert(record?.terminationReason?.includes("sbxtap7 refuses to die"));
  });
});

Deno.test("a spawn that dies still leaves the artifact reference journaled", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir, {
      planner: ARTIFACT_PLANNER,
      launch: () => Promise.reject({ code: "FC_JAILER" }),
    });
    await assertRejects(
      () => harness.core.launch(launchRequest("sbx-dead", "exec-dead")),
      FirecrackerAdapterError,
    );
    const record = await harness.store.get("sbx-dead");
    assertEquals(record?.phase, "terminated");
    assertEquals(record?.artifact, PLAN_ARTIFACT);
  });
});

Deno.test("health and ping are trivial", async () => {
  await withDir(async (dir) => {
    const harness = makeHarness(dir);
    assertEquals(await harness.core.ping(0n), 0n);
    assertEquals(await harness.core.ping(7n), 7n);
    // A full-width UInt64 nonce survives (no JS-number truncation above 2^53).
    assertEquals(
      await harness.core.ping(0xffff_ffff_ffff_ffffn),
      0xffff_ffff_ffff_ffffn,
    );
    const invalid = await assertRejects(
      () => harness.core.ping(-1n),
      SupervisorError,
    );
    assertEquals(invalid.code, "SBX_SUP_VALIDATION");

    const health = await harness.core.health();
    assertEquals(health.buildId, "test-build");
    assertEquals(health.activeMachines, 0);
    assertEquals(health.activeBridges, 0);
    assertEquals(health.reconciling, false);
    assert(Number.isSafeInteger(health.startedAtUnixMs));
  });
});

Deno.test("exposeHttp installs the forward with the reconstructed alloc and journals exposedPorts", async () => {
  await withDir(async (dir) => {
    const portForward = new FakePortForward();
    const harness = makeHarness(dir, {
      planner: networkPlanner(7),
      portForward,
    });
    await harness.core.launch(launchRequest("sbx-xp", "exec-xp"));

    await harness.core.exposeHttp("exec-xp", 8080, 40_100);

    // The forward was installed with the allocation reconstructed from the
    // journaled TAP slot (guestIp/hostIp come from the allocator, §12) and the
    // hostd-leased host port. The first install carries just the one forward.
    assertEquals(portForward.exposeCalls.length, 1);
    const call = portForward.exposeCalls[0];
    const alloc = subnetForSlot(7);
    assertEquals(call.sandboxId, "sbx-xp");
    assertEquals(call.forwards, [{ hostPort: 40_100, guestPort: 8080 }]);
    assertEquals(call.alloc.guestIp, alloc.guestIp);
    assertEquals(call.alloc.hostIp, alloc.hostIp);
    assertEquals(call.alloc.tapName, "sbxtap7");

    // The forward is journaled so a cold reconcile reaps it from the journal.
    const record = await harness.store.get("sbx-xp");
    assertEquals(record?.resources.exposedPorts, [
      { hostPort: 40_100, guestPort: 8080 },
    ]);

    // A second exposeHttp appends a distinct forward; a repeat host port dedupes.
    await harness.core.exposeHttp("exec-xp", 9090, 40_101);
    const after = await harness.store.get("sbx-xp");
    assertEquals(after?.resources.exposedPorts, [
      { hostPort: 40_100, guestPort: 8080 },
      { hostPort: 40_101, guestPort: 9090 },
    ]);
    // The 2nd install re-materialized the COMPLETE table: BOTH forwards, so the
    // first forward's DNAT is not wiped by the replace.
    assertEquals(portForward.exposeCalls.length, 2);
    assertEquals(portForward.exposeCalls[1].forwards, [
      { hostPort: 40_100, guestPort: 8080 },
      { hostPort: 40_101, guestPort: 9090 },
    ]);

    await harness.core.exposeHttp("exec-xp", 8080, 40_100);
    const deduped = await harness.store.get("sbx-xp");
    assertEquals(deduped?.resources.exposedPorts.length, 2);
    // A repeat lease re-installs the same full set (no duplicate rule).
    assertEquals(portForward.exposeCalls.length, 3);
    assertEquals(portForward.exposeCalls[2].forwards, [
      { hostPort: 40_100, guestPort: 8080 },
      { hostPort: 40_101, guestPort: 9090 },
    ]);
    // Nothing was reclaimed on any success path.
    assertEquals(portForward.reclaimed, []);
  });
});

Deno.test("exposeHttp re-materializes the full forward table so a 2nd port never wipes the 1st", async () => {
  await withDir(async (dir) => {
    const portForward = new FakePortForward();
    const harness = makeHarness(dir, {
      planner: networkPlanner(4),
      portForward,
    });
    await harness.core.launch(launchRequest("sbx-mp", "exec-mp"));

    // Two exposeHttp calls on the SAME sandbox (distinct host ports).
    await harness.core.exposeHttp("exec-mp", 8080, 40_100);
    await harness.core.exposeHttp("exec-mp", 9090, 40_101);

    // The KEY regression guard: the 2nd install() was called with BOTH forwards
    // (so both DNAT rules are present), not just the newest — the full-table
    // replace never destroys the prior forward.
    assertEquals(portForward.exposeCalls.length, 2);
    assertEquals(portForward.exposeCalls[0].forwards, [
      { hostPort: 40_100, guestPort: 8080 },
    ]);
    assertEquals(portForward.exposeCalls[1].forwards, [
      { hostPort: 40_100, guestPort: 8080 },
      { hostPort: 40_101, guestPort: 9090 },
    ]);

    // And the journal lists both, so a cold reconcile reaps the whole table.
    const record = await harness.store.get("sbx-mp");
    assertEquals(record?.resources.exposedPorts, [
      { hostPort: 40_100, guestPort: 8080 },
      { hostPort: 40_101, guestPort: 9090 },
    ]);
  });
});

Deno.test("exposeHttp serializes concurrent calls on the same sandbox (no lost forward)", async () => {
  await withDir(async (dir) => {
    const portForward = new FakePortForward();
    const harness = makeHarness(dir, {
      planner: networkPlanner(4),
      portForward,
    });
    await harness.core.launch(launchRequest("sbx-cc", "exec-cc"));

    // Fire both exposeHttp CONCURRENTLY. The per-execution lock serializes them,
    // so the second install re-materializes BOTH forwards; without it, both read
    // an empty snapshot and the later atomic install wipes the earlier's DNAT.
    await Promise.all([
      harness.core.exposeHttp("exec-cc", 8080, 40_100),
      harness.core.exposeHttp("exec-cc", 9090, 40_101),
    ]);

    assertEquals(portForward.exposeCalls.length, 2);
    // The LAST install carries both forwards — the live table holds both DNATs.
    const last = portForward.exposeCalls[portForward.exposeCalls.length - 1];
    assertEquals(
      last.forwards.map((f) => f.hostPort).sort(),
      [40_100, 40_101],
    );
    const record = await harness.store.get("sbx-cc");
    assertEquals(record?.resources.exposedPorts.length, 2);
  });
});

Deno.test("exposeHttp on a netless / not-network-provisioned sandbox fails failedPrecondition", async () => {
  await withDir(async (dir) => {
    const portForward = new FakePortForward();
    // The default PLANNER journals NO network resources (a netless / vsock-only
    // launch), so the record is ready + live but has no TAP to expose against.
    const harness = makeHarness(dir, { portForward });
    await harness.core.launch(launchRequest("sbx-nl", "exec-nl"));

    const error = await assertRejects(
      () => harness.core.exposeHttp("exec-nl", 8080, 40_100),
      SupervisorError,
    );
    assertEquals(error.code, "SBX_SUP_STATE");
    // Nothing was installed or journaled.
    assertEquals(portForward.exposeCalls, []);
    const record = await harness.store.get("sbx-nl");
    assertEquals(record?.resources.exposedPorts, []);
  });
});

Deno.test("exposeHttp with no dataplane configured fails unavailable", async () => {
  await withDir(async (dir) => {
    // No portForward option ⇒ no dataplane: exposeHttp cannot install anything.
    const harness = makeHarness(dir, { planner: networkPlanner(3) });
    await harness.core.launch(launchRequest("sbx-nd", "exec-nd"));
    const error = await assertRejects(
      () => harness.core.exposeHttp("exec-nd", 8080, 40_100),
      SupervisorError,
    );
    assertEquals(error.code, "SBX_SUP_UNAVAILABLE");
  });
});

Deno.test("exposeHttp surfaces a PortForwardError and journals nothing", async () => {
  await withDir(async (dir) => {
    const portForward = new FakePortForward();
    portForward.exposeError = new PortForwardError("nft install failed");
    const harness = makeHarness(dir, {
      planner: networkPlanner(9),
      portForward,
    });
    await harness.core.launch(launchRequest("sbx-pe", "exec-pe"));

    const error = await assertRejects(
      () => harness.core.exposeHttp("exec-pe", 8080, 40_100),
      SupervisorError,
    );
    // A failed nftables install is surfaced (not swallowed); an atomic install
    // leaves nothing behind, so nothing is journaled.
    assertEquals(error.code, "SBX_SUP_STATE");
    const record = await harness.store.get("sbx-pe");
    assertEquals(record?.resources.exposedPorts, []);
  });
});
