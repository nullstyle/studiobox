import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BRIDGE_REQUEST_BYTES,
  BRIDGE_RESPONSE_BYTES,
  BridgePrefaceError,
  BridgeStatus,
  decodeBridgeRequest,
  decodeBridgeResponse,
  encodeBridgeRequest,
  encodeBridgeResponse,
} from "../../../src/transports/bridge_preface.ts";

Deno.test("bridge request round-trips a 32-byte credential", () => {
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const encoded = encodeBridgeRequest(credential);
  assertEquals(encoded.byteLength, BRIDGE_REQUEST_BYTES);
  const decoded = decodeBridgeRequest(encoded);
  assertEquals(decoded.version, 1);
  assertEquals(decoded.flags, 0);
  assertEquals(decoded.credential, credential);
});

Deno.test("bridge request rejects a non-32-byte credential at encode", () => {
  assertThrows(
    () => encodeBridgeRequest(new Uint8Array(16)),
    RangeError,
  );
});

Deno.test("bridge request decode rejects wrong length, magic, version, flags", () => {
  const good = encodeBridgeRequest(new Uint8Array(32));
  assertThrows(
    () => decodeBridgeRequest(good.subarray(0, 40)),
    BridgePrefaceError,
    "44 bytes",
  );
  const badMagic = good.slice();
  badMagic[0] ^= 0xff;
  assertThrows(
    () => decodeBridgeRequest(badMagic),
    BridgePrefaceError,
    "magic",
  );
  const badVersion = good.slice();
  new DataView(badVersion.buffer).setUint16(8, 2);
  assertThrows(
    () => decodeBridgeRequest(badVersion),
    BridgePrefaceError,
    "version",
  );
  const badFlags = good.slice();
  new DataView(badFlags.buffer).setUint16(10, 1);
  assertThrows(
    () => decodeBridgeRequest(badFlags),
    BridgePrefaceError,
    "flags",
  );
});

Deno.test("bridge response round-trips every known status", () => {
  for (
    const status of [
      BridgeStatus.Ok,
      BridgeStatus.AuthenticationFailed,
      BridgeStatus.DialFailed,
      BridgeStatus.ProtocolError,
      BridgeStatus.InternalError,
    ]
  ) {
    const encoded = encodeBridgeResponse(status);
    assertEquals(encoded.byteLength, BRIDGE_RESPONSE_BYTES);
    assertEquals(decodeBridgeResponse(encoded).status, status);
  }
});

Deno.test("bridge response encode rejects an unknown status", () => {
  assertThrows(() => encodeBridgeResponse(99 as BridgeStatus), RangeError);
});

Deno.test("bridge response decode rejects wrong magic and reserved bytes", () => {
  const good = encodeBridgeResponse(BridgeStatus.Ok);
  const badMagic = good.slice();
  badMagic[1] ^= 0xff;
  assertThrows(
    () => decodeBridgeResponse(badMagic),
    BridgePrefaceError,
    "magic",
  );
  const badReserved = good.slice();
  new DataView(badReserved.buffer).setUint16(10, 7);
  assertThrows(
    () => decodeBridgeResponse(badReserved),
    BridgePrefaceError,
    "reserved",
  );
});

Deno.test("bridge request and response magics differ", () => {
  const req = encodeBridgeRequest(new Uint8Array(32));
  const res = encodeBridgeResponse(BridgeStatus.Ok);
  assert(
    req.subarray(0, 8).join(",") !== res.subarray(0, 8).join(","),
    "request and response prefaces use distinct magic",
  );
});
