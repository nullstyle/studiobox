/**
 * The shared tunnel ROUTER (DESIGN.md §4, §11; PLAN.md §M8 part 2b).
 *
 * Where {@link TunnelServer} binds ONE loopback endpoint per tunnel, the router
 * binds a SINGLE static listener (the statically-forwarded tunnel port —
 * DESIGN.md §11: 40001) and multiplexes every sandbox's tunnel onto it, routing
 * an incoming `SBXTUN1` dial to the right tunnel BY ITS TICKET. This is what
 * lets a pure-wire `host_control` client dial a KNOWN address it was configured
 * with out of band: the wire `TunnelGrant` carries no endpoint field (no
 * `host_control.capnp` change, no M1 codegen byte-drift), only the ticket, and
 * the router resolves the ticket to its route.
 *
 * The trust-boundary ordering is unchanged and still fail-closed (mirrors
 * {@link TunnelServer}):
 *
 *   - the fixed preface is read under a bounded timeout; a malformed / truncated
 *     / silent / garbage preface is dropped with NO ack and NO bridge;
 *   - the presented ticket is hashed to a verifier and looked up in the route
 *     registry WITHOUT burning it. A ticket that resolves to NO route (unknown,
 *     already-claimed, torn-down) is closed BEFORE any ack and WITHOUT opening a
 *     bridge — identical, from the outside, to a rejected ticket, so a probe
 *     learns nothing and cannot reach another sandbox's tunnel;
 *   - on a hit, the route's authorizer BURNS the single-use ticket (gated on the
 *     binding, so a wrong-binding replay cannot deny the legitimate holder)
 *     BEFORE studiobox-rootd's guest bridge is ever dialed. Only after the burn
 *     and dial does the router send `SBXACK1(Ok)` and splice bytes verbatim;
 *   - a valid ticket whose bridge dial then fails gets a typed error ack.
 *
 * A route is single-use: it is deregistered the instant its ticket is claimed,
 * and freed when its splice ends, when its per-route dial budget lapses with no
 * valid preface, or when the owning sandbox's lease is revoked (which closes the
 * route handle). The shared listener itself lives for the daemon's lifetime and
 * is torn down only by {@link TunnelRouter.close}.
 *
 * Availability: the accept loop survives a peer that connects-then-closes or
 * spews garbage — each connection is handled in its own bounded task, transient
 * accept faults are tolerated, and nothing escapes as a global unhandled
 * rejection (the DoS class that bit the agent accept loop three times).
 *
 * @module
 */

import type {
  PrivilegedBridgeRequest,
  TunnelAuthorizer,
} from "./tunnel_authorizer.ts";
import {
  TicketRejectedError,
  ticketVerifier,
  type TunnelTicketBinding,
} from "../security/tickets.ts";
import {
  readTunnelRequest,
  TunnelStatus,
} from "../transports/tunnel_preface.ts";
import { spliceDuplex } from "../transports/splice.ts";
import type { TunnelEndpoint } from "../transports/tunnel_client.ts";
import {
  asPrefaceReader,
  bridgeFailureStatus,
  DEFAULT_PREFACE_TIMEOUT_MS,
  DEFAULT_TUNNEL_DIAL_BUDGET_MS,
  describeEndpoint,
  safeClose,
  sendResponse,
  type TunnelListenSpec,
} from "./tunnel_server.ts";

/** A tunnel route registered with the shared router. */
export interface TunnelRouteRegistration {
  /** The lookup key: `ticketVerifier(issuedTicket)` (never the raw ticket). */
  readonly verifier: string;
  /** The exact binding the presented ticket must carry to burn. */
  readonly binding: TunnelTicketBinding;
  /** The privileged bridge request (logical ids + guest port only). */
  readonly bridgeRequest: PrivilegedBridgeRequest;
  /** Burns the ticket (binding-gated), then dials the guest bridge. */
  readonly authorizer: TunnelAuthorizer<Deno.Conn>;
  /**
   * Dial budget: if no valid preface claims this route within the window it is
   * freed. @default {@link DEFAULT_TUNNEL_DIAL_BUDGET_MS}
   */
  readonly ttlMs?: number;
}

/** A live route registration; the caller frees it via {@link TunnelRouteHandle.close}. */
export interface TunnelRouteHandle {
  /** Resolves when the route is freed (splice ended, ttl lapsed, or closed). */
  readonly finished: Promise<void>;
  /** Whether the route's ticket was claimed and its bridge spliced. */
  readonly claimed: boolean;
  /** Free the route: deregister, abort any in-flight splice, resolve finished. */
  close(): Promise<void>;
}

