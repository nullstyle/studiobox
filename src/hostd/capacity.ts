/**
 * Host capacity ledger (DESIGN §9).
 *
 * hostd commits guest memory, vCPUs, overlay disk, and forward ports against a
 * fixed host budget. `reserve()` either fits and commits, or fails fast with a
 * {@link HostCapacityError} naming the exhausted dimension — there is no
 * queueing (upstream parity: `create()` fits or throws). `release()` frees a
 * reservation exactly once; `capacity()`/`usage()` report committed-vs-total so
 * callers can schedule instead of colliding.
 *
 * The ledger is the only writer of its counters, but `reserve()`/`release()`
 * are serialized through an in-process mutex (mirroring the state store): the
 * check-then-commit must be atomic across `await` points so two racing reserves
 * can never both claim the last slot.
 */

import { HostCapacityError } from "../api/errors.ts";
import { type Memory, parseMemory } from "../api/memory.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Upstream fixes every sandbox at two vCPUs. */
export const VCPUS_PER_SANDBOX = 2;

/** Which budget dimension a rejected reservation would exhaust. */
export type CapacityDimension =
  | "memory"
  | "vcpu"
  | "disk"
  | "ports"
  | "sandboxes";

/**
 * A capacity rejection that names the exhausted dimension. Extends the shared
 * {@link HostCapacityError} so existing `instanceof HostCapacityError` callers
 * (and the wire error mapping) keep working.
 */
export class HostCapacityExhaustedError extends HostCapacityError {
  constructor(
    readonly dimension: CapacityDimension,
    message: string,
  ) {
    super(message);
    this.name = "HostCapacityExhaustedError";
  }
}

/** Inclusive-start, exclusive-end range of reservable forward ports. */
export interface PortRange {
  start: number;
  end: number;
}

/** Raw host budget, before the daemon/headroom reserve is subtracted. */
export interface HostBudget {
  /** Total host vCPUs available to sandboxes + daemons. */
  vcpus: number;
  /** Total guest-memory budget in MiB. */
  memoryMiB: number;
  /** Total overlay-disk budget in bytes. */
  diskBytes: number;
  /** Reserved forward-port range for tunnels / exposeHttp. */
  portRange: PortRange;
}

/** Resources withheld from sandboxes for the daemons and safety headroom. */
export interface HostHeadroom {
  vcpus: number;
  memoryMiB: number;
  diskBytes: number;
}

export interface CapacityLedgerOptions {
  /** Raw host budget. Defaults to 4 vCPU / 8 GiB / 60 GiB (DESIGN §9). */
  budget?: Partial<HostBudget>;
  /** Daemon/headroom reserve subtracted from the budget. */
  headroom?: Partial<HostHeadroom>;
  /**
   * Hard cap on concurrent sandboxes. Defaults to
   * `floor(effectiveVcpus / VCPUS_PER_SANDBOX)`.
   */
  maxSandboxes?: number;
  /**
   * Async admission barrier run inside the critical section, after the fit
   * check reads committed state but before it commits. Represents real
   * async admission work; the serialization tests use it to prove the mutex
   * makes check-then-commit atomic. Defaults to a no-op.
   */
  admissionBarrier?: () => void | Promise<void>;
}

/** A request to commit one sandbox's resources. */
export interface ReservationRequest {
  /** Guest memory in the upstream grammar; parsed/clamped to 768–4096 MiB. */
  memory: Memory;
  /** Overlay disk budget for this sandbox, in bytes. */
  diskBytes: number;
  /** Count of forward ports to reserve up front (default 0). */
  ports?: number;
}

/** An opaque, committed reservation handle returned by `reserve()`. */
export interface Reservation {
  readonly id: string;
  readonly memoryMiB: number;
  readonly vcpus: number;
  readonly diskBytes: number;
  readonly ports: readonly number[];
}

/** Host-wide committed-vs-total snapshot; feeds the wire `HostControl.capacity`. */
export interface CapacityReport {
  memoryTotalMiB: number;
  memoryCommittedMiB: number;
  vcpusTotal: number;
  vcpusCommitted: number;
  diskTotalBytes: number;
  diskCommittedBytes: number;
  portsTotal: number;
  portsCommitted: number;
  sandboxLimit: number;
  sandboxCount: number;
}

