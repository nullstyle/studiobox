/**
 * Unit coverage for {@link dialTunnel}'s connect-retry — the client rides out a
 * momentarily-unreachable endpoint (a just-established Lima/NAT forward) without
 * burning its single-use ticket, since the ticket is presented only AFTER the
 * connect succeeds.
 *
 * Bound to the single UDS path the `test:unit` task permits
 * (`--allow-net=…unix:/tmp/studiobox-unit-uds.sock`); the file runs its tests
 * sequentially and unlinks the socket around each.
 */
import { assertRejects } from "@std/assert";
import {
  dialTunnel,
  TunnelDialError,
} from "../../../src/transports/tunnel_client.ts";
import {
  encodeTunnelResponse,
  readTunnelRequest,
  TunnelStatus,
} from "../../../src/transports/tunnel_preface.ts";

const TICKET = new Uint8Array(32).fill(7);
const UDS = "/tmp/studiobox-unit-uds.sock";

/** A one-shot UDS server that reads the SBXTUN1 preface and acks `status`. */
function serveOnce(path: string, status: TunnelStatus): Deno.Listener {
  const listener = Deno.listen({ transport: "unix", path });
  (async () => {
    const conn = await listener.accept();
    await readTunnelRequest({
      read: (b) => conn.read(b),
      close: () => conn.close(),
    }, { timeoutMs: 2_000 });
    const ack = encodeTunnelResponse(status);
    let off = 0;
    while (off < ack.byteLength) off += await conn.write(ack.subarray(off));
    // Leave the conn open; the caller closes its returned conn.
  })().catch(() => {});
  return listener;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("dialTunnel: retries the connect until the endpoint appears", async () => {
  await Deno.remove(UDS).catch(() => {});
  // Start dialing while nothing is bound — the first connects are refused.
  const dialP = dialTunnel(
    { transport: "unix", path: UDS },
    TICKET,
    { connectRetryMs: 4_000, connectRetryIntervalMs: 50 },
  );

  await sleep(300); // let several connect attempts fail first
  const listener = serveOnce(UDS, TunnelStatus.Ok);
  try {
    const conn = await dialP; // must resolve once the server appears
    conn.close();
  } finally {
    listener.close();
    await Deno.remove(UDS).catch(() => {});
  }
});

Deno.test("dialTunnel: no retry budget fails fast when unreachable", async () => {
  await Deno.remove(UDS).catch(() => {}); // ensure nothing is listening
  await assertRejects(
    () => dialTunnel({ transport: "unix", path: UDS }, TICKET),
    TunnelDialError,
    "unreachable",
  );
});
