import { assertEquals, assertRejects } from "@std/assert";
import {
  encodeTunnelRequest,
  readTunnelRequest,
  TunnelPrefaceError,
} from "../../../src/transports/tunnel_preface.ts";

class ChunkReader {
  #bytes: Uint8Array;
  readonly requested: number[] = [];
  closed = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
  }

  read(destination: Uint8Array): Promise<number | null> {
    this.requested.push(destination.byteLength);
    if (this.#bytes.byteLength === 0) return Promise.resolve(null);
    const length = Math.min(destination.byteLength, this.#bytes.byteLength, 7);
    destination.set(this.#bytes.subarray(0, length));
    this.#bytes = this.#bytes.slice(length);
    return Promise.resolve(length);
  }

  close(): void {
    this.closed = true;
  }

  get remaining(): Uint8Array {
    return this.#bytes.slice();
  }
}

Deno.test("tunnel request reader consumes exactly the fixed preface", async () => {
  const ticket = crypto.getRandomValues(new Uint8Array(32));
  const trailing = new Uint8Array([9, 8, 7]);
  const reader = new ChunkReader(
    new Uint8Array([...encodeTunnelRequest(ticket), ...trailing]),
  );
  assertEquals(await readTunnelRequest(reader), {
    version: 1,
    flags: 0,
    ticket,
  });
  assertEquals(reader.remaining, trailing);
  assertEquals(reader.requested[0], 44);
});

Deno.test("tunnel request reader closes a stalled connection at its deadline", async () => {
  let release: ((value: null) => void) | undefined;
  const reader = {
    closed: false,
    read(): Promise<null> {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    close(): void {
      this.closed = true;
      release?.(null);
    },
  };
  await assertRejects(
    () => readTunnelRequest(reader, { timeoutMs: 5 }),
    TunnelPrefaceError,
    "deadline",
  );
  assertEquals(reader.closed, true);
});
