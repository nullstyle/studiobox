/**
 * The hostd -> rootd bridge factory over the supervisor wire (PLAN.md §M8).
 *
 * This is the real two-daemon half of the ticketed tunnel, in TWO phases so the
 * launch-scoped `agentCredential` can reach the client at `openTunnel` time
 * (PLAN.md §M8) while the guest is still never dialed before the ticket burns:
 *
 *   1. RESERVE (at `openTunnel`, before any ticket exists): ask rootd (over the
 *      `schema/supervisor.capnp` plane, via the {@linkcode RootdGateway}) to
 *      `openBridge` — rootd mints a one-shot grant naming a per-bridge loopback
 *      UDS + a 32-byte `bridgeCredential` PLUS the launch-scoped `agentCredential`,
 *      and stands up the {@link BridgeServer} splice behind it (which binds the
 *      UDS but does NOT dial the guest yet). The reservation surfaces the
 *      `agentCredential` so `HostSandbox.openTunnel` returns it to the client.
 *   2. CONNECT (after the {@link TunnelServer} has burned the single-use ticket):
 *      dial that UDS and present the `bridgeCredential` in the fixed `SBXBRG1`
 *      preface (`bridge_preface`); rootd verifies it and only THEN dials the
 *      guest vsock. On `SBXBRA1(Ok)` the raw duplex is a verbatim byte pipe to
 *      the guest agent, which the outer {@link TunnelServer} splices onto the
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
  BridgeReservation,
  PrivilegedBridgeRequest,
  PrivilegedBridgeReserver,
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
 * Adapts a {@linkcode RootdGateway} into the {@linkcode PrivilegedBridgeReserver}
 * the tunnel path consumes. Every reservation is a fresh rootd `openBridge`
 * grant; its `connect` is a fresh credential-authenticated UDS dial. Nothing is
 * reused across tunnels.
 */
export class WireBridgeFactory implements PrivilegedBridgeReserver<Deno.Conn> {
  readonly #gateway: RootdGateway;
  readonly #openTimeoutMs: number;
  readonly #now: () => number;

  constructor(gateway: RootdGateway, options: WireBridgeFactoryOptions = {}) {
    this.#gateway = gateway;
    this.#openTimeoutMs = options.openTimeoutMs ??
      DEFAULT_BRIDGE_OPEN_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reserve the bridge: ask rootd to `openBridge` — minting the grant (the
   * launch-scoped `agentCredential`, the per-bridge UDS + `bridgeCredential`)
   * and standing up rootd's per-bridge splice server — WITHOUT dialing the
   * guest. The returned reservation's {@linkcode BridgeReservation.connect}
   * performs the credential-authenticated UDS dial that reaches the guest, and
   * the tunnel calls it only after burning the single-use ticket.
   */
  async reserveBridge(
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<BridgeReservation<Deno.Conn>> {
    signal?.throwIfAborted();
    const grant = await this.#gateway.openBridge(this.#wireRequest(request));
    const socketPath = grant.socketPath;
    const bridgeCredential = grant.bridgeCredential.slice();
    const openTimeoutMs = this.#openTimeoutMs;
    return {
      agentCredential: grant.agentCredential.slice(),
      connect: (connectSignal?: AbortSignal): Promise<Deno.Conn> =>
        connectGrantedBridge(
          socketPath,
          bridgeCredential,
          openTimeoutMs,
          connectSignal,
        ),
      // rootd's per-bridge server self-frees on its dial-budget TTL when no
      // credential preface arrives, so an un-dialed reservation needs no RPC to
      // reclaim; close() is a best-effort marker (there is no un-openBridge).
      close: (): Promise<void> => Promise.resolve(),
    };
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

/**
 * Dial a reserved bridge's UDS and present the `bridgeCredential` in the fixed
 * `SBXBRG1` preface; on `SBXBRA1(Ok)` return the raw duplex (now a verbatim byte
 * pipe to the guest agent's vsock). Any failure closes the conn before throwing,
 * tagged `SBX_SUP_UNAVAILABLE` so the outer tunnel server maps it onto the
 * `SupervisorUnavailable` ACK status.
 */
async function connectGrantedBridge(
  socketPath: string,
  bridgeCredential: Uint8Array,
  openTimeoutMs: number,
  signal?: AbortSignal,
): Promise<Deno.Conn> {
  signal?.throwIfAborted();
  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: socketPath });
  } catch (error) {
    throw new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      `bridge socket ${socketPath} is unreachable: ${errorText(error)}`,
      error,
    );
  }

  try {
    await writeAll(conn, encodeBridgeRequest(bridgeCredential));
    const response = await readBridgeResponse(asPrefaceReader(conn), {
      timeoutMs: openTimeoutMs,
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
