// M6 hostd control-core lifecycle regressions (transport-free; drives
// HostControlCore directly with a fake clock + fake rootd gateway).
//
// These pin three lifecycle defects:
//   1. revokeAll() landing mid-create must roll the create back — no leaked
//      capacity, no surviving lease, and no rootd kill from an armed timer.
//   2. attach() to a terminated sandbox must reject with a typed state error
//      instead of handing back a phantom lease.
//   3. a factory (id/boot-nonce) throw during create must not leak a committed
//      capacity reservation.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type CreateSandboxInput,
  FORWARD_PORT_MAX,
  FORWARD_PORT_MIN,
  ForwardPortAllocator,
  HostControlCore,
  HostControlError,
} from "../../../src/hostd/control_core.ts";
import { SupervisorError } from "../../../src/rootd/supervisor_core_api.ts";
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

/** A deterministic clock whose timers fire only when a test advances it. */
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

/** An in-process RootdGateway that records launches + kills, with a launch hook. */
class FakeGateway implements RootdGateway {
  readonly launched: SupervisorLaunchRequest[] = [];
  readonly killed: string[] = [];
  readonly exposed: Array<
    { executionId: string; guestPort: number; hostPort: number }
  > = [];
  /** Optional interception run inside launch(), after the request is recorded. */
  onLaunch?: (request: SupervisorLaunchRequest) => Promise<void> | void;
  /** When set, `exposeHttp` rejects with it (rootd DNAT-install failure). */
  exposeError?: Error;
  /**
   * Optional interception run inside `exposeHttp()`, after the call is recorded.
   * Returning a pending promise parks the in-flight rootd install so a test can
   * terminate the sandbox mid-await.
   */
  onExpose?: (
    executionId: string,
    guestPort: number,
    hostPort: number,
  ) => Promise<void> | void;

