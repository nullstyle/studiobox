/**
 * The studiobox-hostd lease DOMAIN module.
 *
 * A {@linkcode LeaseManager} models @deno/sandbox's timeout semantics
 * (DESIGN.md §5 timeout row, §9 timeouts) as a transport-free, plain-TypeScript
 * domain core. The generated `host_control.capnp` `Lease` / `HostSandbox`
 * capabilities adapt over this surface later (M6-wire); nothing here imports
 * generated bindings.
 *
 * A lease is one client's claim on a live sandbox. Its lifetime follows one of
 * two timeout kinds, mirroring upstream:
 *
 * - **`"session"`** — the sandbox dies when the *creating connection* closes.
 *   The lease is bound to a connection-liveness {@link AbortSignal} that the
 *   wire layer wires to the creating transport's close; when it aborts the
 *   lease settles.
 * - **`"duration"`** — an absolute wall-clock deadline that kills the sandbox
 *   even while clients stay connected. The deadline is driven by the injected
 *   {@link Clock}; it fires at the deadline, not before.
 *
 * On expiry, session-connection-close, **or** an explicit
 * {@linkcode LeaseManager.release}, the manager invokes the injected
 * `onExpire(sandboxId)` hook exactly once (the wire layer wires it to
 * `Supervisor.kill`). {@linkcode LeaseManager.revoke} and
 * {@linkcode LeaseManager.revokeAll} drop leases *silently* — no `onExpire` —
 * because a hostd restart reclaims sandboxes through rootd's destructive
 * reconcile (DESIGN.md §6), not through per-lease kills.
 *
 * The manager never calls `Date.now()` directly: all time comes from the
 * injected {@link Clock}, so tests drive a fully deterministic fake clock.
 *
 * @module
 */

/** Cancels a pending {@link Clock} timer. Idempotent. */
export interface ClockTimer {
  cancel(): void;
}

/**
 * Injected time source. Production wires {@linkcode systemClock}; tests wire a
 * fake clock whose `now()` and timers advance under explicit control.
 */
export interface Clock {
  /** Current wall-clock time in unix milliseconds. */
  now(): number;
  /**
   * Fire `callback` once at or after `fireAtUnixMs`. A `fireAtUnixMs` already
   * in the past fires as soon as the clock next reaches it (on the next tick /
   * advance). The returned handle cancels the pending fire.
   */
  setTimer(fireAtUnixMs: number, callback: () => void): ClockTimer;
}

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * The production {@link Clock}: `Date.now()` plus a re-arming `setTimeout` so
 * deadlines beyond `setTimeout`'s ~24.8-day cap fire at the right time instead
 * of immediately.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(fireAtUnixMs: number, callback: () => void): ClockTimer {
    let handle: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const arm = (): void => {
      if (cancelled) return;
      const remaining = fireAtUnixMs - Date.now();
      if (remaining <= 0) {
        callback();
        return;
      }
      handle = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_DELAY_MS));
    };
    arm();
    return {
      cancel(): void {
        cancelled = true;
        if (handle !== undefined) clearTimeout(handle);
      },
    };
  },
};

/** The per-call cap on `renew`/`extendTimeout` extensions (upstream: 30 min). */
export const DEFAULT_MAX_EXTEND_MS = 30 * 60_000;

/** Which of the two timeout regimes a lease follows. */
export type LeaseKind = "session" | "duration";

/**
 * Domain mirror of the wire `TimeoutSpec` union (session | durationMs). The
 * M6-wire adapter maps `host_control.capnp`'s `TimeoutSpec` onto this shape.
 */
export type LeaseTimeout =
  | { readonly kind: "session" }
  | { readonly kind: "duration"; readonly durationMs: number };

/** Inputs for {@linkcode LeaseManager.create}. */
export interface CreateLeaseSpec {
  /** Stable sandbox id this lease claims. */
  readonly sandboxId: string;
  /** Session vs. absolute-duration timeout regime. */
  readonly timeout: LeaseTimeout;
  /**
   * Connection-liveness signal — **required** for `"session"` timeouts, ignored
   * for `"duration"`. The wire layer aborts it when the creating transport
   * closes; the lease then settles and fires `onExpire`.
   */
  readonly connectionSignal?: AbortSignal;
  /** Explicit lease id; when omitted the manager's `idFactory` mints one. */
  readonly id?: string;
}

/** An immutable snapshot of one lease. */
export interface Lease {
  readonly id: string;
  readonly sandboxId: string;
  readonly kind: LeaseKind;
  /** Bumped on every successful {@linkcode LeaseManager.renew}. */
  readonly generation: number;
  /**
   * Absolute wall-clock deadline (unix ms) for `"duration"` leases;
   * `undefined` for `"session"` leases, whose lifetime is the connection.
   */
  readonly deadlineUnixMs: number | undefined;
}