/** A single reservation's committed resources; feeds the wire `HostSandbox.usage`. */
export interface ReservationUsage {
  memoryMiB: number;
  vcpus: number;
  diskBytes: number;
  ports: readonly number[];
}

const DEFAULT_BUDGET: HostBudget = {
  vcpus: 4,
  memoryMiB: 8 * 1024,
  diskBytes: 60 * GIB,
  portRange: { start: 20_000, end: 20_128 },
};

const DEFAULT_HEADROOM: HostHeadroom = {
  vcpus: 0,
  memoryMiB: 512,
  diskBytes: 0,
};

export class CapacityLedger {
  readonly #vcpusTotal: number;
  readonly #memoryTotalMiB: number;
  readonly #diskTotalBytes: number;
  readonly #portRange: PortRange;
  readonly #portsTotal: number;
  readonly #sandboxLimit: number;
  readonly #admissionBarrier: () => void | Promise<void>;

  #vcpusCommitted = 0;
  #memoryCommittedMiB = 0;
  #diskCommittedBytes = 0;
  readonly #allocatedPorts = new Set<number>();
  readonly #reservations = new Map<string, Reservation>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: CapacityLedgerOptions = {}) {
    const budget = { ...DEFAULT_BUDGET, ...options.budget };
    const headroom = { ...DEFAULT_HEADROOM, ...options.headroom };
    const range = budget.portRange;

    assertNonNegativeInt(budget.vcpus, "budget.vcpus");
    assertNonNegativeInt(budget.memoryMiB, "budget.memoryMiB");
    assertNonNegativeInt(budget.diskBytes, "budget.diskBytes");
    assertNonNegativeInt(headroom.vcpus, "headroom.vcpus");
    assertNonNegativeInt(headroom.memoryMiB, "headroom.memoryMiB");
    assertNonNegativeInt(headroom.diskBytes, "headroom.diskBytes");
    assertNonNegativeInt(range.start, "budget.portRange.start");
    assertNonNegativeInt(range.end, "budget.portRange.end");
    if (range.end < range.start) {
      throw new RangeError("budget.portRange.end must be >= start");
    }

    this.#vcpusTotal = budget.vcpus - headroom.vcpus;
    this.#memoryTotalMiB = budget.memoryMiB - headroom.memoryMiB;
    this.#diskTotalBytes = budget.diskBytes - headroom.diskBytes;
    if (
      this.#vcpusTotal < 0 || this.#memoryTotalMiB < 0 ||
      this.#diskTotalBytes < 0
    ) {
      throw new RangeError("headroom reserve exceeds host budget");
    }

    this.#portRange = { start: range.start, end: range.end };
    this.#portsTotal = range.end - range.start;

    const derivedLimit = Math.floor(this.#vcpusTotal / VCPUS_PER_SANDBOX);
    if (options.maxSandboxes !== undefined) {
      assertNonNegativeInt(options.maxSandboxes, "maxSandboxes");
      this.#sandboxLimit = Math.min(options.maxSandboxes, derivedLimit);
    } else {
      this.#sandboxLimit = derivedLimit;
    }

    this.#admissionBarrier = options.admissionBarrier ?? (() => {});
  }

