/**
 * Incremental (streaming) SHA-256 for the agent wire plane.
 *
 * The wire's bulk-transfer contract (`schema/streams.capnp`
 * `TransferCommit`/`TransferReceipt`) carries a SHA-256 over the whole
 * transferred body, but the bodies themselves are unbounded (process
 * stdout, file uploads) and MUST NOT be buffered (DESIGN.md §4 "no
 * unbounded buffering anywhere on the path"). WebCrypto's
 * `crypto.subtle.digest` is one-shot, so this module provides a small,
 * dependency-free incremental implementation (FIPS 180-4) that hashes
 * chunk-by-chunk as bytes stream through the plane.
 *
 * Verified against `crypto.subtle.digest("SHA-256", ...)` in
 * `tests/unit/agent/sha256_test.ts`.
 *
 * @module
 */

const K = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Streaming SHA-256 hasher: feed bytes with {@linkcode Sha256.update},
 * finalize once with {@linkcode Sha256.digest}. `update` after `digest`
 * throws — one hasher hashes exactly one body.
 */
export class Sha256 {
  #state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  #block = new Uint8Array(64);
  #blockLength = 0;
  #bytesHashed = 0;
  #schedule = new Uint32Array(64);
  #digest: Uint8Array<ArrayBuffer> | null = null;

  /** Absorb `data`; returns `this` for chaining. */
  update(data: Uint8Array): this {
    if (this.#digest !== null) {
      throw new TypeError("Sha256 is finalized; create a new hasher");
    }
    this.#bytesHashed += data.byteLength;
    let offset = 0;
    if (this.#blockLength > 0) {
      const take = Math.min(64 - this.#blockLength, data.byteLength);
      this.#block.set(data.subarray(0, take), this.#blockLength);
      this.#blockLength += take;
      offset = take;
      if (this.#blockLength === 64) {
        this.#compress(this.#block, 0);
        this.#blockLength = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.#compress(data, offset);
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.#block.set(data.subarray(offset), 0);
      this.#blockLength = data.byteLength - offset;
    }
    return this;
  }

  /** Finalize and return the 32-byte digest (cached; safe to re-read). */
  digest(): Uint8Array<ArrayBuffer> {
    if (this.#digest !== null) return this.#digest.slice();
    const bitLengthHigh = Math.floor(this.#bytesHashed / 0x20000000);
    const bitLengthLow = (this.#bytesHashed << 3) >>> 0;
    const padded = new Uint8Array(this.#blockLength <= 55 ? 64 : 128);
    padded.set(this.#block.subarray(0, this.#blockLength), 0);
    padded[this.#blockLength] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.byteLength - 8, bitLengthHigh, false);
    view.setUint32(padded.byteLength - 4, bitLengthLow, false);
    for (let offset = 0; offset < padded.byteLength; offset += 64) {
      this.#compress(padded, offset);
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.#state[i], false);
    this.#digest = out;
    return out.slice();
  }

  #compress(bytes: Uint8Array, offset: number): void {
    const w = this.#schedule;
    for (let i = 0; i < 16; i++) {
      const base = offset + i * 4;
      w[i] = (bytes[base] << 24) | (bytes[base + 1] << 16) |
        (bytes[base + 2] << 8) | bytes[base + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.#state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const state = this.#state;
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
}

/** One-shot convenience over {@linkcode Sha256}. */
export function sha256(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Sha256().update(data).digest();
}
