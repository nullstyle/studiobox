/**
 * The studiobox-rootd bridge factory (PLAN.md §M7; DESIGN.md §4).
 *
 * The unprivileged {@linkcode TunnelAuthorizer} in studiobox-hostd burns the
 * single-use ticket, then asks for a bridge. This adapter is the privileged
 * half: it dials the guest agent's vsock for the named execution and hands
 * back the raw duplex the tunnel server splices bytes across. It never sees a
 * ticket — the burn already happened by contract.
 *
 * In the real topology `dial` is a bounded `vm.vsock.connect(AGENT_PORT)` via
 * {@linkcode SupervisorCore.connectBridge}; in the host-safe fake tier a UDS
 * conn to an in-process studioboxd stands in, injected through this same seam.
 *
 * @module
 */

import type {
  PrivilegedBridgeFactory,
  PrivilegedBridgeRequest,
} from "../hostd/tunnel_authorizer.ts";
import type { SupervisorCore } from "./supervisor_core.ts";

export interface SupervisorBridgeFactoryOptions {
  /** Bound (ms) for the guest vsock dial (dial races VMM death → typed error). */
  readonly dialTimeoutMs?: number;
}

/** Default guest-vsock dial budget (< the 15s ticket TTL). */
export const DEFAULT_BRIDGE_DIAL_TIMEOUT_MS = 8_000;

/**
 * Adapts a {@linkcode SupervisorCore} into the {@linkcode PrivilegedBridgeFactory}
 * the tunnel path consumes: `openBridge` dials the guest agent for the request's
 * execution + guest port and returns the live byte stream, bounded so a dial
 * that races the VMM's death yields the supervisor's typed error, not a hang.
 */
export class SupervisorBridgeFactory
  implements PrivilegedBridgeFactory<Deno.Conn> {
  readonly #core: Pick<SupervisorCore, "connectBridge">;
  readonly #dialTimeoutMs: number;

  constructor(
    core: Pick<SupervisorCore, "connectBridge">,
    options: SupervisorBridgeFactoryOptions = {},
  ) {
    this.#core = core;
    this.#dialTimeoutMs = options.dialTimeoutMs ??
      DEFAULT_BRIDGE_DIAL_TIMEOUT_MS;
  }

  openBridge(
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<Deno.Conn> {
    return this.#core.connectBridge(
      { executionId: request.executionId, guestPort: request.guestPort },
      {
        retryTimeoutMs: this.#dialTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }
}