  async launch(
    request: SupervisorLaunchRequest,
  ): Promise<SupervisorMachineStatus> {
    this.launched.push(request);
    if (this.onLaunch !== undefined) await this.onLaunch(request);
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

  exposeHttp(
    executionId: string,
    guestPort: number,
    hostPort: number,
  ): Promise<void> {
    if (this.exposeError !== undefined) {
      return Promise.reject(this.exposeError);
    }
    this.exposed.push({ executionId, guestPort, hostPort });
    if (this.onExpose !== undefined) {
      return Promise.resolve(this.onExpose(executionId, guestPort, hostPort));
    }
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
}

function makeCore(
  options: {
    idFactory?: () => string;
    bootNonceFactory?: () => Uint8Array;
    gateway?: FakeGateway;
  } = {},
): Ctx {
  const gateway = options.gateway ?? new FakeGateway();
  const clock = new FakeClock();
  const capacity = new CapacityLedger();
  let counter = 0;
  const core = new HostControlCore({
    gateway,
    clock,
    capacity,
    idFactory: options.idFactory ?? (() => `00000000000000000${counter++}`),
    bootNonceFactory: options.bootNonceFactory ??
      (() => new Uint8Array(32)),
  });
  return { core, gateway, clock, capacity };
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

// ---------------------------------------------------------------------------
// Defect 1: revokeAll() during an in-flight create() must roll back.
// ---------------------------------------------------------------------------

Deno.test("control-core: revokeAll during an in-flight create rolls it back — no leaked capacity, no surviving lease, no rootd kill", async () => {
  const gateway = new FakeGateway();
  const { core, clock, capacity } = makeCore({ gateway });

  // Park the create at the reserve/register seam: launch() has been reached
  // (capacity already committed) but the lease is not yet armed. A hostd restart
  // (revokeAll) fires here.
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  gateway.onLaunch = () => {
    reached.resolve();
    return gate.promise;
  };

  const pending = core.create(durationInput());
  await reached.promise;

  // The reservation is committed at this point (create is past reserve()).
  assertEquals(capacity.capacity().sandboxCount, 1, "reservation committed");

  // Restart mid-create, then let launch() complete.
  core.revokeAll();
  gate.resolve();

  const error = await assertRejects(() => pending, HostControlError);
  assertEquals(error.code, "SBX_HOST_STATE");

  // Rolled back: the reservation was released and no lease survived.
  assertEquals(
    capacity.capacity().sandboxCount,
    0,
    "no leaked capacity reservation",
  );
  assertEquals(core.leaseCount, 0, "no surviving lease");

  // No armed timer exists to fire, so advancing well past the duration deadline
  // triggers no rootd kill — honoring "revokeAll fires no rootd kills".
  clock.advance(120_000);
  await core.drain();
  assertEquals(gateway.killed, [], "revokeAll rollback fires no rootd kill");
});

// ---------------------------------------------------------------------------
// Defect 2: attach() to a terminated sandbox must reject, issuing no lease.
// ---------------------------------------------------------------------------

Deno.test("control-core: attach to a terminated sandbox rejects with a typed state error and issues no lease", async () => {
  const { core, gateway, capacity } = makeCore();

  const created = await core.create(durationInput());
  const id = created.sandbox.id;
  const ownerSecret = created.ownerSecret;
  assertEquals(core.leaseCount, 1);

  // Terminate the sandbox (single kill path); its entry stays but its lease dies.
  core.killSandbox(id);
  await core.drain();
  assertEquals(core.metadata(id).state, "terminated");
  assertEquals(core.leaseCount, 0);
  assertEquals(capacity.capacity().sandboxCount, 0);
  assertEquals(gateway.killed.length, 1);

  // attach() with the RIGHT secret must still reject — no phantom lease.
  const error = assertThrows(
    () => core.attach(id, ownerSecret.slice()),
    HostControlError,
  );
  assertEquals(error.code, "SBX_HOST_STATE");

  // No capacity/lease side effects from the rejected attach.
  assertEquals(core.leaseCount, 0, "attach minted no lease");
  assertEquals(capacity.capacity().sandboxCount, 0, "attach committed nothing");
});

// ---------------------------------------------------------------------------
// Defect 3: a factory throw after (would-be) reserve must not leak capacity.
// ---------------------------------------------------------------------------

Deno.test("control-core: a boot-nonce factory throw during create leaks no capacity reservation", async () => {
  const { core, capacity } = makeCore({
    bootNonceFactory: () => {
      throw new Error("boot-nonce factory boom");
    },
  });

  const before = capacity.capacity();
  await assertRejects(
    () => core.create(durationInput()),
    Error,
    "boot-nonce factory boom",
  );

  const after = capacity.capacity();
  assertEquals(
    after.memoryCommittedMiB,
    before.memoryCommittedMiB,
    "no leaked memory reservation",
  );
  assertEquals(after.vcpusCommitted, before.vcpusCommitted);
  assertEquals(after.diskCommittedBytes, before.diskCommittedBytes);
  assertEquals(after.sandboxCount, 0, "no leaked reservation");
});

// ---------------------------------------------------------------------------
// M10 W6: exposeHttp host-port lease lifecycle
// ---------------------------------------------------------------------------

Deno.test("ForwardPortAllocator: lowest-free, release-then-reuse, exhaustion", () => {
  const alloc = new ForwardPortAllocator();
  // Lowest-free hands out the range's floor first, then ascends.
  assertEquals(alloc.allocate(), FORWARD_PORT_MIN);
  assertEquals(alloc.allocate(), FORWARD_PORT_MIN + 1);
  assertEquals(alloc.allocate(), FORWARD_PORT_MIN + 2);
  assertEquals(alloc.inUse, 3);
  // Releasing a middle port frees exactly it; the next allocate reuses it
  // (lowest-free), not a fresh higher port.
  alloc.release(FORWARD_PORT_MIN + 1);
  assertEquals(alloc.inUse, 2);
  assertEquals(alloc.allocate(), FORWARD_PORT_MIN + 1);
  // A double-free is a no-op.
  alloc.release(FORWARD_PORT_MIN + 1);
  alloc.release(FORWARD_PORT_MIN + 1);
  assertEquals(alloc.inUse, 2);
});

Deno.test("ForwardPortAllocator: exhausting the range throws a host-state error", () => {
  // A tiny range makes exhaustion cheap to prove.
  const alloc = new ForwardPortAllocator(40_100, 40_101);
  assertEquals(alloc.allocate(), 40_100);
  assertEquals(alloc.allocate(), 40_101);
  const error = assertThrows(() => alloc.allocate(), HostControlError);
  assertEquals(error.code, "SBX_HOST_STATE");
  // After releasing one, a fresh allocate succeeds again.
  alloc.release(40_100);
  assertEquals(alloc.allocate(), 40_100);
});

Deno.test("control-core: exposeHttp leases a host port, records the rootd install, and returns the loopback URL", async () => {
  const { core, gateway } = makeCore();
  const created = await core.create(durationInput());
  const id = created.sandbox.id;

  const first = await core.exposeHttp(id, 8080);
  assertEquals(first.guestPort, 8080);
  assert(
    first.hostPort >= FORWARD_PORT_MIN && first.hostPort <= FORWARD_PORT_MAX,
    `host port ${first.hostPort} in reserved range`,
  );
  assertEquals(first.hostPort, FORWARD_PORT_MIN);
  assertEquals(first.url, `http://127.0.0.1:${FORWARD_PORT_MIN}`);
  // rootd received the (executionId, guestPort, allocated hostPort) install.
  assertEquals(gateway.exposed.length, 1);
  assertEquals(gateway.exposed[0].guestPort, 8080);
  assertEquals(gateway.exposed[0].hostPort, FORWARD_PORT_MIN);
  assert(gateway.exposed[0].executionId.startsWith("exec-"));

  // A second exposeHttp gets a DISTINCT host port.
  const second = await core.exposeHttp(id, 9090);
  assertEquals(second.hostPort, FORWARD_PORT_MIN + 1);
  assertEquals(core.exposedPortCount, 2);
});

Deno.test("control-core: exposeHttp releases the host port when the sandbox terminates, so a later sandbox reuses it", async () => {
  const { core } = makeCore();
  const a = await core.create(durationInput());
  const first = await core.exposeHttp(a.sandbox.id, 8080);
  assertEquals(first.hostPort, FORWARD_PORT_MIN);
  assertEquals(core.exposedPortCount, 1);

  // Terminating the sandbox releases its host port back to the pool.
  core.killSandbox(a.sandbox.id);
  assertEquals(core.exposedPortCount, 0);

  // A later sandbox reuses the freed (lowest-free) port.
  const b = await core.create(durationInput());
  const reused = await core.exposeHttp(b.sandbox.id, 8080);
  assertEquals(reused.hostPort, FORWARD_PORT_MIN);
});

Deno.test("control-core: one sandbox's termination never frees another's exposed port", async () => {
  const { core } = makeCore();
  const a = await core.create(durationInput());
  const b = await core.create(durationInput());
  const portA = (await core.exposeHttp(a.sandbox.id, 8080)).hostPort;
  const portB = (await core.exposeHttp(b.sandbox.id, 8080)).hostPort;
  assertEquals(portA, FORWARD_PORT_MIN);
  assertEquals(portB, FORWARD_PORT_MIN + 1);

  // Terminate A only: B's port stays leased, so a fresh expose skips both.
  core.killSandbox(a.sandbox.id);
  assertEquals(core.exposedPortCount, 1);
  const c = await core.create(durationInput());
  const portC = (await core.exposeHttp(c.sandbox.id, 8080)).hostPort;
  // A's port (the floor) is reusable; B's (floor+1) is NOT.
  assertEquals(portC, FORWARD_PORT_MIN);
});

Deno.test("control-core: a rootd exposeHttp failure releases the just-leased host port", async () => {
  const { core, gateway } = makeCore();
  const created = await core.create(durationInput());
  gateway.exposeError = new SupervisorError(
    "SBX_SUP_STATE",
    "rootd could not install the forward",
  );

  await assertRejects(
    () => core.exposeHttp(created.sandbox.id, 8080),
    SupervisorError,
  );
  // The host port was released — no leak — so the next expose reuses the floor.
  assertEquals(core.exposedPortCount, 0);
  gateway.exposeError = undefined;
  const retry = await core.exposeHttp(created.sandbox.id, 8080);
  assertEquals(retry.hostPort, FORWARD_PORT_MIN);
});

Deno.test("control-core: a lease that expires DURING an in-flight exposeHttp leaks ZERO forward ports", async () => {
  const gateway = new FakeGateway();
  const { core, clock } = makeCore({ gateway });
  const created = await core.create(durationInput());
  const id = created.sandbox.id;

  // Park the rootd install in flight so the sandbox can terminate WHILE the
  // exposeHttp RPC is still awaiting (the leak window).
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  gateway.onExpose = () => {
    reached.resolve();
    return gate.promise; // stays pending until the test releases it
  };

  const pending = core.exposeHttp(id, 8080);
  await reached.promise;
  // The host port is leased while the install is in flight.
  assertEquals(core.exposedPortCount, 1);

  // The sandbox's duration deadline fires mid-await (single kill path). The
  // in-flight forward-port lease MUST be released even though the install has
  // not returned — with the pre-fix record-after-await ordering this port would
  // leak permanently (nothing recorded for #releaseForwardPorts to free).
  clock.advance(120_000);
  assertEquals(core.metadata(id).state, "terminated");
  assertEquals(
    core.exposedPortCount,
    0,
    "in-flight lease freed by termination",
  );

  // Let the install SUCCEED after the sandbox is already gone: the idempotent
  // release path must not re-record or double-free the port.
  gate.resolve();
  await pending;
  await core.drain();
  assertEquals(core.exposedPortCount, 0, "no port leaked after the race");

  // The whole reserved pool is free again: the next sandbox reuses the floor.
  const next = await core.create(durationInput());
  const reused = await core.exposeHttp(next.sandbox.id, 8080);
  assertEquals(reused.hostPort, FORWARD_PORT_MIN);
});

Deno.test("control-core: exposeHttp rejects a terminated sandbox, an out-of-range guest port, and an unknown id", async () => {
  const { core } = makeCore();
  const created = await core.create(durationInput());
  const id = created.sandbox.id;

  // Out-of-range guest port is a validation fault (no lease taken).
  const bad = await assertRejects(
    () => core.exposeHttp(id, 0),
    HostControlError,
  );
  assertEquals(bad.code, "SBX_HOST_VALIDATION");
  assertEquals(core.exposedPortCount, 0);

  // Unknown id is not-found.
  const missing = await assertRejects(
    () => core.exposeHttp("sbx_loc_missing", 8080),
    HostControlError,
  );
  assertEquals(missing.code, "SBX_HOST_NOT_FOUND");

  // A terminated sandbox is a state fault.
  core.killSandbox(id);
  const dead = await assertRejects(
    () => core.exposeHttp(id, 8080),
    HostControlError,
  );
  assertEquals(dead.code, "SBX_HOST_STATE");
});
