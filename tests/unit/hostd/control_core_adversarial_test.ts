// ADVERSARIAL re-break of the three M6 control-core lifecycle defects.
// Fix nothing: these drive HostControlCore directly and attack every
// interleaving of revokeAll vs create, every attach-to-dead-sandbox variant,
// and every post-reserve factory/launch throw. A green run == the defect is
// truly closed; a red run carries the repro.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type CreateSandboxInput,
  HostControlCore,
  HostControlError,
} from "../../../src/hostd/control_core.ts";
import { CapacityLedger } from "../../../src/hostd/capacity.ts";
import type { Clock, ClockTimer } from "../../../src/hostd/leases.ts";
import type { RootdGateway } from "../../../src/hostd/supervisor_client.ts";
import type {
  SupervisorLaunchRequest,
  SupervisorMachineStatus,
  SupervisorMachineUsage,
  SupervisorReconcileSummary,
} from "../../../src/rootd/supervisor_core_api.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<
    number,
    { fireAt: number; callback: () => void }
  >();

  constructor(startUnixMs = 1_000_000) {
    this.#now = startUnixMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fireAtUnixMs: number, callback: () => void): ClockTimer {
    const token = this.#seq++;
    this.#timers.set(token, { fireAt: fireAtUnixMs, callback });
    return { cancel: () => void this.#timers.delete(token) };
  }

  /** Count of live (uncancelled, unfired) timers — a leak seam. */
  get liveTimers(): number {
    return this.#timers.size;
  }

  advance(deltaMs: number): void {
    const target = this.#now + deltaMs;
    for (;;) {
      let nextToken: number | undefined;
      let nextFireAt = Infinity;
      for (const [token, timer] of this.#timers) {
        if (timer.fireAt <= target && timer.fireAt < nextFireAt) {
          nextFireAt = timer.fireAt;
          nextToken = token;
        }
      }
      if (nextToken === undefined) break;
      const timer = this.#timers.get(nextToken)!;
      this.#timers.delete(nextToken);
      this.#now = Math.max(this.#now, timer.fireAt);
      timer.callback();
    }
    this.#now = target;
  }
}

class FakeGateway implements RootdGateway {
  readonly launched: SupervisorLaunchRequest[] = [];
  readonly killed: string[] = [];
  onLaunch?: (request: SupervisorLaunchRequest) => Promise<void> | void;
  /** When set, launch() rejects with this after recording + onLaunch. */
  launchThrows?: Error;

  async launch(
    request: SupervisorLaunchRequest,
  ): Promise<SupervisorMachineStatus> {
    this.launched.push(request);
    if (this.onLaunch !== undefined) await this.onLaunch(request);
    if (this.launchThrows !== undefined) throw this.launchThrows;
    return {
      sandboxId: request.sandboxId,
      executionId: request.executionId,
      state: "running",
      pid: 1234,
    };
  }

  status(executionId: string): Promise<SupervisorMachineStatus> {
    return Promise.resolve({
      sandboxId: "sbx-loc-x",
      executionId,
      state: "running",
    });
  }

  usage(_executionId: string): Promise<SupervisorMachineUsage> {
    return Promise.resolve({
      cpuTimeMicros: 0,
      memoryCurrentBytes: 0,
      memoryPeakBytes: 0,
      diskBytes: 0,
      rxBytes: 0,
      txBytes: 0,
    });
  }

  kill(executionId: string): Promise<void> {
    this.killed.push(executionId);
    return Promise.resolve();
  }

  exposeHttp(): Promise<void> {
    return Promise.resolve();
  }

  openBridge(): Promise<never> {
    return Promise.reject(new Error("fake gateway does not open bridges"));
  }

  reconcile(): Promise<SupervisorReconcileSummary> {
    return Promise.resolve({
      examined: 0,
      killed: 0,
      reclaimed: 0,
      quarantined: 0,
      failures: [],
    });
  }

