/**
 * The per-tunnel server (DESIGN.md §4; PLAN.md §M7).
 *
 * `HostSandbox.openTunnel` opens ONE of these per grant: a loopback endpoint
 * (a UDS, or a 127.0.0.1 port) that accepts a client dial, reads the fixed
 * `SBXTUN1` preface, and — through {@link TunnelAuthorizer} — BURNS the
 * single-use ticket BEFORE studiobox-rootd is ever asked to open the guest
 * bridge. Only after the ticket is consumed and the bridge is dialed does the
 * server send `SBXACK1(Ok)` and splice bytes verbatim between the tunnel
 * connection and the bridge (DESIGN.md §4: "hostd never interprets agent-plane
 * traffic").
 *
 * The ordering is the load-bearing trust boundary and it is fail-closed:
 *
 *   - a malformed / truncated / silent preface is dropped with NO ack and NO
 *     bridge (the accept loop keeps serving);
 *   - a rejected ticket (unknown, expired, replayed, wrong binding) closes the
 *     connection BEFORE any ack and WITHOUT opening a bridge — the burn is
 *     indistinguishable from the outside (`SingleUseTicketStore` burns before
 *     it decides), so a probe learns nothing;
 *   - a valid ticket whose bridge dial then fails gets a typed error ack, then
 *     the connection is closed (the ticket is already spent — single use).
 *
 * Availability (this DoS class bit the agent accept loop three times): the
 * accept loop survives a peer that connects-then-immediately-closes or spews
 * garbage — each connection is handled in its own bounded task, transient
 * accept faults are tolerated, and nothing escapes as a global unhandled
 * rejection. The endpoint is freed when the authorized splice ends (EOF either
 * way), when the dial budget lapses with no valid preface, or on explicit
 * {@link TunnelServer.close} (lease revocation / hostd restart).
 *
 * @module
 */

import type {
  PrivilegedBridgeRequest,
  TunnelAuthorizer,
} from "./tunnel_authorizer.ts";
import {
  TicketRejectedError,
  type TunnelTicketBinding,
} from "../security/tickets.ts";
import {
  encodeTunnelResponse,
  readTunnelRequest,
  TunnelStatus,
} from "../transports/tunnel_preface.ts";
import { spliceDuplex } from "../transports/splice.ts";
import type { TunnelEndpoint } from "../transports/tunnel_client.ts";

/** Default dial budget: a valid preface must arrive within this window. */
export const DEFAULT_TUNNEL_DIAL_BUDGET_MS = 10_000;
/** Default bound for reading the fixed 44-byte preface off a fresh dial. */
export const DEFAULT_PREFACE_TIMEOUT_MS = 5_000;

/** Where to bind the per-tunnel endpoint. */
export type TunnelListenSpec =
  | { readonly transport: "unix"; readonly path: string }
  | {
    readonly transport: "tcp";
    readonly hostname?: string;
    readonly port?: number;
  };

export interface TunnelServerOptions {
  /** Binds tickets to rootd bridges (consume-before-bridge ordering). */
  readonly authorizer: TunnelAuthorizer<Deno.Conn>;
  /** The exact binding the presented ticket must carry. */
  readonly binding: TunnelTicketBinding;
  /** The privileged bridge request (logical ids + guest port only). */
  readonly bridgeRequest: PrivilegedBridgeRequest;
  /** Where the endpoint binds. */
  readonly listen: TunnelListenSpec;
  /**
   * Dial budget: if no ticket is successfully burned within this window the
   * endpoint is freed. @default {@link DEFAULT_TUNNEL_DIAL_BUDGET_MS}
   */
  readonly ttlMs?: number;
  /** Bound for reading the fixed preface. @default {@link DEFAULT_PREFACE_TIMEOUT_MS} */
  readonly prefaceTimeoutMs?: number;
}

/** One per-tunnel endpoint; a `TunnelServer.open()` result. */
export class TunnelServer {
  readonly #listener: Deno.Listener;
  readonly #endpoint: TunnelEndpoint;
  readonly #authorizer: TunnelAuthorizer<Deno.Conn>;
  readonly #binding: TunnelTicketBinding;
  readonly #bridgeRequest: PrivilegedBridgeRequest;
  readonly #prefaceTimeoutMs: number;
  /** Aborts the active splice + preface reads on teardown. */
  readonly #abort = new AbortController();
  readonly #finished: Promise<void>;
  #resolveFinished!: () => void;
  #ttlTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once a ticket is burned and its bridge claimed — one tunnel, one bridge. */
  #claimed = false;
  #closed = false;
  /** In-flight connection handlers, awaited on teardown. */
  readonly #handlers = new Set<Promise<void>>();

