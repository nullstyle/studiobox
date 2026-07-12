/**
 * Pure in-memory subnet / TAP allocator for the Tier-B networking dataplane
 * (DESIGN networking-dataplane.md §1, §2).
 *
 * A single private `10.201.0.0/16` pool is carved into `/30` subnets — the
 * smallest subnet that yields a usable host+guest pair (`.0` network, `.1` host
 * gateway, `.2` guest, `.3` broadcast), which is exactly the point-to-point
 * shape one sandbox NIC needs. A `/16` gives **16384** concurrent slots, far
 * above any single-host sandbox count, and keeps the whole pool a single CIDR
 * for the one shared NAT / isolation rule (§3).
 *
 * The allocator is a **lowest-free-slot bitmap** — collision-free by
 * construction (a slot is handed to exactly one live execution and reused only
 * after {@linkcode SubnetAllocator.release}). It is deliberately *not* a hash of
 * the execution id: hashing an id onto a `/30` risks a birthday collision that
 * would silently bridge two sandboxes onto one subnet, which is unacceptable.
 * The allocated `slot` is journaled (§9) so it is authoritative across a
 * supervisor crash, and {@linkcode SubnetAllocator.reserve} rebuilds the in-use
 * bitmap from journaled records on cold reconcile (§8).
 *
 * Everything here is pure — no subprocess, no host state — so slot math, reuse,
 * and exhaustion are asserted in unit tests with no host access.
 *
 * @module
 */

/** Prefix of every allocated TAP device name: `sbxtap<slot>` (§2). */
export const TAP_NAME_PREFIX = "sbxtap";

/** Default pool CIDR, carved into `/30` subnets. Operator-overridable (§1). */
export const DEFAULT_POOL_CIDR = "10.201.0.0/16";

/** `/30` — the fixed per-sandbox subnet width. */
const SUBNET_PREFIX = 30;

/** `/16` — the fixed pool width the slot math (`third = i >> 6`) assumes. */
const POOL_PREFIX = 16;

/** Slots per `/16` pool: one `/30` per slot ⇒ `2^(30-16)` = 16384. */
const SLOT_COUNT = 1 << (SUBNET_PREFIX - POOL_PREFIX);

/** One sandbox's host-side network addressing, derived purely from its slot. */
export interface SubnetAllocation {
  /** 0..16383 slot index; journaled and the natural teardown / reuse key. */
  readonly slot: number;
  /** Host-side TAP device name, `sbxtap<slot>` (§2). */
  readonly tapName: string;
  /** The `/30` network in CIDR form, `10.201.<t>.<b>/30`. */
  readonly subnet: string;
  /** Host / gateway address on the TAP, `10.201.<t>.<b+1>`. */
  readonly hostIp: string;
  /** Guest address, `10.201.<t>.<b+2>` (anti-spoof source, §12). */
  readonly guestIp: string;
  /** Guest address in CIDR form for the `ip=` cmdline, `10.201.<t>.<b+2>/30`. */
  readonly guestCidr: string;
  /** Locally-administered unicast MAC, `02:00:0a:c9:<t-hex>:<b+2-hex>` (§4). */
  readonly guestMac: string;
}

/** The allocation contract (§1). Implemented by {@linkcode BitmapSubnetAllocator}. */
export interface SubnetAllocator {
  /**
   * Hand out the lowest free slot's allocation. Throws
   * {@linkcode SubnetPoolExhaustedError} when the pool is full.
   */
  allocate(executionId: string): SubnetAllocation;
  /** Idempotent free of a slot (a double-free is a no-op). */
  release(slot: number): void;
  /** Mark a slot in-use; rebuilds the bitmap from journaled records (§8). */
  reserve(slot: number): void;
}

/** Raised by {@linkcode SubnetAllocator.allocate} when the pool is full. */
export class SubnetPoolExhaustedError extends Error {
  /**
   * Stable machine-readable code. hostd surfaces this as capacity pressure and
   * maps it to `SBX_HOST_STATE` (§1). Should never fire before the memory / vcpu
   * capacity ledger caps the host far below 16384.
   */
  readonly code: "SBX_NET_EXHAUSTED" = "SBX_NET_EXHAUSTED";
  constructor(message: string) {
    super(message);
    this.name = "SubnetPoolExhaustedError";
  }
}

/** Options for {@linkcode BitmapSubnetAllocator}. */
export interface SubnetAllocatorOptions {
  /**
   * Pool CIDR carved into `/30` subnets. Must be a `/16` (the slot math assumes
   * it) and must not overlap the Lima host bridge, `docker0`, or guest loopback.
   * @default "10.201.0.0/16"
   */
  readonly poolCidr?: string;
}

interface PoolPrefix {
  readonly octet1: number;
  readonly octet2: number;
}

/** Two-hex-digit, lowercase, zero-padded rendering of a 0..255 octet. */
function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Parse and validate a `/16` pool CIDR into its two fixed leading octets. The
 * `/30` slot math (`third = i >> 6`, `base4 = (i & 63) << 2`) only holds for a
 * `/16`, so any other prefix is rejected fail-closed.
 */