  ping(nonce: bigint): Promise<bigint> {
    return Promise.resolve(nonce);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Ctx {
  readonly core: HostControlCore;
  readonly gateway: FakeGateway;
  readonly clock: FakeClock;
  readonly capacity: CapacityLedger;
  /** Arm a one-shot gate INSIDE reserve()'s critical section. */
  gateReserve(): { reached: Promise<void>; release: () => void };
}

function makeCore(
  options: {
    idFactory?: () => string;
    bootNonceFactory?: () => Uint8Array;
    secretFactory?: () => Uint8Array;
    gateway?: FakeGateway;
  } = {},
): Ctx {
  const gateway = options.gateway ?? new FakeGateway();
  const clock = new FakeClock();

  // Controllable admission barrier: each reserve() awaits whatever the current
  // `barrier` resolves to. Default no-op; a test can swap in a gate.
  let barrier: () => Promise<void> | void = () => {};
  const capacity = new CapacityLedger({
    admissionBarrier: () => barrier(),
  });

  let counter = 0;
  const core = new HostControlCore({
    gateway,
    clock,
    capacity,
    idFactory: options.idFactory ?? (() => `0000000000000000000${counter++}`),
    bootNonceFactory: options.bootNonceFactory ?? (() => new Uint8Array(32)),
    ...(options.secretFactory === undefined
      ? {}
      : { secretFactory: options.secretFactory }),
  });

  const gateReserve = () => {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    barrier = () => {
      barrier = () => {}; // one-shot
      reached.resolve();
      return gate.promise;
    };
    return { reached: reached.promise, release: () => gate.resolve() };
  };

  return { core, gateway, clock, capacity, gateReserve };
}

function durationInput(memoryMiB = 1024): CreateSandboxInput {
  return {
    timeout: { kind: "duration", durationMs: 60_000 },
    memoryMiB,
    region: "loc",
    labels: [],
    idempotencyKey: new Uint8Array(16),
  };
}

function assertNoCommitted(capacity: CapacityLedger, note: string): void {
  const c = capacity.capacity();
  assertEquals(c.sandboxCount, 0, `${note}: sandboxCount`);
  assertEquals(c.memoryCommittedMiB, 0, `${note}: memoryCommittedMiB`);
  assertEquals(c.vcpusCommitted, 0, `${note}: vcpusCommitted`);
  assertEquals(c.diskCommittedBytes, 0, `${note}: diskCommittedBytes`);
  assertEquals(c.portsCommitted, 0, `${note}: portsCommitted`);
}

// ===========================================================================
// DEFECT 1 — revokeAll vs create at EVERY interleaving point.
// ===========================================================================

Deno.test("adv/D1: revokeAll while parked INSIDE reserve() rolls back — no capacity, no lease, no kill", async () => {
  const { core, gateway, clock, capacity, gateReserve } = makeCore();
  const g = gateReserve();

  const pending = core.create(durationInput());
  await g.reached; // parked in the reserve critical section, nothing committed yet

  core.revokeAll();
  g.release();

  const err = await assertRejects(() => pending, HostControlError);
  assertEquals(err.code, "SBX_HOST_STATE");

  assertNoCommitted(capacity, "reserve-parked rollback");
  assertEquals(core.leaseCount, 0, "no surviving lease");
  assertEquals(gateway.launched.length, 0, "never launched");
  clock.advance(600_000);
  await core.drain();
  assertEquals(gateway.killed, [], "no rootd kill");
  assertEquals(clock.liveTimers, 0, "no armed timer left behind");
});

Deno.test("adv/D1: revokeAll while parked INSIDE launch() rolls back — capacity restored, no kill", async () => {
  const { core, gateway, clock, capacity } = makeCore();
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  gateway.onLaunch = () => {
    reached.resolve();
    return gate.promise;
  };

  const pending = core.create(durationInput());
  await reached.promise;
  assertEquals(capacity.capacity().sandboxCount, 1, "reservation committed");

  core.revokeAll();
  gate.resolve();

  const err = await assertRejects(() => pending, HostControlError);
  assertEquals(err.code, "SBX_HOST_STATE");

  assertNoCommitted(capacity, "launch-parked rollback");
  assertEquals(core.leaseCount, 0, "no surviving lease");
  assertEquals(gateway.launched.length, 1, "launch did reach rootd");
  clock.advance(600_000);
  await core.drain();
  assertEquals(gateway.killed, [], "revokeAll rollback fires NO rootd kill");
  assertEquals(clock.liveTimers, 0, "no armed timer left behind");
});

Deno.test("adv/D1: revokeAll AFTER a create fully arms — lease dropped silently, its timer never kills", async () => {
  const { core, gateway, clock } = makeCore();

  await core.create(durationInput());
  assertEquals(core.leaseCount, 1, "armed");
  assertEquals(clock.liveTimers, 1, "duration timer armed");

  core.revokeAll();
  assertEquals(core.leaseCount, 0, "lease dropped by revokeAll");
  assertEquals(clock.liveTimers, 0, "revokeAll cancelled the duration timer");

  // The armed duration deadline must NOT resurrect a kill after a restart.
  clock.advance(600_000);
  await core.drain();
  assertEquals(gateway.killed, [], "revokeAll'd lease's timer fires no kill");
});

Deno.test("adv/D1: MANY concurrent creates ALL parked in launch + one revokeAll — all roll back, zero leaks, zero kills", async () => {
  const N = 6;
  // A budget big enough that all N pass reserve and park inside launch together.
  const capacity = new CapacityLedger({
    budget: {
      vcpus: 2 * N,
      memoryMiB: 768 * N + 512,
      diskBytes: 8 * 1024 * 1024 * 1024 * N,
    },
  });
  const gateway = new FakeGateway();
  const clock = new FakeClock();
  let counter = 0;
  const core = new HostControlCore({
    gateway,
    clock,
    capacity,
    idFactory: () => `0000000000000000000${counter++}`,
    bootNonceFactory: () => new Uint8Array(32),
  });

  const reachedCount = { n: 0 };
  const allReached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  gateway.onLaunch = () => {
    if (++reachedCount.n === N) allReached.resolve();
    return gate.promise;
  };

  const pendings = Array.from(
    { length: N },
    () => core.create(durationInput(768)),
  );
  await allReached.promise; // every create is now parked inside launch()
  assertEquals(
    capacity.capacity().sandboxCount,
    N,
    "all N reservations committed, all parked in launch",
  );

  core.revokeAll(); // one restart lands on all N in-flight creates
  gate.resolve();

  const results = await Promise.allSettled(pendings);
  for (const r of results) {
    assertEquals(r.status, "rejected", "every in-flight create rejected");
  }

  assertNoCommitted(capacity, "concurrent rollback");
  assertEquals(core.leaseCount, 0, "no surviving lease across N creates");
  clock.advance(600_000);
  await core.drain();
  assertEquals(
    gateway.killed,
    [],
    "no rootd kills from any rolled-back create",
  );
  assertEquals(clock.liveTimers, 0, "no armed timers left behind");
});

Deno.test("adv/D1: a create STARTED AFTER revokeAll succeeds normally (epoch is per-create)", async () => {
  const { core, gateway, capacity } = makeCore();
  core.revokeAll();
  const created = await core.create(durationInput());
  assertEquals(created.sandbox.state, "running");
  assertEquals(core.leaseCount, 1, "post-restart create arms a live lease");
  assertEquals(capacity.capacity().sandboxCount, 1);
  assertEquals(gateway.launched.length, 1);
});

// ===========================================================================
// DEFECT 2 — attach to dead / missing sandbox: typed error, no phantom lease,
// no side effects. attach to a LIVE sandbox still works.
// ===========================================================================

Deno.test("adv/D2: attach to a terminated sandbox rejects STATE, mints no lease, commits nothing", async () => {
  const { core, capacity } = makeCore();
  const created = await core.create(durationInput());
  const id = created.sandbox.id;

  core.killSandbox(id);
  await core.drain();
  assertEquals(core.metadata(id).state, "terminated");

  const err = assertThrows(
    () => core.attach(id, created.ownerSecret.slice()),
    HostControlError,
  );
  assertEquals(err.code, "SBX_HOST_STATE");
  assertEquals(core.leaseCount, 0, "no phantom lease");
  assertEquals(capacity.capacity().sandboxCount, 0, "no side effect");
});

Deno.test("adv/D2: attach to a duration-expired sandbox rejects STATE (no phantom lease)", async () => {
  const { core, clock, capacity } = makeCore();
  const created = await core.create(durationInput());
  const id = created.sandbox.id;

  clock.advance(60_001); // fire the duration deadline -> single kill path
  await core.drain();
  assertEquals(core.metadata(id).state, "terminated");

  const err = assertThrows(
    () => core.attach(id, created.ownerSecret.slice()),
    HostControlError,
  );
  assertEquals(err.code, "SBX_HOST_STATE");
  assertEquals(core.leaseCount, 0);
  assertEquals(capacity.capacity().sandboxCount, 0);
});

Deno.test("adv/D2: attach to a non-existent id rejects NOT_FOUND with no side effects", () => {
  const { core, capacity } = makeCore();
  const before = capacity.capacity();
  const err = assertThrows(
    () => core.attach("sbx_loc_does_not_exist", new Uint8Array(32)),
    HostControlError,
  );
  assertEquals(err.code, "SBX_HOST_NOT_FOUND");
  assertEquals(core.leaseCount, 0);
  assertEquals(capacity.capacity().sandboxCount, before.sandboxCount);
});

Deno.test("adv/D2: attach with a WRONG secret rejects PERMISSION and never mints a lease", async () => {
  const { core } = makeCore();
  const created = await core.create(durationInput());
  const wrong = new Uint8Array(32);
  wrong[0] = 0xff;
  const err = assertThrows(
    () => core.attach(created.sandbox.id, wrong),
    HostControlError,
  );
  assertEquals(err.code, "SBX_HOST_PERMISSION");
  assertEquals(core.leaseCount, 1, "the owner's live lease is untouched");
});

Deno.test("adv/D2: attach to a LIVE sandbox still works — same lease id, empty resume secret, no new lease", async () => {
  const { core } = makeCore();
  const created = await core.create(durationInput());
  const before = core.leaseCount;

  const attached = core.attach(created.sandbox.id, created.ownerSecret.slice());
  assertEquals(attached.sandbox.id, created.sandbox.id);
  assertEquals(attached.sandbox.state, "running");
  assertEquals(
    attached.lease.id,
    created.lease.id,
    "returns the CURRENT lease",
  );
  assertEquals(
    attached.lease.resumeSecret.byteLength,
    0,
    "attacher is not the lease owner",
  );
  assertEquals(core.leaseCount, before, "attach mints no new lease");
});

// The revokeAll-orphan variant: after a restart the lease is gone but the entry
// still reads "running". attach must NOT fabricate a phantom lease — a
// live-state sandbox whose lease is gone is being reconciled away, so attach
// rejects with a typed state error.
Deno.test("adv/D2*: attach after revokeAll (sandbox reconciling) rejects — no phantom lease", async () => {
  const { core } = makeCore();
  const created = await core.create(durationInput());
  core.revokeAll();
  assertEquals(core.leaseCount, 0, "lease dropped by revokeAll");

  // The sandbox entry still exists and still reads a non-terminal state, but
  // its lease is gone — attach must reject rather than hand back a phantom.
  assertEquals(
    core.metadata(created.sandbox.id).state,
    "running",
    "revokeAll leaves a non-terminal state",
  );
  assertThrows(
    () => core.attach(created.sandbox.id, created.ownerSecret.slice()),
    HostControlError,
    "has no live lease",
  );
  assertEquals(
    core.leaseCount,
    0,
    "attach mints no lease for a revoked sandbox",
  );
});

// ===========================================================================
// DEFECT 3 — a throw at any post-reserve point restores capacity exactly.
// ===========================================================================

Deno.test("adv/D3: idFactory throw (pre-reserve) commits nothing", async () => {
  const { core, capacity, gateway } = makeCore({
    idFactory: () => {
      throw new Error("id factory boom");
    },
  });
  await assertRejects(
    () => core.create(durationInput()),
    Error,
    "id factory boom",
  );
  assertNoCommitted(capacity, "idFactory throw");
  assertEquals(gateway.launched.length, 0);
  assertEquals(gateway.killed.length, 0);
});

Deno.test("adv/D3: bootNonce factory throw (pre-reserve) commits nothing", async () => {
  const { core, capacity } = makeCore({
    bootNonceFactory: () => {
      throw new Error("nonce boom");
    },
  });
  await assertRejects(() => core.create(durationInput()), Error, "nonce boom");
  assertNoCommitted(capacity, "bootNonce throw");
});

Deno.test("adv/D3: gateway.launch throw (post-reserve, pre-arm) restores capacity, no lease, NO kill", async () => {
  const gateway = new FakeGateway();
  gateway.launchThrows = new Error("rootd launch refused");
  const { core, capacity, clock } = makeCore({ gateway });

  await assertRejects(
    () => core.create(durationInput()),
    Error,
    "rootd launch refused",
  );
  assertNoCommitted(capacity, "launch throw");
  assertEquals(core.leaseCount, 0);
  // launch never returned success, so `launched` flag is false -> no kill.
  assertEquals(gateway.killed, [], "no kill for a launch that never succeeded");
  assertEquals(clock.liveTimers, 0);
});

Deno.test("adv/D3: secretFactory throw (post-LAUNCH, pre-arm) restores capacity AND kills the orphaned VM", async () => {
  const gateway = new FakeGateway();
  let calls = 0;
  const { core, capacity } = makeCore({
    gateway,
    secretFactory: () => {
      calls++;
      throw new Error("secret boom");
    },
  });

  await assertRejects(() => core.create(durationInput()), Error, "secret boom");
  assertEquals(calls, 1, "secretFactory reached (post-launch)");
  assertNoCommitted(capacity, "secretFactory throw");
  assertEquals(core.leaseCount, 0, "no lease armed");
  assertEquals(gateway.launched.length, 1, "launch happened");
  assertEquals(
    gateway.killed,
    [gateway.launched[0].executionId],
    "orphaned execution killed on non-restart failure",
  );
});

// ===========================================================================
// REGRESSION SWEEP — earlier good behaviors must still hold.
// ===========================================================================

Deno.test("adv/reg: happy-path duration create arms exactly one lease + one reservation", async () => {
  const { core, gateway, capacity } = makeCore();
  const created = await core.create(durationInput());
  assertEquals(created.sandbox.state, "running");
  assertEquals(core.leaseCount, 1);
  assertEquals(capacity.capacity().sandboxCount, 1);
  assertEquals(gateway.launched.length, 1);
  assertEquals(gateway.killed.length, 0);
});

Deno.test("adv/reg: duration deadline fires the single kill path (capacity reclaimed, one kill)", async () => {
  const { core, gateway, clock, capacity } = makeCore();
  await core.create(durationInput());
  clock.advance(60_001);
  await core.drain();
  assertEquals(core.leaseCount, 0);
  assertEquals(capacity.capacity().sandboxCount, 0, "capacity reclaimed");
  assertEquals(gateway.killed.length, 1, "exactly one rootd kill");
});

Deno.test("adv/reg: explicit releaseLease is idempotent — one kill, one capacity reclaim", async () => {
  const { core, gateway, capacity } = makeCore();
  const created = await core.create(durationInput());
  core.releaseLease(created.lease.id);
  core.releaseLease(created.lease.id); // idempotent
  await core.drain();
  assertEquals(core.leaseCount, 0);
  assertEquals(capacity.capacity().sandboxCount, 0);
  assertEquals(gateway.killed.length, 1, "release fires exactly one kill");
});

Deno.test("adv/reg: killSandbox on an already-terminated sandbox is a no-op (no second kill)", async () => {
  const { core, gateway } = makeCore();
  const created = await core.create(durationInput());
  core.killSandbox(created.sandbox.id);
  await core.drain();
  core.killSandbox(created.sandbox.id); // already terminal
  await core.drain();
  assertEquals(gateway.killed.length, 1, "no double kill");
});

Deno.test("adv/reg: capacity mutex keeps check-then-commit atomic under a slow admission barrier", async () => {
  // Budget for exactly ONE sandbox; two racing creates must not both commit.
  let counter = 0;
  const gate = Promise.withResolvers<void>();
  let first = true;
  const capacity = new CapacityLedger({
    budget: { vcpus: 2, memoryMiB: 2048, diskBytes: 8 * 1024 * 1024 * 1024 },
    admissionBarrier: () => {
      if (first) {
        first = false;
        return gate.promise; // hold the first reserve inside the section
      }
      return undefined;
    },
  });
  const gateway = new FakeGateway();
  const clock = new FakeClock();
  const core = new HostControlCore({
    gateway,
    clock,
    capacity,
    idFactory: () => `0000000000000000000${counter++}`,
    bootNonceFactory: () => new Uint8Array(32),
  });

  const a = core.create(durationInput(1024));
  const b = core.create(durationInput(1024));
  gate.resolve();
  const results = await Promise.allSettled([a, b]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const bad = results.filter((r) => r.status === "rejected").length;
  assertEquals(ok, 1, "exactly one create wins the single slot");
  assertEquals(bad, 1, "the loser is rejected, not double-committed");
  assertEquals(
    capacity.capacity().sandboxCount,
    1,
    "ledger holds one, not two",
  );
});

Deno.test("adv/reg: renew bumps generation; extendTimeout pushes the deadline", async () => {
  const { core } = makeCore();
  const created = await core.create(durationInput());
  const renewed = core.renewLease(created.lease.id);
  assertEquals(renewed.generation, 2, "generation bumped");
  const ext = core.extendTimeout(created.sandbox.id, 10 * 60_000);
  assertEquals(
    ext.deadlineUnixMs > created.lease.expiresAtUnixMs,
    true,
    "deadline extended",
  );
});
