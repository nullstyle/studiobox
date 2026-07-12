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
  type ReclaimHook,
  SupervisorCore,
  type SupervisorLaunchPlanner,
} from "../../../src/rootd/supervisor_core.ts";
import {
  type SupervisorBridgeRequest,
  SupervisorError,
  type SupervisorLaunchRequest,
} from "../../../src/rootd/supervisor_core_api.ts";
import type {
  ArtifactReference,
  SandboxRecord,
} from "../../../src/state/model.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";

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
