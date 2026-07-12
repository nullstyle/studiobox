import { assertEquals } from "@std/assert";
import {
  type CodegenProbe,
  CodegenProbeInterfaceId,
  createCodegenProbeChunkStreamSender,
  ProbeResultCodec,
} from "../../../src/wire/generated/codegen_probe_types.ts";

Deno.test("generated probe bindings encode the declared 64-bit values", () => {
  const encoded = ProbeResultCodec.encode({
    nonce: 0x1020_3040_5060_7080n,
    acceptedChunks: 9n,
  });
  assertEquals(ProbeResultCodec.decode(encoded), {
    nonce: 0x1020_3040_5060_7080n,
    acceptedChunks: 9n,
  });
  assertEquals(typeof CodegenProbeInterfaceId, "bigint");
});

Deno.test("generated streaming sender enforces its in-flight window", async () => {
  let active = 0;
  let maximumActive = 0;
  const received: bigint[] = [];
  const client: CodegenProbe = {
    ping: (nonce) =>
      Promise.resolve({ nonce, acceptedChunks: BigInt(received.length) }),
    async chunk(params): Promise<void> {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      received.push(params.sequence);
      active--;
    },
  };
  const sender = createCodegenProbeChunkStreamSender(client, {
    maxInFlight: 2,
  });
  await sender.send({ sequence: 0n, data: new Uint8Array([0]) });
  await sender.send({ sequence: 1n, data: new Uint8Array([1]) });
  await sender.send({ sequence: 2n, data: new Uint8Array([2]) });
  await sender.flush();
  assertEquals(received, [0n, 1n, 2n]);
  assertEquals(maximumActive <= 2, true);
});