interface RouteEntry {
  readonly verifier: string;
  readonly binding: TunnelTicketBinding;
  readonly bridgeRequest: PrivilegedBridgeRequest;
  readonly authorizer: TunnelAuthorizer<Deno.Conn>;
  /** Aborts this route's in-flight authorize/splice on close/revocation. */
  readonly abort: AbortController;
  readonly finished: Promise<void>;
  resolveFinished: () => void;
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
  /** The claimed connection's handler, awaited on close(). */
  inflight: Promise<void> | undefined;
  claimed: boolean;
  settled: boolean;
}

export interface TunnelRouterOptions {
  /** Bound for reading the fixed preface. @default {@link DEFAULT_PREFACE_TIMEOUT_MS} */
  readonly prefaceTimeoutMs?: number;
}

/** The single static listener that multiplexes every tunnel by ticket. */
export class TunnelRouter {
  readonly #listener: Deno.Listener;
  readonly #endpoint: TunnelEndpoint;
  readonly #prefaceTimeoutMs: number;
  /** Aborts every route's splice + all preface reads on teardown. */
  readonly #abort = new AbortController();
  readonly #finished: Promise<void>;
  #resolveFinished!: () => void;
  #closed = false;
  /** verifier -> route. A ticket reaches only the route it hashes to. */
  readonly #routes = new Map<string, RouteEntry>();
  /** In-flight connection handlers, awaited on teardown. */
  readonly #handlers = new Set<Promise<void>>();

  private constructor(
    listener: Deno.Listener,
    endpoint: TunnelEndpoint,
    options: TunnelRouterOptions,
  ) {
    this.#listener = listener;
    this.#endpoint = endpoint;
    this.#prefaceTimeoutMs = options.prefaceTimeoutMs ??
      DEFAULT_PREFACE_TIMEOUT_MS;
    this.#finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
    void this.#acceptLoop();
  }

  /** Bind the shared listener and start serving. */
  static open(
    listen: TunnelListenSpec,
    options: TunnelRouterOptions = {},
  ): TunnelRouter {
    const listener = listen.transport === "unix"
      ? Deno.listen({ transport: "unix", path: listen.path })
      : Deno.listen({
        transport: "tcp",
        hostname: listen.hostname ?? "127.0.0.1",
        port: listen.port ?? 0,
      });
    const endpoint = describeEndpoint(listener, listen);
    return new TunnelRouter(listener, endpoint, options);
  }

  /** The shared, statically-known address every tunnel is dialed at. */
  get endpoint(): TunnelEndpoint {
    return this.#endpoint;
  }

  /** Resolves when the listener is closed and every route is freed. */
  get finished(): Promise<void> {
    return this.#finished;
  }

  /** Live registered-route count (test/observability seam). */
  get routeCount(): number {
    return this.#routes.size;
  }

  /**
   * Register a tunnel route. The returned handle frees it (deregister + abort
   * any in-flight splice). A route whose ticket is never claimed self-frees on
   * its dial budget; a claimed route frees when its splice ends.
   */
  register(registration: TunnelRouteRegistration): TunnelRouteHandle {
    if (this.#closed) {
      throw new Error("tunnel router is closed");
    }
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const entry: RouteEntry = {
      verifier: registration.verifier,
      binding: registration.binding,
      bridgeRequest: registration.bridgeRequest,
      authorizer: registration.authorizer,
      abort: new AbortController(),
      finished,
      resolveFinished,
      ttlTimer: undefined,
      inflight: undefined,
      claimed: false,
      settled: false,
    };
    const ttlMs = registration.ttlMs ?? DEFAULT_TUNNEL_DIAL_BUDGET_MS;
    entry.ttlTimer = setTimeout(() => {
      // No valid preface claimed this route in time: free it. A claimed route
      // has already cleared this timer, so a live splice is never cut here.
      void this.#closeRoute(entry);
    }, ttlMs);
    this.#routes.set(entry.verifier, entry);
    return {
      finished: entry.finished,
      get claimed(): boolean {
        return entry.claimed;
      },
      close: (): Promise<void> => this.#closeRoute(entry),
    };
  }

