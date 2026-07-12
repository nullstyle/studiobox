/**
 * Unit coverage for the tunnel splice primitive (src/transports/splice.ts):
 * bidirectional verbatim copy, graceful EOF propagation in BOTH directions,
 * and a mid-stream close tearing both connections down without a hang or a
 * global unhandled rejection.
 *
 * Uses TCP loopback pairs (the unit net policy permits 127.0.0.1); TcpConn,
 * like the UDS and vsock conns on the real path, supports `closeWrite()`.
 */

import { assertEquals } from "@std/assert";
import { spliceDuplex } from "../../../src/transports/splice.ts";

/** A connected [client, server] TCP pair on 127.0.0.1. */
async function pair(): Promise<[Deno.Conn, Deno.Conn]> {
  const listener = Deno.listen({
    transport: "tcp",
    hostname: "127.0.0.1",
    port: 0,
  });
  const addr = listener.addr as Deno.NetAddr;
  const connectP = Deno.connect({
    transport: "tcp",
    hostname: "127.0.0.1",
    port: addr.port,
  });
  const server = await listener.accept();
  const client = await connectP;
  listener.close();
  return [client, server];
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function readN(conn: Deno.Conn, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = await conn.read(out.subarray(offset));
    if (count === null) throw new Error("stream ended early");
    offset += count;
  }
  return out;
}

Deno.test("splice: copies bytes both ways and propagates EOF when one side closes write", async () => {
  const [aClient, aServer] = await pair();
  const [bClient, bServer] = await pair();
  const splice = spliceDuplex(aServer, bServer);

  const enc = new TextEncoder();
  // a -> b
  await writeAll(aClient, enc.encode("forward"));
  assertEquals(new TextDecoder().decode(await readN(bClient, 7)), "forward");
  // b -> a
  await writeAll(bClient, enc.encode("reverse!"));
  assertEquals(new TextDecoder().decode(await readN(aClient, 8)), "reverse!");

  // The client half-closes its write side: EOF must reach bClient's read.
  await (aClient as Deno.TcpConn).closeWrite();
  assertEquals(await bClient.read(new Uint8Array(4)), null, "EOF crossed a->b");

  // The reverse direction still carries bytes until it too ends.
  await writeAll(bClient, enc.encode("late"));
  assertEquals(new TextDecoder().decode(await readN(aClient, 4)), "late");
  await (bClient as Deno.TcpConn).closeWrite();
  assertEquals(await aClient.read(new Uint8Array(4)), null, "EOF crossed b->a");

  // Both directions drained: the splice resolves and closes both conns.
  await splice;
  aClient.close();
  bClient.close();
});

Deno.test("splice: an abort mid-stream tears both connections down (no hang, no leak)", async () => {
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    const [aClient, aServer] = await pair();
    const [bClient, bServer] = await pair();
    const controller = new AbortController();
    const splice = spliceDuplex(aServer, bServer, {
      signal: controller.signal,
    });

    // Bytes are flowing in one direction; the reverse peer is idle (never sends
    // and never closes) — exactly the case where a splice would hang without an
    // external teardown. This is the path TunnelServer.close() drives on lease
    // revocation.
    await writeAll(aClient, new TextEncoder().encode("hello"));
    assertEquals(new TextDecoder().decode(await readN(bClient, 5)), "hello");

    controller.abort();

    // The splice resolves promptly and BOTH internal conns are closed, so both
    // external peers observe the stream end rather than hanging.
    await splice;
    assertEquals(
      await aClient.read(new Uint8Array(4)),
      null,
      "a end torn down",
    );
    assertEquals(
      await bClient.read(new Uint8Array(4)),
      null,
      "b end torn down",
    );
    aClient.close();
    bClient.close();

    // A tiny beat for any stray microtask; none should have escaped.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(
      rejections.length,
      0,
      "no fault escaped as an unhandled rejection",
    );
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
});

Deno.test("splice: a graceful full close on both peers completes the splice", async () => {
  const [aClient, aServer] = await pair();
  const [bClient, bServer] = await pair();
  const splice = spliceDuplex(aServer, bServer);

  await writeAll(aClient, new TextEncoder().encode("x"));
  assertEquals(new TextDecoder().decode(await readN(bClient, 1)), "x");

  // Both peers hang up (FIN both ways): each pump reaches EOF and the splice
  // resolves, closing the internal conns.
  await (aClient as Deno.TcpConn).closeWrite();
  await (bClient as Deno.TcpConn).closeWrite();
  await splice;
  aClient.close();
  bClient.close();
});