/** Result of {@linkcode LeaseManager.renew}. */
export interface LeaseRenewal {
  readonly id: string;
  readonly generation: number;
  readonly deadlineUnixMs: number;
}

export type LeaseErrorCode =
  /** No live lease resolves the given id. */
  | "SBX_LEASE_NOT_FOUND"
  /** The lease's deadline has already passed; it cannot be renewed. */
  | "SBX_LEASE_EXPIRED"
  /** The operation is invalid for this lease's timeout kind. */
  | "SBX_LEASE_KIND"
  /** A create-time invariant was violated (bad duration, missing signal). */
  | "SBX_LEASE_INVALID";

/** Typed domain error; becomes `SbxError` on the M6-wire adapter. */
export class LeaseError extends Error {
  readonly code: LeaseErrorCode;

  constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
  }
}

export interface LeaseManagerOptions {
  /** Injected time source (see {@link Clock}); never `Date.now()` directly. */
  readonly clock: Clock;
  /**
   * Invoked once per lease when it expires, its session connection closes, or
   * it is explicitly released. The wire layer wires this to `Supervisor.kill`.
   * `revoke`/`revokeAll` deliberately do **not** call it.
   */
  readonly onExpire: (sandboxId: string) => void;
  /** Per-call extension cap (default {@link DEFAULT_MAX_EXTEND_MS}). */
  readonly maxExtendMs?: number;
  /** Lease-id source when a spec omits `id` (default: `crypto.randomUUID`). */
  readonly idFactory?: () => string;
}

interface LeaseEntry {
  readonly id: string;
  readonly sandboxId: string;
  readonly kind: LeaseKind;
  generation: number;
  deadlineUnixMs: number | undefined;
  /** Cancels the duration timer / detaches the session signal listener. */
  cleanup: () => void;
  settled: boolean;
}

/**
 * Tracks live leases, fires their timeouts through an injected clock and
 * connection signals, and drives the single `onExpire` kill hook.
 */
export class LeaseManager {
  readonly #clock: Clock;
  readonly #onExpire: (sandboxId: string) => void;
  readonly #maxExtendMs: number;
  readonly #idFactory: () => string;
  readonly #leases = new Map<string, LeaseEntry>();

