import { assertEquals, assertThrows } from "@std/assert";
import {
  type Clock,
  type ClockTimer,
  DEFAULT_MAX_EXTEND_MS,
  LeaseError,
  LeaseManager,
} from "../../../src/hostd/leases.ts";

/**
 * A fully deterministic {@link Clock}: `now()` only moves when a test advances
 * it, and timers fire in deadline order as the clock crosses their fire time.
 */
class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<
    number,
    { fireAt: number; callback: () => void }
  >();

  constructor(startUnixMs = 0) {
    this.#now = startUnixMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fireAtUnixMs: number, callback: () => void): ClockTimer {
    const token = this.#seq++;
    this.#timers.set(token, { fireAt: fireAtUnixMs, callback });
    return {
      cancel: () => {
        this.#timers.delete(token);
      },
    };
  }

  /** Move time forward by `deltaMs`, firing every timer it crosses in order. */
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

  /** Number of live (uncancelled, unfired) timers. */
  get pending(): number {
    return this.#timers.size;
  }
}

function collector() {
  const expired: string[] = [];
  return { expired, onExpire: (sandboxId: string) => expired.push(sandboxId) };
}

Deno.test("duration lease fires onExpire at the deadline, not before", () => {
  const clock = new FakeClock(1_000);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-dur",
    timeout: { kind: "duration", durationMs: 60_000 },
  });
  assertEquals(lease.kind, "duration");
  assertEquals(lease.deadlineUnixMs, 61_000);

  clock.advance(59_999);
  assertEquals(expired, [], "must not fire before the deadline");
  assertEquals(leases.size, 1);

  clock.advance(1); // now == 61_000, the exact deadline
  assertEquals(expired, ["sbx-dur"], "fires at the deadline");
  assertEquals(leases.size, 0, "settled lease is removed");
  assertEquals(clock.pending, 0, "timer is consumed");
});

Deno.test("session lease fires onExpire when its connection signal aborts", () => {
  const clock = new FakeClock(0);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });
  const conn = new AbortController();

  const lease = leases.create({
    sandboxId: "sbx-sess",
    timeout: { kind: "session" },
    connectionSignal: conn.signal,
  });
  assertEquals(lease.kind, "session");
  assertEquals(lease.deadlineUnixMs, undefined);

  // Advancing the clock arbitrarily never expires a session lease.
  clock.advance(10 * 60_000);
  assertEquals(expired, []);
  assertEquals(leases.size, 1);

  conn.abort(); // creating connection closes
  assertEquals(expired, ["sbx-sess"]);
  assertEquals(leases.size, 0);
});

Deno.test("session lease requires a connection signal", () => {
  const clock = new FakeClock(0);
  const { onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const err = assertThrows(
    () => leases.create({ sandboxId: "sbx", timeout: { kind: "session" } }),
    LeaseError,
  );
  assertEquals(err.code, "SBX_LEASE_INVALID");
});

Deno.test("extendTimeout caps at 30 min and returns the real deadline", () => {
  const clock = new FakeClock(100_000);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-ext",
    timeout: { kind: "duration", durationMs: 10_000 },
  });
  assertEquals(lease.deadlineUnixMs, 110_000);

  // Ask for 45 min; the grant is capped at DEFAULT_MAX_EXTEND_MS (30 min).
  const deadline = leases.extendTimeout(lease.id, 45 * 60_000);
  assertEquals(deadline, 110_000 + DEFAULT_MAX_EXTEND_MS);
  assertEquals(
    leases.get(lease.id)?.deadlineUnixMs,
    110_000 + DEFAULT_MAX_EXTEND_MS,
  );

  // The old 10 s deadline was rescheduled away: crossing it does nothing.
  clock.advance(20_000);
  assertEquals(expired, []);
  assertEquals(leases.size, 1);

  // The lease now fires at the extended deadline.
  clock.advance(DEFAULT_MAX_EXTEND_MS);
  assertEquals(expired, ["sbx-ext"]);
});

Deno.test("renew bumps generation and extends by up to the cap", () => {
  const clock = new FakeClock(0);
  const { onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-renew",
    timeout: { kind: "duration", durationMs: 5_000 },
  });
  assertEquals(lease.generation, 1);

  const renewal = leases.renew(lease.id, 60_000);
  assertEquals(renewal.generation, 2);
  assertEquals(renewal.deadlineUnixMs, 5_000 + 60_000);
  assertEquals(leases.get(lease.id)?.generation, 2);
});

