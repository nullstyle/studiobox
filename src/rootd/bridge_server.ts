/**
 * The per-bridge splice server (DESIGN.md §4; PLAN.md §M7/M8, rootd half).
 *
 * `Supervisor.openBridge` mints a one-shot grant naming a per-bridge loopback
 * UDS (under the root-owned `/run/studiobox/b/` in production) plus a 32-byte
 * `bridgeCredential`. rootd opens ONE of these servers per grant: it binds that
 * UDS, accepts hostd's dial, reads the fixed `SBXBRG1` preface, verifies the
 * credential (constant time) BEFORE it dials the guest agent's vsock, then
 * sends `SBXBRA1(Ok)` and splices bytes verbatim between the bridge UDS and the
 * guest vsock. hostd's outer `TunnelServer` splices the external tunnel conn to
 * THIS UDS, so the assembled path is a two-hop verbatim pipe:
 *
 *   client <-> hostd TunnelServer <-> [bridge UDS] <-> rootd BridgeServer <-> guest vsock
 *
 * This is the inner mirror of {@link TunnelServer}; the trust-boundary ordering
 * and availability discipline are identical and load-bearing:
 *
 *   - a malformed / truncated / silent preface is dropped with NO ack and NO
 *     guest dial (the accept loop keeps serving);
 *   - a wrong credential closes the connection BEFORE any ack and WITHOUT
 *     dialing the guest (the credential is the burn-before-dial gate);
 *   - a verified credential whose guest dial then fails gets a typed error ack,
 *     then the connection is closed (the grant is one-shot — no retry);
 *   - the accept loop survives connect-then-close / garbage-preface peers, each
 *     connection is handled in its own bounded task, and nothing escapes as a
 *     global unhandled rejection.
 *
 * The endpoint is freed when the authorized splice ends (EOF either way), when
 * the dial budget lapses with no valid preface, or on explicit {@link close}
 * (grant expiry / execution kill / rootd restart).
 *
 * @module
 */

import {
  BRIDGE_CREDENTIAL_BYTES,
  BridgeStatus,
  encodeBridgeResponse,
  readBridgeRequest,
} from "../transports/bridge_preface.ts";
import { spliceDuplex } from "../transports/splice.ts";

/** Default dial budget: a valid preface must arrive within this window. */
export const DEFAULT_BRIDGE_DIAL_BUDGET_MS = 10_000;
/** Default bound for reading the fixed 44-byte preface off a fresh dial. */
export const DEFAULT_BRIDGE_PREFACE_TIMEOUT_MS = 5_000;

/** Dials the guest agent vsock for this bridge (bounded; typed error on death). */
export type BridgeGuestDial = (signal?: AbortSignal) => Promise<Deno.Conn>;

export interface BridgeServerOptions {
  /** Absolute UDS path to bind (grant.socketPath). */
  readonly socketPath: string;
  /** The 32-byte credential the presenting hostd dial must carry. */
  readonly credential: Uint8Array;
  /** Bounded dial to the guest agent vsock (races VMM death -> typed error). */
  readonly dialGuest: BridgeGuestDial;
  /**
   * Dial budget: if no credential is successfully verified within this window
   * the endpoint is freed. @default {@link DEFAULT_BRIDGE_DIAL_BUDGET_MS}
   */
  readonly ttlMs?: number;
  /** Bound for reading the fixed preface. @default {@link DEFAULT_BRIDGE_PREFACE_TIMEOUT_MS} */
  readonly prefaceTimeoutMs?: number;
}

/** One per-bridge endpoint; a `BridgeServer.open()` result. */
export class BridgeServer {
  readonly #listener: Deno.Listener;
  readonly #socketPath: string;
  readonly #credential: Uint8Array;
  readonly #dialGuest: BridgeGuestDial;
  readonly #prefaceTimeoutMs: number;
  /** Aborts the active splice + preface reads on teardown. */
  readonly #abort = new AbortController();
  readonly #finished: Promise<void>;
  #resolveFinished!: () => void;
  #ttlTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once a credential is verified and its guest dialed — one bridge, one dial. */
  #claimed = false;
  #closed = false;
  /** In-flight connection handlers, awaited on teardown. */
  readonly #handlers = new Set<Promise<void>>();