  private constructor(
    listener: Deno.Listener,
    endpoint: TunnelEndpoint,
    options: TunnelServerOptions,
  ) {
    this.#listener = listener;
    this.#endpoint = endpoint;
    this.#authorizer = options.authorizer;
    this.#binding = options.binding;
    this.#bridgeRequest = options.bridgeRequest;
    this.#prefaceTimeoutMs = options.prefaceTimeoutMs ??
      DEFAULT_PREFACE_TIMEOUT_MS;
    this.#finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
    const ttlMs = options.ttlMs ?? DEFAULT_TUNNEL_DIAL_BUDGET_MS;
    this.#ttlTimer = setTimeout(() => {
      // No valid preface arrived in time: drop the endpoint. An already-claimed
      // tunnel has cancelled this timer, so a live splice is never cut here.
      void this.close();
    }, ttlMs);
    void this.#acceptLoop();
  }

  /** Bind the endpoint and start serving. */
  static open(options: TunnelServerOptions): TunnelServer {
    const listener = options.listen.transport === "unix"
      ? Deno.listen({ transport: "unix", path: options.listen.path })
      : Deno.listen({
        transport: "tcp",
        hostname: options.listen.hostname ?? "127.0.0.1",
        port: options.listen.port ?? 0,
      });
    const endpoint = describeEndpoint(listener, options.listen);
    return new TunnelServer(listener, endpoint, options);
  }

  /** The dialable address a client presents its preface to. */
  get endpoint(): TunnelEndpoint {
    return this.#endpoint;
  }

  /** Resolves when the endpoint is freed (splice ended, ttl lapsed, or closed). */
  get finished(): Promise<void> {
    return this.#finished;
  }

  /** Whether a ticket was burned and its bridge spliced through this endpoint. */
  get claimed(): boolean {
    return this.#claimed;
  }

  /**
   * Tear the endpoint down: stop accepting, abort the active splice (closing
   * both the tunnel conn and the bridge), and free the listener + socket file.
   * Idempotent.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      await this.#finished;
      return;
    }
    this.#closed = true;
    if (this.#ttlTimer !== undefined) {
      clearTimeout(this.#ttlTimer);
      this.#ttlTimer = undefined;
    }
    this.#abort.abort();
    try {
      this.#listener.close();
    } catch {
      // Already closed.
    }
    // Deno does not unlink a UDS socket file when the listener closes; do it so
    // the endpoint leaves nothing behind.
    if (this.#endpoint.transport === "unix") {
      await Deno.remove(this.#endpoint.path).catch(() => {});
    }
    // Drain in-flight handlers so a caller awaiting close() knows every conn
    // (and the splice) is settled — no leaked conn survives.
    await Promise.allSettled([...this.#handlers]);
    this.#resolveFinished();
    await this.#finished;
  }

  async #acceptLoop(): Promise<void> {
    while (!this.#closed) {
      let conn: Deno.Conn;
      try {
        conn = await this.#listener.accept();
      } catch (error) {
        if (this.#closed || error instanceof Deno.errors.BadResource) break;
        // A peer that connects-then-immediately-closes races accept() into a
        // transient error on some platforms; keep serving rather than letting
        // the loop (and the endpoint) die.
        if (error instanceof Deno.errors.Interrupted) continue;
        continue;
      }
      const handler = this.#handle(conn).catch(() => {});
      this.#handlers.add(handler);
      void handler.finally(() => this.#handlers.delete(handler));
    }
  }

  async #handle(conn: Deno.Conn): Promise<void> {
    let request;
    try {
      request = await readTunnelRequest(asPrefaceReader(conn), {
        timeoutMs: this.#prefaceTimeoutMs,
        signal: this.#abort.signal,
      });
    } catch {
      // Malformed / truncated / silent / garbage preface: drop it with no ack
      // and no bridge. readTunnelRequest already closed the reader on timeout.
      safeClose(conn);
      return;
    }

    let bridge: Deno.Conn;
    try {
      // Consume-before-bridge: the authorizer BURNS the ticket, then opens the
      // rootd bridge. A rejected ticket throws here before any bridge exists.
      bridge = await this.#authorizer.authorizeAndOpen(
        request.ticket,
        this.#binding,
        this.#bridgeRequest,
        this.#abort.signal,
      );
    } catch (error) {
      if (error instanceof TicketRejectedError) {
        // Bad / expired / replayed / wrong-binding ticket: close BEFORE any
        // ack and WITHOUT opening a bridge. The endpoint keeps serving (the
        // ticket was not necessarily this connection's to spend).
        safeClose(conn);
        return;
      }
      // The ticket was valid and is now spent, but the bridge dial failed:
      // tell the client with a typed ack, then close. No retry — single use.
      await sendResponse(conn, bridgeFailureStatus(error)).catch(() => {});
      safeClose(conn);
      return;
    }

    // A single ticket authorizes a single bridge; claim the tunnel. The ticket
    // store's single-use guarantee means at most one connection reaches here,
    // so this is belt-and-suspenders against a double claim.
    if (this.#claimed || this.#closed) {
      safeClose(bridge);
      safeClose(conn);
      return;
    }
    this.#claimed = true;
    if (this.#ttlTimer !== undefined) {
      clearTimeout(this.#ttlTimer);
      this.#ttlTimer = undefined;
    }

    try {
      await sendResponse(conn, TunnelStatus.Ok);
    } catch {
      // The client vanished between preface and ack: nothing to splice.
      safeClose(bridge);
      safeClose(conn);
      void this.close();
      return;
    }

    // Verbatim splice until either side closes; then free the endpoint.
    await spliceDuplex(conn, bridge, { signal: this.#abort.signal });
    void this.close();
  }
}

/** Human/dialable endpoint description from a bound listener. */
function describeEndpoint(
  listener: Deno.Listener,
  spec: TunnelListenSpec,
): TunnelEndpoint {
  if (spec.transport === "unix") {
    return { transport: "unix", path: spec.path };
  }
  const addr = listener.addr as Deno.NetAddr;
  return { transport: "tcp", hostname: addr.hostname, port: addr.port };
}

function bridgeFailureStatus(error: unknown): TunnelStatus {
  const code = (error as { code?: unknown }).code;
  if (code === "SBX_SUP_UNAVAILABLE") return TunnelStatus.SupervisorUnavailable;
  return TunnelStatus.DialFailed;
}

async function sendResponse(
  conn: Deno.Conn,
  status: TunnelStatus,
): Promise<void> {
  const bytes = encodeTunnelResponse(status);
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

function asPrefaceReader(conn: Deno.Conn) {
  return {
    read: (destination: Uint8Array): Promise<number | null> =>
      conn.read(destination),
    close: (): void => safeClose(conn),
  };
}

function safeClose(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}