Deno.test("extendTimeout rejects a session lease", () => {
  const clock = new FakeClock(0);
  const { onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });
  const conn = new AbortController();

  const lease = leases.create({
    sandboxId: "sbx",
    timeout: { kind: "session" },
    connectionSignal: conn.signal,
  });
  const err = assertThrows(
    () => leases.extendTimeout(lease.id, 1_000),
    LeaseError,
  );
  assertEquals(err.code, "SBX_LEASE_KIND");
});

Deno.test("renew past expiry is rejected", () => {
  const clock = new FakeClock(0);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-late",
    timeout: { kind: "duration", durationMs: 1_000 },
  });

  clock.advance(1_000); // lease expires and is removed
  assertEquals(expired, ["sbx-late"]);

  const err = assertThrows(() => leases.renew(lease.id, 30_000), LeaseError);
  assertEquals(err.code, "SBX_LEASE_NOT_FOUND");
});

Deno.test("renew of an unknown lease is rejected", () => {
  const clock = new FakeClock(0);
  const { onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const err = assertThrows(() => leases.renew("nope", 1_000), LeaseError);
  assertEquals(err.code, "SBX_LEASE_NOT_FOUND");
});

Deno.test("release fires onExpire exactly once and is idempotent", () => {
  const clock = new FakeClock(0);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-rel",
    timeout: { kind: "duration", durationMs: 60_000 },
  });

  leases.release(lease.id);
  leases.release(lease.id); // idempotent
  assertEquals(expired, ["sbx-rel"]);
  assertEquals(leases.size, 0);
  assertEquals(clock.pending, 0, "release cancels the pending timer");

  // The cancelled timer never fires after release.
  clock.advance(120_000);
  assertEquals(expired, ["sbx-rel"]);
});

Deno.test("revoke drops a lease silently (no onExpire)", () => {
  const clock = new FakeClock(0);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-rev",
    timeout: { kind: "duration", durationMs: 60_000 },
  });
  leases.revoke(lease.id);
  assertEquals(expired, []);
  assertEquals(leases.size, 0);

  clock.advance(120_000); // the cancelled timer must not fire
  assertEquals(expired, []);
});

Deno.test("revokeAll clears everything and fires no expiry — including no double-expire", () => {
  const clock = new FakeClock(0);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });
  const connA = new AbortController();

  const dur = leases.create({
    sandboxId: "sbx-a",
    timeout: { kind: "duration", durationMs: 30_000 },
  });
  const sess = leases.create({
    sandboxId: "sbx-b",
    timeout: { kind: "session" },
    connectionSignal: connA.signal,
  });

  // Expire one lease first, so revokeAll has an already-settled entry in play.
  clock.advance(30_000);
  assertEquals(expired, ["sbx-a"]);
  assertEquals(leases.size, 1);

  leases.revokeAll();
  assertEquals(leases.size, 0);
  // revokeAll fired nothing; the earlier natural expiry stands alone.
  assertEquals(expired, ["sbx-a"]);

  // Post-revoke signals and timers are inert — no double-expire.
  connA.abort();
  clock.advance(60_000);
  assertEquals(expired, ["sbx-a"]);
  assertEquals(dur.kind, "duration");
  assertEquals(sess.kind, "session");
});

Deno.test("a pre-aborted session signal settles after create returns", async () => {
  const clock = new FakeClock(0);
  const { expired, onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  const lease = leases.create({
    sandboxId: "sbx-dead",
    timeout: { kind: "session" },
    connectionSignal: AbortSignal.abort(),
  });
  // create returned the lease before settling.
  assertEquals(lease.sandboxId, "sbx-dead");
  assertEquals(expired, []);

  await Promise.resolve(); // drain the microtask
  assertEquals(expired, ["sbx-dead"]);
  assertEquals(leases.size, 0);
});

Deno.test("duplicate lease ids are rejected", () => {
  const clock = new FakeClock(0);
  const { onExpire } = collector();
  const leases = new LeaseManager({ clock, onExpire });

  leases.create({
    id: "fixed",
    sandboxId: "sbx",
    timeout: { kind: "duration", durationMs: 1_000 },
  });
  const err = assertThrows(
    () =>
      leases.create({
        id: "fixed",
        sandboxId: "sbx",
        timeout: { kind: "duration", durationMs: 1_000 },
      }),
    LeaseError,
  );
  assertEquals(err.code, "SBX_LEASE_INVALID");
});
