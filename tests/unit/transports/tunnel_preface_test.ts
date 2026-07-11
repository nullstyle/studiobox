import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeTunnelRequest,
  decodeTunnelResponse,
  encodeTunnelRequest,
  encodeTunnelResponse,
  TUNNEL_REQUEST_BYTES,
  TUNNEL_RESPONSE_BYTES,
  TunnelPrefaceError,
  TunnelStatus,
} from "../../../src/transports/tunnel_preface.ts";

Deno.test("tunnel request is an exact 44-byte round trip", () => {
  const ticket = Uint8Array.from({ length: 32 }, (_, index) => index);
  const encoded = encodeTunnelRequest(ticket);
  assertEquals(encoded.byteLength, TUNNEL_REQUEST_BYTES);
  assertEquals(decodeTunnelRequest(encoded), { version: 1, flags: 0, ticket });
});

Deno.test("tunnel request rejects extensions, flags, and malformed magic", () => {
  const encoded = encodeTunnelRequest(new Uint8Array(32));
  for (
    const candidate of [
      new Uint8Array([...encoded, 0]),
      encoded.slice(0, encoded.length - 1),
      Uint8Array.from(
        encoded,
        (byte, index) => index === 0 ? byte ^ 0xff : byte,
      ),
      Uint8Array.from(encoded, (byte, index) => index === 11 ? 1 : byte),
    ]
  ) {
    try {
      decodeTunnelRequest(candidate);
      throw new Error("expected malformed preface to fail");
    } catch (error) {
      if (!(error instanceof TunnelPrefaceError)) throw error;
    }
  }
});

Deno.test("tunnel response is an exact 12-byte round trip", () => {
  const encoded = encodeTunnelResponse(TunnelStatus.Ok);
  assertEquals(encoded.byteLength, TUNNEL_RESPONSE_BYTES);
  assertEquals(decodeTunnelResponse(encoded), { status: TunnelStatus.Ok });
});

Deno.test("tunnel response rejects unknown statuses and reserved bytes", () => {
  const unknown = encodeTunnelResponse(TunnelStatus.Ok);
  unknown[9] = 99;
  assertThrows(() => decodeTunnelResponse(unknown), TunnelPrefaceError);

  const reserved = encodeTunnelResponse(TunnelStatus.Ok);
  reserved[10] = 1;
  assertThrows(() => decodeTunnelResponse(reserved), TunnelPrefaceError);
});