  private constructor(listener: Deno.Listener, options: BridgeServerOptions) {
    this.#listener = listener;
    this.#socketPath = options.socketPath;
    this.#credential = options.credential.slice();
    this.#dialGuest = options.dialGuest;
    this.#prefaceTimeoutMs = options.prefaceTimeoutMs ??
      DEFAULT_BRIDGE_PREFACE_TIMEOUT_MS;
    this.#finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
    const ttlMs = options.ttlMs ?? DEFAULT_BRIDGE_DIAL_BUDGET_MS;
    this.#ttlTimer = setTimeout(() => {
      // No valid preface arrived in time: drop the endpoint. An already-claimed
      // bridge has cancelled this timer, so a live splice is never cut here.
      void this.close();
    }, ttlMs);
    void this.#acceptLoop();
  }

  /** Bind the bridge UDS and start serving. */
  static open(options: BridgeServerOptions): BridgeServer {
    if (options.credential.byteLength !== BRIDGE_CREDENTIAL_BYTES) {
      throw new RangeError("bridge credential must be exactly 32 bytes");
    }
    const listener = Deno.listen({
      transport: "unix",
      path: options.socketPath,
    });
    // hostd (the unprivileged service user) dials this per-tunnel bridge UDS to
    // present its credential; a Unix connect needs WRITE on the node, so widen
    // the default to 0660 (owner + group rw). The socket's group is rootd's
    // process group — `studiobox` on a provisioned host (its unit runs
    // `Group=studiobox`) — so hostd, in that group, may connect. Confinement is
    // still enforced by the 32-byte bridge credential, not the socket mode.
    Deno.chmodSync(options.socketPath, 0o660);
    return new BridgeServer(listener, options);
  }

  /** The UDS path hostd dials to present its credential. */
  get socketPath(): string {
    return this.#socketPath;
  }

  /** Resolves when the endpoint is freed (splice ended, ttl lapsed, or closed). */
  get finished(): Promise<void> {
    return this.#finished;
  }

  /** Whether a credential was verified and its guest bridge spliced through. */
  get claimed(): boolean {
    return this.#claimed;
  }

  /**
   * Tear the endpoint down: stop accepting, abort the active splice (closing
   * both the bridge conn and the guest vsock), and free the listener + socket
   * file. Idempotent.
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
    await Deno.remove(this.#socketPath).catch(() => {});
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
      request = await readBridgeRequest(asPrefaceReader(conn), {
        timeoutMs: this.#prefaceTimeoutMs,
        signal: this.#abort.signal,
      });
    } catch {
      // Malformed / truncated / silent / garbage preface: drop it with no ack
      // and no guest dial. readBridgeRequest already closed the reader on
      // timeout.
      safeClose(conn);
      return;
    }

    // Burn-before-dial: verify the credential BEFORE the guest is reached. A
    // wrong credential closes BEFORE any ack and WITHOUT a dial — the endpoint
    // keeps serving (the credential was not necessarily this peer's to hold).
    if (!constantTimeEqual(request.credential, this.#credential)) {
      safeClose(conn);
      return;
    }

    // A single credential authorizes a single guest dial; claim the bridge.
    if (this.#claimed || this.#closed) {
      safeClose(conn);
      return;
    }
    this.#claimed = true;
    if (this.#ttlTimer !== undefined) {
      clearTimeout(this.#ttlTimer);
      this.#ttlTimer = undefined;
    }

    let guest: Deno.Conn;
    try {
      guest = await this.#dialGuest(this.#abort.signal);
    } catch {
      // The credential was valid but the guest dial failed (VMM death, no
      // listener). Tell hostd with a typed ack, then close. The grant is spent.
      await sendResponse(conn, BridgeStatus.DialFailed).catch(() => {});
      safeClose(conn);
      void this.close();
      return;
    }

    try {
      await sendResponse(conn, BridgeStatus.Ok);
    } catch {
      // hostd vanished between preface and ack: nothing to splice.
      safeClose(guest);
      safeClose(conn);
      void this.close();
      return;
    }

    // Verbatim splice until either side closes; then free the endpoint.
    await spliceDuplex(conn, guest, { signal: this.#abort.signal });
    void this.close();
  }
}

async function sendResponse(
  conn: Deno.Conn,
  status: BridgeStatus,
): Promise<void> {
  const bytes = encodeBridgeResponse(status);
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

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
