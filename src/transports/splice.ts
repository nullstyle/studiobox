/**
 * Bounded, bidirectional byte splice between two `Deno.Conn` duplexes.
 *
 * The ticketed tunnel (DESIGN.md §4) is exec-as-a-service: once the
 * `SBXTUN1` preface is authorized, studiobox-hostd stops interpreting the
 * stream and pumps bytes verbatim between the external tunnel connection and
 * the guest-agent bridge connection. One tunnel = one vsock stream = one
 * capnp `SandboxAgent` session; nothing here parses agent-plane frames.
 *
 * Contract (mirrors the M1 close-ownership discipline the whole codebase
 * leans on — a mid-stream close or a peer that connects-then-vanishes must
 * never wedge or leak):
 *
 *   - **Bounded.** Each direction owns ONE fixed-size buffer and writes it
 *     out fully before the next read, so backpressure from a slow peer stalls
 *     the reader instead of growing an unbounded queue.
 *   - **EOF propagation.** When one side reaches EOF its read pump half-closes
 *     the OTHER side's write half (a graceful `closeWrite()` where the conn
 *     supports it, a full close otherwise), so the peer observes the stream
 *     end. When BOTH directions have drained, both conns are fully closed.
 *   - **Fault teardown.** A read/write error (peer RST, out-of-band close) or
 *     an abort tears BOTH conns down immediately; the sibling pump's pending
 *     `read`/`write` rejects with `BadResource` and is swallowed, so no fault
 *     escapes as a global unhandled rejection.
 *   - **Idempotent.** `spliceDuplex` resolves exactly once, after both conns
 *     are closed, whether it ended by EOF, fault, or abort.
 *
 * @module
 */

/** Default per-direction copy buffer (matches the streams-plane chunk size). */
export const DEFAULT_SPLICE_BUFFER_BYTES = 64 * 1024;

export interface SpliceOptions {
  /** Per-direction copy buffer size. @default {@link DEFAULT_SPLICE_BUFFER_BYTES} */
  readonly bufferBytes?: number;
  /** Aborting tears both connections down promptly. */
  readonly signal?: AbortSignal;
}

/**
 * Pump bytes both ways between `a` and `b` until either closes, then close
 * both. Resolves once both connections are closed. Never rejects: a fault on
 * either side is normalized into a clean teardown (the caller learns the
 * stream ended, not how).
 */
export async function spliceDuplex(
  a: Deno.Conn,
  b: Deno.Conn,
  options: SpliceOptions = {},
): Promise<void> {
  const bufferBytes = options.bufferBytes ?? DEFAULT_SPLICE_BUFFER_BYTES;
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes <= 0) {
    throw new RangeError("splice buffer size must be a positive integer");
  }

  let torn = false;
  const closeBoth = (): void => {
    if (torn) return;
    torn = true;
    try {
      a.close();
    } catch {
      // Already closed by the peer or a sibling pump.
    }
    try {
      b.close();
    } catch {
      // Already closed by the peer or a sibling pump.
    }
  };

  const signal = options.signal;
  const onAbort = (): void => closeBoth();
  if (signal !== undefined) {
    if (signal.aborted) closeBoth();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const pump = async (from: Deno.Conn, to: Deno.Conn): Promise<void> => {
    const buffer = new Uint8Array(bufferBytes);
    try {
      while (true) {
        const count = await from.read(buffer);
        if (count === null) {
          // `from` reached EOF: propagate it to `to` so the peer sees the
          // stream end, then let the sibling pump drain the reverse path.
          halfCloseWrite(to);
          return;
        }
        let offset = 0;
        while (offset < count) {
          offset += await to.write(buffer.subarray(offset, count));
        }
      }
    } catch {
      // A peer reset, a mid-stream close, or an abort surfaced here: tear both
      // sides down. The sibling pump's pending read/write rejects the same way
      // and is swallowed by its own catch.
      closeBoth();
    }
  };

  try {
    await Promise.all([pump(a, b), pump(b, a)]);
  } finally {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    closeBoth();
  }
}

/**
 * Half-close the write half of `conn` (graceful EOF) when the conn supports
 * it — `Deno.UnixConn`/`Deno.TcpConn` and the host-side vsock conn all do —
 * falling back to a full close for a duplex that cannot half-close. Best
 * effort: a conn the peer already closed rejects, which is ignored.
 */
function halfCloseWrite(conn: Deno.Conn): void {
  const closeWrite = (conn as { closeWrite?: () => Promise<void> }).closeWrite;
  if (typeof closeWrite === "function") {
    closeWrite.call(conn).catch(() => {});
    return;
  }
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}