  /**
   * Tear the router down: stop accepting, abort every route's splice, free the
   * listener + socket file, and settle every outstanding route. Idempotent.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      await this.#finished;
      return;
    }
    this.#closed = true;
    this.#abort.abort();
    for (const entry of this.#routes.values()) {
      if (entry.ttlTimer !== undefined) {
        clearTimeout(entry.ttlTimer);
        entry.ttlTimer = undefined;
      }
      entry.abort.abort();
      if (!entry.settled) {
        entry.settled = true;
        entry.resolveFinished();
      }
    }
    this.#routes.clear();
    try {
      this.#listener.close();
    } catch {
      // Already closed.
    }
    // Deno leaves the UDS socket file behind when the listener closes; unlink it
    // so the router leaves nothing on the filesystem.
    if (this.#endpoint.transport === "unix") {
      await Deno.remove(this.#endpoint.path).catch(() => {});
    }
    // Drain in-flight handlers so a caller awaiting close() knows every conn
    // (and splice) is settled.
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
        // transient error on some platforms; keep serving.
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
      // Malformed / truncated / silent / garbage preface: drop with no ack.
      safeClose(conn);
      return;
    }

    // Resolve the ticket to its route WITHOUT burning it. A ticket that hashes
    // to no live route is closed before any ack — a probe (or a ticket for a
    // DIFFERENT sandbox's tunnel that somehow reached here) opens no bridge.
    const verifier = await ticketVerifier(request.ticket);
    const entry = this.#routes.get(verifier);
    if (entry === undefined || entry.claimed || entry.settled) {
      safeClose(conn);
      return;
    }

    let bridge: Deno.Conn;
    try {
      // Consume-before-bridge: the authorizer BURNS the ticket (binding-gated),
      // then dials the guest. A rejected ticket throws here before any bridge.
      bridge = await entry.authorizer.authorizeAndOpen(
        request.ticket,
        entry.binding,
        entry.bridgeRequest,
        entry.abort.signal,
      );
    } catch (error) {
      if (error instanceof TicketRejectedError) {
        // Bad / expired / replayed / wrong-binding ticket: close BEFORE any ack
        // and WITHOUT opening a bridge. The route keeps its registration (its
        // dial budget frees it) so this connection cannot deny a legitimate
        // holder — identical to TunnelServer's rejection path.
        safeClose(conn);
        return;
      }
      // The ticket was valid and is now spent, but the bridge dial failed: tell
      // the client with a typed ack, then close. No retry — single use.
      await sendResponse(conn, bridgeFailureStatus(error)).catch(() => {});
      safeClose(conn);
      this.#finishRoute(entry);
      return;
    }

    // A single ticket claims a single bridge. The store's single-use guarantee
    // means at most one connection reaches here; this guards a double claim.
    if (entry.claimed || entry.settled) {
      safeClose(bridge);
      safeClose(conn);
      return;
    }
    entry.claimed = true;
    if (entry.ttlTimer !== undefined) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = undefined;
    }
    // Spent: deregister so the verifier can never resolve a second dial.
    this.#routes.delete(verifier);

    try {
      await sendResponse(conn, TunnelStatus.Ok);
    } catch {
      // The client vanished between preface and ack: nothing to splice.
      safeClose(bridge);
      safeClose(conn);
      this.#finishRoute(entry);
      return;
    }

    // Verbatim splice until either side closes; then free the route.
    const splice = spliceDuplex(conn, bridge, { signal: entry.abort.signal });
    entry.inflight = splice.then(() => {}, () => {});
    await entry.inflight;
    this.#finishRoute(entry);
  }

  /** Settle a route on natural completion (splice EOF / ack failure). */
  #finishRoute(entry: RouteEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.ttlTimer !== undefined) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = undefined;
    }
    this.#routes.delete(entry.verifier);
    entry.resolveFinished();
  }

  /** Free a route on close / revocation / dial-budget lapse. Idempotent. */
  async #closeRoute(entry: RouteEntry): Promise<void> {
    if (entry.settled) {
      await entry.finished;
      return;
    }
    entry.settled = true;
    if (entry.ttlTimer !== undefined) {
      clearTimeout(entry.ttlTimer);
      entry.ttlTimer = undefined;
    }
    this.#routes.delete(entry.verifier);
    entry.abort.abort();
    // Await the claimed splice so a caller of close() knows the conns are torn
    // down (abort closes both ends of spliceDuplex synchronously).
    if (entry.inflight !== undefined) {
      await entry.inflight.catch(() => {});
    }
    entry.resolveFinished();
    await entry.finished;
  }
}
