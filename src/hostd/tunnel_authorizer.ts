/** Unprivileged authorization gate in front of privileged vsock work. */

import {
  type SingleUseTicketStore,
  TicketRejectedError,
  type TunnelTicketBinding,
} from "../security/tickets.ts";

export interface PrivilegedBridgeRequest {
  sandboxId: string;
  executionId: string;
  guestPort: number;
}

export interface PrivilegedBridgeFactory<Bridge> {
  openBridge(
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<Bridge>;
}

/**
 * A reserved-but-not-yet-dialed guest bridge (PLAN.md §M8). The rootd grant —
 * and with it the launch-scoped `agentCredential` the client presents to the
 * guest agent's `authenticate` — is already minted, but the guest vsock is NOT
 * dialed until {@linkcode BridgeReservation.connect} runs. `HostSandbox.openTunnel`
 * reserves the bridge up front so it can return `agentCredential` to the client;
 * the tunnel only calls `connect` AFTER the single-use ticket is burned, which
 * preserves the load-bearing invariant that the guest vsock is never reached
 * without a burned ticket (DESIGN.md §4) — reserving merely mints the grant and
 * binds rootd's per-bridge UDS; the credential preface that triggers the guest
 * dial rides in only post-burn.
 */
export interface BridgeReservation<Bridge> {
  /** The launch-scoped guest-agent credential (32..512 bytes). */
  readonly agentCredential: Uint8Array;
  /** Dial the guest bridge and present the credential preface. One-shot. */
  connect(signal?: AbortSignal): Promise<Bridge>;
  /** Release the reservation if the tunnel is torn down before it is dialed. */
  close(): Promise<void>;
}

/**
 * Reserves a guest bridge WITHOUT reaching the guest: mints the rootd grant
 * (yielding the `agentCredential`) and hands back a {@linkcode BridgeReservation}
 * whose `connect` performs the credential-authenticated dial that reaches the
 * guest. {@linkcode WireBridgeFactory} implements it over the supervisor wire.
 */
export interface PrivilegedBridgeReserver<Bridge> {
  reserveBridge(
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<BridgeReservation<Bridge>>;
}

/**
 * Enforces the key trust-boundary ordering: external tickets are validated and
 * irreversibly burned by unprivileged studiobox-hostd before studiobox-rootd
 * is contacted.
 */
export class TunnelAuthorizer<Bridge> {
  readonly #tickets: SingleUseTicketStore;
  readonly #bridges: PrivilegedBridgeFactory<Bridge>;

  constructor(
    tickets: SingleUseTicketStore,
    bridges: PrivilegedBridgeFactory<Bridge>,
  ) {
    this.#tickets = tickets;
    this.#bridges = bridges;
  }

  async authorizeAndOpen(
    ticket: Uint8Array,
    binding: TunnelTicketBinding,
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<Bridge> {
    await this.#tickets.consume(ticket, binding);
    signal?.throwIfAborted();
    if (request.sandboxId !== binding.sandboxId) {
      throw new TicketRejectedError();
    }
    assertBridgeRequest(request);
    return await this.#bridges.openBridge({ ...request }, signal);
  }
}

function assertBridgeRequest(request: PrivilegedBridgeRequest): void {
  if (request.executionId.length === 0 || request.executionId.length > 64) {
    throw new TypeError("execution id must be 1-64 characters");
  }
  if (
    !Number.isSafeInteger(request.guestPort) || request.guestPort < 1 ||
    request.guestPort > 65_535
  ) {
    throw new RangeError("guest port must be between 1 and 65535");
  }
}