function parsePoolPrefix(poolCidr: string): PoolPrefix {
  const [network, prefixText, ...rest] = poolCidr.split("/");
  if (rest.length > 0 || prefixText === undefined) {
    throw new RangeError(`invalid pool CIDR: ${poolCidr}`);
  }
  if (Number(prefixText) !== POOL_PREFIX) {
    throw new RangeError(`pool CIDR must be a /${POOL_PREFIX}: ${poolCidr}`);
  }
  const octets = network.split(".");
  if (octets.length !== 4) {
    throw new RangeError(`invalid pool CIDR: ${poolCidr}`);
  }
  const parsed = octets.map((o) => Number(o));
  for (const o of parsed) {
    if (!Number.isInteger(o) || o < 0 || o > 255) {
      throw new RangeError(`invalid pool CIDR: ${poolCidr}`);
    }
  }
  return { octet1: parsed[0], octet2: parsed[1] };
}

/**
 * The pure slot → addresses function (§1). Deterministic and collision-free:
 *
 * ```text
 * third   = slot >> 6            // 64 /30s per third-octet
 * base4   = (slot & 63) << 2     // 0,4,8,…,252
 * network = <o1>.<o2>.<third>.<base4>       // .0/30
 * hostIp  = <o1>.<o2>.<third>.<base4 + 1>   // .1 (host / gateway)
 * guestIp = <o1>.<o2>.<third>.<base4 + 2>   // .2 (guest)
 * ```
 *
 * The MAC is locally-administered (`0x02` low bit) and unicast, derived from the
 * pool prefix (`0a:c9` for `10.201`) plus the guest IP's low 16 bits, so it is
 * unique per slot and deterministic (§4).
 *
 * @throws {RangeError} if `slot` is out of range or `poolCidr` is not a `/16`.
 */
export function subnetForSlot(
  slot: number,
  poolCidr: string = DEFAULT_POOL_CIDR,
): SubnetAllocation {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new RangeError(`slot ${slot} out of range 0..${SLOT_COUNT - 1}`);
  }
  const { octet1, octet2 } = parsePoolPrefix(poolCidr);
  return computeAllocation(slot, octet1, octet2);
}

/** Slot math shared by {@linkcode subnetForSlot} and the allocator's fast path. */
function computeAllocation(
  slot: number,
  octet1: number,
  octet2: number,
): SubnetAllocation {
  const third = slot >> 6;
  const base4 = (slot & 63) << 2;
  const network = `${octet1}.${octet2}.${third}.${base4}`;
  const hostIp = `${octet1}.${octet2}.${third}.${base4 + 1}`;
  const guestIp = `${octet1}.${octet2}.${third}.${base4 + 2}`;
  return {
    slot,
    tapName: `${TAP_NAME_PREFIX}${slot}`,
    subnet: `${network}/${SUBNET_PREFIX}`,
    hostIp,
    guestIp,
    guestCidr: `${guestIp}/${SUBNET_PREFIX}`,
    guestMac: `02:00:${hex2(octet1)}:${hex2(octet2)}:${hex2(third)}:${
      hex2(base4 + 2)
    }`,
  };
}

/**
 * The lowest-free-slot bitmap {@linkcode SubnetAllocator} (§1). A linear scan
 * from slot 0 always hands out the lowest free slot, so a slot freed by
 * {@linkcode BitmapSubnetAllocator.release} is the first reused — matching the
 * "reuse-after-reclaim finds a clean `sbxtap<slot>`" invariant (§1).
 */
export class BitmapSubnetAllocator implements SubnetAllocator {
  readonly #octet1: number;
  readonly #octet2: number;
  /** One byte per slot: `0` free, `1` in-use. */
  readonly #used: Uint8Array;
  #inUse = 0;

  constructor(options: SubnetAllocatorOptions = {}) {
    const { octet1, octet2 } = parsePoolPrefix(
      options.poolCidr ?? DEFAULT_POOL_CIDR,
    );
    this.#octet1 = octet1;
    this.#octet2 = octet2;
    this.#used = new Uint8Array(SLOT_COUNT);
  }

  /** Number of slots currently marked in-use. */
  get inUse(): number {
    return this.#inUse;
  }

  allocate(_executionId: string): SubnetAllocation {
    // `_executionId` is not used for slot selection — lowest-free is
    // deterministic and collision-free without it — but stays in the signature
    // per §1 so a future id→slot affinity is a non-breaking change.
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (this.#used[slot] === 0) {
        this.#used[slot] = 1;
        this.#inUse++;
        return computeAllocation(slot, this.#octet1, this.#octet2);
      }
    }
    throw new SubnetPoolExhaustedError(
      `subnet pool exhausted: all ${SLOT_COUNT} /30 slots in use`,
    );
  }

  release(slot: number): void {
    this.#assertSlot(slot);
    if (this.#used[slot] === 1) {
      this.#used[slot] = 0;
      this.#inUse--;
    }
  }

  reserve(slot: number): void {
    this.#assertSlot(slot);
    if (this.#used[slot] === 0) {
      this.#used[slot] = 1;
      this.#inUse++;
    }
  }

  #assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
      throw new RangeError(
        `slot ${slot} out of range 0..${SLOT_COUNT - 1}`,
      );
    }
  }
}
