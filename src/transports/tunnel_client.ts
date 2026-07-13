/**
 * The external-tunnel CLIENT dial (DESIGN.md §4, client leg).
 *
 * A studiobox client that holds a {@link TunnelGrant} (from
 * `HostSandbox.openTunnel`) dials the tunnel endpoint, sends the fixed
 * `SBXTUN1` preface carrying the single-use ticket, and waits for the
 * `SBXACK1` response. On `TunnelStatus.Ok` the SAME connection is now a
 * verbatim byte pipe to the guest agent's `SandboxAgent` capnp plane — the
 * caller wraps it in `TcpTransport` + `RpcWireClient` and speaks the agent
 * plane end to end. hostd never interprets a byte past the preface.
 *
 * Bounded like every other dial on the path: the connect and the ACK read are
 * each deadline-guarded (the ticket dial budget is 10s < the 15s ticket TTL),
 * and any failure closes the connection before throwing, so a failed dial
 * leaks nothing.
 *
 * @module
 */

import {
  encodeTunnelRequest,
  readTunnelResponse,
  TunnelPrefaceError,
  TunnelStatus,
} from "./tunnel_preface.ts";

/** Where a tunnel endpoint lives (a per-tunnel loopback UDS or 127.0.0.1 port). */
export type TunnelEndpoint =
  | { readonly transport: "unix"; readonly path: string }
  | {
    readonly transport: "tcp";
    readonly hostname: string;
    readonly port: number;
  };

/** Default budget for the whole dial (connect + preface + ACK). */
export const DEFAULT_TUNNEL_DIAL_TIMEOUT_MS = 10_000;

/** Default delay between CONNECT retries while the endpoint is unreachable. */
export const DEFAULT_TUNNEL_CONNECT_RETRY_INTERVAL_MS = 150;

export interface DialTunnelOptions {
  /** Bound (ms) for the ACK read (and, best effort, the connect). */
  readonly timeoutMs?: number;
  /** External cancellation. */
  readonly signal?: AbortSignal;
  /**
   * Best-effort budget (ms) to keep retrying the INITIAL connect while the
   * endpoint refuses / isn't reachable yet — e.g. a Lima/NAT port-forward the
   * host just started listening on hasn't propagated. Safe to retry: the ticket
   * is presented only AFTER a successful connect, so a refused connect never
   * burns it. Retries the connect ONLY; any post-connect failure is terminal.
   * Keep it well under the route TTL (10s) to leave room for the preface + ACK.
   * @default 0 (no retry)
   */
  readonly connectRetryMs?: number;
  /**
   * Delay between connect retries.
   * @default {@link DEFAULT_TUNNEL_CONNECT_RETRY_INTERVAL_MS}
   */
  readonly connectRetryIntervalMs?: number;
}

/** A failed tunnel dial, carrying the ACK status when the server sent one. */
export class TunnelDialError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "SBX_TUNNEL_DIAL";
  /** The `SBXACK1` status the server sent, when it sent one. */
  readonly status?: TunnelStatus;

  /** Construct with a message and the optional ACK status. */
  constructor(message: string, status?: TunnelStatus) {
    super(message);
    this.name = "TunnelDialError";
    if (status !== undefined) this.status = status;
  }
}

/**
 * Connect an endpoint, present `ticket` in an `SBXTUN1` preface, and return
 * the connected duplex once `SBXACK1` reports `Ok`. The returned conn is a raw
 * byte pipe to the guest agent — ready for a capnp `RpcWireClient`.
 *
 * Rejects with {@link TunnelDialError} if the endpoint refuses the connection,
 * the ticket is rejected (the server closes before ACK), the ACK reports a
 * non-`Ok` status, or the ACK never arrives within the budget. The connection
 * is always closed before a rejection.
 */
export async function dialTunnel(
  endpoint: TunnelEndpoint,
  ticket: Uint8Array,
  options: DialTunnelOptions = {},
): Promise<Deno.Conn> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TUNNEL_DIAL_TIMEOUT_MS;
  const preface = encodeTunnelRequest(ticket);

  const conn = await connectWithRetry(endpoint, options);

  try {
    await writeAll(conn, preface);
    const response = await readTunnelResponse(asPrefaceReader(conn), {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status !== TunnelStatus.Ok) {
      throw new TunnelDialError(
        `tunnel refused the ticket (status ${response.status})`,
        response.status,
      );
    }
    return conn;
  } catch (error) {
    try {
      conn.close();
    } catch {
      // Already closed by the read helper on timeout/cancellation.
    }
    if (error instanceof TunnelDialError) throw error;
    if (error instanceof TunnelPrefaceError) {
      // The server closed before (or mid-) ACK — the ticket was rejected, or
      // the response was malformed. Normalize to the dial error surface.
      throw new TunnelDialError(`tunnel handshake failed: ${error.message}`);
    }
    throw new TunnelDialError(`tunnel handshake failed: ${errorText(error)}`);
  }
}

/**
 * Connect the endpoint, retrying a refused / unreachable connect within
 * {@link DialTunnelOptions.connectRetryMs}. Only the connect is retried — no
 * ticket byte is written here, so retrying is side-effect-free. Throws
 * {@link TunnelDialError} once the budget lapses (or immediately when the budget
 * is 0, preserving the original no-retry behavior).
 */
async function connectWithRetry(
  endpoint: TunnelEndpoint,
  options: DialTunnelOptions,
): Promise<Deno.Conn> {
  const budgetMs = options.connectRetryMs ?? 0;
  const intervalMs = options.connectRetryIntervalMs ??
    DEFAULT_TUNNEL_CONNECT_RETRY_INTERVAL_MS;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (options.signal?.aborted) {
      throw new TunnelDialError("tunnel endpoint is unreachable: aborted");
    }
    try {
      return endpoint.transport === "unix"
        ? await Deno.connect({ transport: "unix", path: endpoint.path })
        : await Deno.connect({
          transport: "tcp",
          hostname: endpoint.hostname,
          port: endpoint.port,
        });
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new TunnelDialError(
          `tunnel endpoint is unreachable: ${errorText(error)}`,
        );
      }
      await sleep(Math.min(intervalMs, remaining), options.signal);
    }
  }
}

/** Resolve after `ms`, or early if `signal` aborts (never rejects). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Adapt a `Deno.Conn` to the fixed-preface reader (read exact, close). */
function asPrefaceReader(conn: Deno.Conn) {
  return {
    read: (destination: Uint8Array): Promise<number | null> =>
      conn.read(destination),
    close: (): void => {
      try {
        conn.close();
      } catch {
        // Already closed.
      }
    },
  };
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
