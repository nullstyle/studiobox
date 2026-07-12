/** Random, bound, expiring, single-use tunnel tickets. */

export const TUNNEL_TICKET_BYTES = 32;
export const DEFAULT_TUNNEL_TICKET_TTL_MS = 15_000;

export interface TunnelTicketBinding {
  sessionId: string;
  sandboxId: string;
  bootNonce: string;
  leaseGeneration: number;
}

export interface IssuedTunnelTicket {
  ticket: Uint8Array;
  expiresAt: number;
}

interface StoredTicket {
  binding: TunnelTicketBinding;
  expiresAt: number;
}

export interface SingleUseTicketStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxOutstanding?: number;
}

export class TicketRejectedError extends Error {
  readonly code = "SBX_TICKET_REJECTED";

  constructor() {
    super("ticket rejected");
    this.name = "TicketRejectedError";
  }
}

export class TicketCapacityError extends Error {
  readonly code = "SBX_TICKET_CAPACITY";

  constructor(limit: number) {
    super(`outstanding tunnel ticket limit ${limit} reached`);
    this.name = "TicketCapacityError";
  }
}

export class SingleUseTicketStore {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxOutstanding: number;
  readonly #tickets = new Map<string, StoredTicket>();

  constructor(options: SingleUseTicketStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TUNNEL_TICKET_TTL_MS;
    this.#maxOutstanding = options.maxOutstanding ?? 4_096;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError("ticket ttl must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.#maxOutstanding) || this.#maxOutstanding <= 0
    ) {
      throw new RangeError("ticket capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.#tickets.size;
  }

  async issue(binding: TunnelTicketBinding): Promise<IssuedTunnelTicket> {
    assertBinding(binding);
    this.sweepExpired();
    if (this.#tickets.size >= this.#maxOutstanding) {
      throw new TicketCapacityError(this.#maxOutstanding);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const ticket = crypto.getRandomValues(
        new Uint8Array(TUNNEL_TICKET_BYTES),
      );
      const verifier = await ticketVerifier(ticket);
      if (this.#tickets.has(verifier)) continue;
      const expiresAt = this.#now() + this.#ttlMs;
      this.#tickets.set(verifier, {
        binding: { ...binding },
        expiresAt,
      });
      return { ticket: ticket.slice(), expiresAt };
    }
    throw new Error("unable to allocate a unique tunnel ticket");
  }

  async consume(
    ticket: Uint8Array,
    binding: TunnelTicketBinding,
  ): Promise<void> {
    assertBinding(binding);
    if (ticket.byteLength !== TUNNEL_TICKET_BYTES) {
      throw new TicketRejectedError();
    }
    const verifier = await ticketVerifier(ticket);
    const stored = this.#tickets.get(verifier);
    // Burn a ticket ONLY when its stored binding matches the endpoint that is
    // presenting it. The store is shared across every sandbox in a
    // HostControlCore, so burning on mere possession would let a valid ticket
    // for sandbox A, replayed at sandbox B's tunnel endpoint, be consumed even
    // though it does not authorize B — a cross-endpoint griefing/denial vector.
    // Gating the burn on the binding closes that: a wrong-endpoint (or unknown)
    // ticket is rejected without being spent, so its legitimate holder can
    // still redeem it. The remaining timing distinction is non-exploitable —
    // reaching the burn path requires presenting a ticket whose binding the
    // caller already possesses, so it leaks nothing an attacker did not have.
    const matchesEndpoint = stored !== undefined &&
      sameBinding(stored.binding, binding);
    if (matchesEndpoint) {
      this.#tickets.delete(verifier);
    }
    if (
      stored === undefined || stored.expiresAt < this.#now() || !matchesEndpoint
    ) {
      throw new TicketRejectedError();
    }
  }

  revokeSandbox(sandboxId: string): number {
    return this.#revoke((ticket) => ticket.binding.sandboxId === sandboxId);
  }

  revokeSession(sessionId: string): number {
    return this.#revoke((ticket) => ticket.binding.sessionId === sessionId);
  }

  sweepExpired(): number {
    const now = this.#now();
    return this.#revoke((ticket) => ticket.expiresAt < now);
  }

  #revoke(predicate: (ticket: StoredTicket) => boolean): number {
    let revoked = 0;
    for (const [verifier, ticket] of this.#tickets) {
      if (!predicate(ticket)) continue;
      this.#tickets.delete(verifier);
      revoked++;
    }
    return revoked;
  }
}

function assertBinding(binding: TunnelTicketBinding): void {
  if (
    binding.sessionId.length === 0 || binding.sandboxId.length === 0 ||
    binding.bootNonce.length === 0 ||
    !Number.isSafeInteger(binding.leaseGeneration) ||
    binding.leaseGeneration < 0
  ) {
    throw new TypeError("invalid tunnel ticket binding");
  }
}

function sameBinding(
  left: TunnelTicketBinding,
  right: TunnelTicketBinding,
): boolean {
  return left.sessionId === right.sessionId &&
    left.sandboxId === right.sandboxId &&
    left.bootNonce === right.bootNonce &&
    left.leaseGeneration === right.leaseGeneration;
}

/**
 * The lookup key for a ticket: the hex SHA-256 of its bytes. A hostd tunnel
 * router keys its verifier -> route registry by this so it can resolve a
 * presented ticket to its route WITHOUT burning it (the burn happens on the
 * binding-matched {@link SingleUseTicketStore.consume} once the route is found).
 * Exported so the router computes the same key the store does.
 */
export async function ticketVerifier(ticket: Uint8Array): Promise<string> {
  const input = Uint8Array.from(ticket);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
