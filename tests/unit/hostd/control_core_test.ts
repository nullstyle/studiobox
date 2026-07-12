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
  /** Optional interception run inside launch(), after the request is recorded. */
  onLaunch?: (request: SupervisorLaunchRequest) => Promise<void> | void;

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
