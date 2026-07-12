/**
 * The hostd -> rootd bridge factory over the supervisor wire (PLAN.md §M8).
 *
 * This is the real two-daemon half of the ticketed tunnel. When hostd's
 * {@link TunnelServer} has burned the single-use ticket it asks its
 * {@linkcode PrivilegedBridgeFactory} to open the guest bridge; this
 * implementation:
 *
 *   1. asks rootd (over the `schema/supervisor.capnp` plane, via the
 *      {@linkcode RootdGateway}) to `openBridge` — rootd mints a one-shot grant
 *      naming a per-bridge loopback UDS + a 32-byte `bridgeCredential`, and
 *      stands up the {@link BridgeServer} splice behind it;
 *   2. dials that UDS and presents the `bridgeCredential` in the fixed
 *      `SBXBRG1` preface (`bridge_preface`);
 *   3. on `SBXBRA1(Ok)` returns the raw duplex — now a verbatim byte pipe to the
 *      guest agent's vsock, which the outer {@link TunnelServer} splices onto the
 *      external tunnel connection.
 *
 * So the assembled tunnel is two spliced hops:
 *
 *   client <-> hostd TunnelServer <-> [bridge UDS] <-> rootd BridgeServer <-> guest vsock
 *
 * Bounded like every other dial on the path: the `openBridge` call is bounded by
 * the gateway's own timeout, and the UDS connect + preface + ACK are each
 * deadline-guarded (the budget is < the 15s bridge/ticket TTL). Any failure
 * closes the connection before throwing, so a failed open leaks nothing. The
 * thrown error carries `code === "SBX_SUP_UNAVAILABLE"` so the outer tunnel
 * server maps it onto the `SupervisorUnavailable` ACK status (a probe learns the
 * dial failed, not why).
 *
 * @module
 */

import type {
  PrivilegedBridgeFactory,
  PrivilegedBridgeRequest,
} from "./tunnel_authorizer.ts";
import type { RootdGateway } from "./supervisor_client.ts";
import type { SupervisorBridgeRequest } from "../rootd/supervisor_core_api.ts";
import { SupervisorError } from "../rootd/supervisor_core_api.ts";
import {
  BridgeStatus,
  encodeBridgeRequest,
  readBridgeResponse,
} from "../transports/bridge_preface.ts";

/** Default budget for the UDS connect + preface + ACK (< the 15s bridge TTL). */
export const DEFAULT_BRIDGE_OPEN_TIMEOUT_MS = 8_000;
/** How far ahead the wire bridge request's grant TTL is set (< MAX_BRIDGE_TTL_MS). */
const BRIDGE_REQUEST_TTL_MS = 10_000;

export interface WireBridgeFactoryOptions {
  /** Bound (ms) for the UDS connect + preface + ACK. */
  readonly openTimeoutMs?: number;
  /** Injected clock (tests); defaults to {@link Date.now}. */
  readonly now?: () => number;
}

/**
 * Adapts a {@linkcode RootdGateway} into the {@linkcode PrivilegedBridgeFactory}
 * the tunnel path consumes. Every open is a fresh rootd `openBridge` grant + a
 * fresh credential-authenticated UDS dial; nothing is reused across tunnels.
 */
export class WireBridgeFactory implements PrivilegedBridgeFactory<Deno.Conn> {
  readonly #gateway: RootdGateway;
  readonly #openTimeoutMs: number;
  readonly #now: () => number;

  constructor(gateway: RootdGateway, options: WireBridgeFactoryOptions = {}) {
    this.#gateway = gateway;
    this.#openTimeoutMs = options.openTimeoutMs ??
      DEFAULT_BRIDGE_OPEN_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  async openBridge(
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<Deno.Conn> {
    signal?.throwIfAborted();
    const grant = await this.#gateway.openBridge(
      this.#wireRequest(request),
    );

    let conn: Deno.Conn;
    try {
      conn = await Deno.connect({ transport: "unix", path: grant.socketPath });
    } catch (error) {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `bridge socket ${grant.socketPath} is unreachable: ${errorText(error)}`,
        error,
      );
    }

    try {
      await writeAll(conn, encodeBridgeRequest(grant.bridgeCredential));
      const response = await readBridgeResponse(asPrefaceReader(conn), {
        timeoutMs: this.#openTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      if (response.status !== BridgeStatus.Ok) {
        throw new SupervisorError(
          "SBX_SUP_UNAVAILABLE",
          `rootd bridge refused the credential (status ${response.status})`,
        );
      }
      return conn;
    } catch (error) {
      safeClose(conn);
      if (error instanceof SupervisorError) throw error;
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `bridge handshake failed: ${errorText(error)}`,
        error,
      );
    }
  }

  /**
   * Build the wire bridge request from the privileged (public-id) request.
   *
   * rootd resolves the target execution by `executionId` and cross-checks the
   * `sandboxId` against the journaled record, whose id uses the hyphen grammar
   * (`sbx-loc-…`) — so the public `sbx_loc_…` id is mapped back by swapping the
   * separators (the exact inverse of the id minted in `control_core.create`).
   * `leaseId` / `leaseGeneration` / `tunnelNonce` / `expiresAtUnixMs` are
   * wire-validated by rootd but not otherwise interpreted at Tier A (hostd is
   * the lease authority), so a fresh nonce + a near-term TTL suffice.
   */
  #wireRequest(request: PrivilegedBridgeRequest): SupervisorBridgeRequest {
    return {
      sandboxId: request.sandboxId.replaceAll("_", "-"),
      executionId: request.executionId,
      leaseId: `bridge-${request.executionId}`,
      leaseGeneration: 1,
      tunnelNonce: crypto.getRandomValues(new Uint8Array(32)),
      expiresAtUnixMs: this.#now() + BRIDGE_REQUEST_TTL_MS,
    };
  }
}

function asPrefaceReader(conn: Deno.Conn) {
  return {
    read: (destination: Uint8Array): Promise<number | null> =>
      conn.read(destination),
    close: (): void => safeClose(conn),
  };
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

function safeClose(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
