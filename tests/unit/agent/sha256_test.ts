// src/agent/sha256.ts conformance against WebCrypto: the streaming
// hasher must produce byte-identical digests to crypto.subtle for
// bodies split at arbitrary chunk boundaries (including the FIPS 180-4
// padding edges at 55/56/64-byte block positions).

import { assertEquals, assertThrows } from "@std/assert";
import { Sha256, sha256 } from "../../../src/agent/sha256.ts";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function subtleHex(data: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        data.slice().buffer as ArrayBuffer,
      ),
    ),
  );
}

function deterministicBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

Deno.test("sha256: known vectors", () => {
  assertEquals(
    toHex(sha256(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    toHex(sha256(new TextEncoder().encode("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("sha256: matches WebCrypto across padding-edge lengths", async () => {
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 127, 128, 1000]) {
    const data = deterministicBytes(length, length + 1);
    assertEquals(
      toHex(sha256(data)),
      await subtleHex(data),
      `length ${length}`,
    );
  }
});

Deno.test("sha256: streaming updates equal one-shot regardless of chunking", async () => {
  const data = deterministicBytes(200_003, 0x5eed);
  const expected = await subtleHex(data);
  for (const chunkSize of [1, 7, 63, 64, 65, 4096, 65536]) {
    const hasher = new Sha256();
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      hasher.update(data.subarray(offset, offset + chunkSize));
    }
    assertEquals(toHex(hasher.digest()), expected, `chunk size ${chunkSize}`);
  }
});

Deno.test("sha256: digest is cached and update-after-digest throws", () => {
  const hasher = new Sha256().update(new TextEncoder().encode("abc"));
  const first = hasher.digest();
  assertEquals(toHex(hasher.digest()), toHex(first));
  // The returned digest is a copy — mutating it must not corrupt the cache.
  first[0] ^= 0xff;
  assertEquals(
    toHex(hasher.digest()),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertThrows(() => hasher.update(new Uint8Array(1)), TypeError);
});