  /**
   * Commit one sandbox's resources, or throw {@link HostCapacityExhaustedError}
   * naming the first dimension that would overflow. Serialized so racing
   * reserves cannot both claim the last slot.
   */
  async reserve(request: ReservationRequest): Promise<Reservation> {
    // parseMemory (grammar + 768–4096 MiB clamp) runs outside the lock so an
    // invalid request rejects without blocking the queue.
    const memoryMiB = parseMemory(request.memory);
    const diskBytes = request.diskBytes;
    const portCount = request.ports ?? 0;
    assertNonNegativeInt(diskBytes, "request.diskBytes");
    assertNonNegativeInt(portCount, "request.ports");

    return await this.#exclusive(async () => {
      // Resource dimensions first, then the sandbox-count cap. The derived
      // sandbox limit equals the vCPU limit, so checking vCPUs first keeps the
      // `vcpu` dimension reachable; the `sandboxes` dimension then reports only
      // an explicit `maxSandboxes` cap set below what the resources allow.
      if (this.#vcpusCommitted + VCPUS_PER_SANDBOX > this.#vcpusTotal) {
        throw new HostCapacityExhaustedError(
          "vcpu",
          `vCPU budget exhausted: ${this.#vcpusCommitted}/${this.#vcpusTotal} committed, request needs ${VCPUS_PER_SANDBOX}`,
        );
      }
      if (this.#memoryCommittedMiB + memoryMiB > this.#memoryTotalMiB) {
        throw new HostCapacityExhaustedError(
          "memory",
          `memory budget exhausted: ${this.#memoryCommittedMiB}/${this.#memoryTotalMiB} MiB committed, request needs ${memoryMiB} MiB`,
        );
      }
      if (this.#diskCommittedBytes + diskBytes > this.#diskTotalBytes) {
        throw new HostCapacityExhaustedError(
          "disk",
          `disk budget exhausted: ${this.#diskCommittedBytes}/${this.#diskTotalBytes} bytes committed, request needs ${diskBytes} bytes`,
        );
      }
      const freePorts = this.#portsTotal - this.#allocatedPorts.size;
      if (portCount > freePorts) {
        throw new HostCapacityExhaustedError(
          "ports",
          `port range exhausted: ${freePorts} free of ${this.#portsTotal}, request needs ${portCount}`,
        );
      }
      if (this.#reservations.size + 1 > this.#sandboxLimit) {
        throw new HostCapacityExhaustedError(
          "sandboxes",
          `sandbox limit ${this.#sandboxLimit} reached`,
        );
      }

      // Represents async admission work; nothing is committed before it runs,
      // and the mutex keeps the whole check-then-commit atomic.
      await this.#admissionBarrier();

      const ports = this.#allocatePorts(portCount);
      this.#vcpusCommitted += VCPUS_PER_SANDBOX;
      this.#memoryCommittedMiB += memoryMiB;
      this.#diskCommittedBytes += diskBytes;

      const reservation: Reservation = {
        id: crypto.randomUUID(),
        memoryMiB,
        vcpus: VCPUS_PER_SANDBOX,
        diskBytes,
        ports,
      };
      this.#reservations.set(reservation.id, reservation);
      return reservation;
    });
  }

  /**
   * Free a reservation exactly once. Idempotent: releasing an unknown or
   * already-released handle is a no-op, so double-release cannot corrupt the
   * ledger or reclaim another reservation's ports.
   */
  release(reservation: Reservation | string): Promise<void> {
    const id = typeof reservation === "string" ? reservation : reservation.id;
    return this.#exclusive(() => {
      const held = this.#reservations.get(id);
      if (held === undefined) return Promise.resolve();
      this.#reservations.delete(id);
      this.#vcpusCommitted -= held.vcpus;
      this.#memoryCommittedMiB -= held.memoryMiB;
      this.#diskCommittedBytes -= held.diskBytes;
      for (const port of held.ports) this.#allocatedPorts.delete(port);
      return Promise.resolve();
    });
  }

  /** Host-wide committed-vs-total snapshot. */
  capacity(): CapacityReport {
    return {
      memoryTotalMiB: this.#memoryTotalMiB,
      memoryCommittedMiB: this.#memoryCommittedMiB,
      vcpusTotal: this.#vcpusTotal,
      vcpusCommitted: this.#vcpusCommitted,
      diskTotalBytes: this.#diskTotalBytes,
      diskCommittedBytes: this.#diskCommittedBytes,
      portsTotal: this.#portsTotal,
      portsCommitted: this.#allocatedPorts.size,
      sandboxLimit: this.#sandboxLimit,
      sandboxCount: this.#reservations.size,
    };
  }

  /** One reservation's committed resources, or `null` if it is not held. */
  usage(reservation: Reservation | string): ReservationUsage | null {
    const id = typeof reservation === "string" ? reservation : reservation.id;
    const held = this.#reservations.get(id);
    if (held === undefined) return null;
    return {
      memoryMiB: held.memoryMiB,
      vcpus: held.vcpus,
      diskBytes: held.diskBytes,
      ports: [...held.ports],
    };
  }

  /** Allocate `count` distinct, lowest-available ports from the range. */
  #allocatePorts(count: number): number[] {
    const ports: number[] = [];
    for (let port = this.#portRange.start; port < this.#portRange.end; port++) {
      if (ports.length === count) break;
      if (this.#allocatedPorts.has(port)) continue;
      this.#allocatedPorts.add(port);
      ports.push(port);
    }
    return ports;
  }

  /** Serialize a check-then-commit against every other mutation. */
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

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
