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