  constructor(options: LeaseManagerOptions) {
    this.#clock = options.clock;
    this.#onExpire = options.onExpire;
    this.#maxExtendMs = options.maxExtendMs ?? DEFAULT_MAX_EXTEND_MS;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    if (!Number.isSafeInteger(this.#maxExtendMs) || this.#maxExtendMs <= 0) {
      throw new RangeError("maxExtendMs must be a positive integer");
    }
  }

  /** Number of live leases. */
  get size(): number {
    return this.#leases.size;
  }

  /** Snapshot of one live lease, or `undefined` if unknown/settled. */
  get(id: string): Lease | undefined {
    const entry = this.#leases.get(id);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** Snapshots of every live lease. */
  list(): Lease[] {
    return Array.from(this.#leases.values(), snapshot);
  }

  /**
   * Register a new lease and arm its timeout. A `"duration"` lease schedules a
   * clock timer at `now + durationMs`; a `"session"` lease attaches to
   * `connectionSignal` and settles when it aborts.
   */
  create(spec: CreateLeaseSpec): Lease {
    const id = spec.id ?? this.#idFactory();
    if (id.length === 0) {
      throw new LeaseError("SBX_LEASE_INVALID", "lease id must be non-empty");
    }
    if (this.#leases.has(id)) {
      throw new LeaseError(
        "SBX_LEASE_INVALID",
        `lease id ${id} is already active`,
      );
    }
    if (spec.sandboxId.length === 0) {
      throw new LeaseError("SBX_LEASE_INVALID", "sandboxId must be non-empty");
    }

    if (spec.timeout.kind === "duration") {
      const { durationMs } = spec.timeout;
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        throw new LeaseError(
          "SBX_LEASE_INVALID",
          "duration timeout requires a positive integer durationMs",
        );
      }
      const deadlineUnixMs = this.#clock.now() + durationMs;
      const entry: LeaseEntry = {
        id,
        sandboxId: spec.sandboxId,
        kind: "duration",
        generation: 1,
        deadlineUnixMs,
        cleanup: () => {},
        settled: false,
      };
      const timer = this.#clock.setTimer(
        deadlineUnixMs,
        () => this.#settle(entry),
      );
      entry.cleanup = () => timer.cancel();
      this.#leases.set(id, entry);
      return snapshot(entry);
    }

    // Session lease: lifetime is the creating connection.
    const signal = spec.connectionSignal;
    if (signal === undefined) {
      throw new LeaseError(
        "SBX_LEASE_INVALID",
        "session timeout requires a connectionSignal",
      );
    }
    const entry: LeaseEntry = {
      id,
      sandboxId: spec.sandboxId,
      kind: "session",
      generation: 1,
      deadlineUnixMs: undefined,
      cleanup: () => {},
      settled: false,
    };
    // A lifetime controller lets `once` + `signal` auto-detach the listener on
    // settle/revoke without leaking a handler on the caller's AbortSignal.
    const lifetime = new AbortController();
    entry.cleanup = () => lifetime.abort();
    this.#leases.set(id, entry);
    if (signal.aborted) {
      // Defensive: the wire layer never passes a pre-aborted signal, but if it
      // did, settle after `create` returns so the caller still gets the lease.
      queueMicrotask(() => this.#settle(entry));
    } else {
      signal.addEventListener("abort", () => this.#settle(entry), {
        once: true,
        signal: lifetime.signal,
      });
    }
    return snapshot(entry);
  }

  /**
   * Extend a lease's deadline by up to `maxExtendMs` and bump its generation,
   * returning the **actual** new deadline (upstream `Lease.renew`). Rejects a
   * session lease (`SBX_LEASE_KIND`), an unknown lease (`SBX_LEASE_NOT_FOUND`),
   * or one already past its deadline (`SBX_LEASE_EXPIRED`).
   */
  renew(id: string, requestedMs: number): LeaseRenewal {
    const entry = this.#requireExtendable(id, requestedMs);
    entry.generation += 1;
    return {
      id: entry.id,
      generation: entry.generation,
      deadlineUnixMs: entry.deadlineUnixMs!,
    };
  }

  /**
   * Extend a lease's deadline by up to `maxExtendMs`, returning the **actual**
   * new absolute deadline (upstream `HostSandbox.extendTimeout` — "≤30 min per
   * call, returns the actual new deadline"). Does not bump generation. Same
   * rejections as {@linkcode LeaseManager.renew}.
   */
  extendTimeout(id: string, requestedMs: number): number {
    return this.#requireExtendable(id, requestedMs).deadlineUnixMs!;
  }

  /**
   * Explicit release: settle the lease and fire `onExpire` (upstream
   * `Lease.release` / a client `close()` on a session sandbox). Idempotent —
   * releasing an unknown or already-settled lease is a no-op.
   */
  release(id: string): void {
    const entry = this.#leases.get(id);
    if (entry !== undefined) this.#settle(entry);
  }

  /**
   * Silently drop one lease — cancel its timer / detach its signal, **without**
   * firing `onExpire`. For dropping a lease whose sandbox is already being
   * reclaimed elsewhere. Idempotent.
   */
  revoke(id: string): void {
    const entry = this.#leases.get(id);
    if (entry !== undefined) this.#discard(entry);
  }

  /**
   * Silently drop every lease (hostd restart, DESIGN.md §6). Fires no
   * `onExpire` — rootd's destructive reconcile does the killing — and cannot
   * double-fire an already-settled lease.
   */
  revokeAll(): void {
    for (const entry of [...this.#leases.values()]) this.#discard(entry);
  }

  #requireExtendable(id: string, requestedMs: number): LeaseEntry {
    if (!Number.isSafeInteger(requestedMs) || requestedMs <= 0) {
      throw new LeaseError(
        "SBX_LEASE_INVALID",
        "extension must be a positive integer of milliseconds",
      );
    }
    const entry = this.#leases.get(id);
    if (entry === undefined) {
      throw new LeaseError("SBX_LEASE_NOT_FOUND", `no live lease ${id}`);
    }
    if (entry.kind !== "duration" || entry.deadlineUnixMs === undefined) {
      throw new LeaseError(
        "SBX_LEASE_KIND",
        "only duration leases carry an extendable deadline",
      );
    }
    // Defensive against a not-yet-fired timer: a lease at/after its deadline is
    // expired and must not be revivable.
    if (entry.deadlineUnixMs <= this.#clock.now()) {
      throw new LeaseError("SBX_LEASE_EXPIRED", `lease ${id} has expired`);
    }
    const grant = Math.min(requestedMs, this.#maxExtendMs);
    entry.deadlineUnixMs += grant;
    entry.cleanup();
    const timer = this.#clock.setTimer(
      entry.deadlineUnixMs,
      () => this.#settle(entry),
    );
    entry.cleanup = () => timer.cancel();
    return entry;
  }

  /** Settle a lease and fire the kill hook exactly once. */
  #settle(entry: LeaseEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.cleanup();
    this.#leases.delete(entry.id);
    this.#onExpire(entry.sandboxId);
  }

  /** Drop a lease with no kill hook, exactly once. */
  #discard(entry: LeaseEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.cleanup();
    this.#leases.delete(entry.id);
  }
}

function snapshot(entry: LeaseEntry): Lease {
  return {
    id: entry.id,
    sandboxId: entry.sandboxId,
    kind: entry.kind,
    generation: entry.generation,
    deadlineUnixMs: entry.deadlineUnixMs,
  };
}
