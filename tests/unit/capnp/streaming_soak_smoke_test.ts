/**
 * CI-sized (few-MiB) variants of the M1 streaming qualification soak so
 * the full path — generated `-> stream` bindings, `TcpTransport` on
 * 127.0.0.1, window enforcement, RSS bound, SHA-256 chain integrity,
 * final receipt, clean teardown — is exercised on every test run.
 *
 * The full 1 GiB soak lives in
 * `tests/qualification/streaming_soak_test.ts` behind `SBX_QUALIFY=1`
 * (`deno task qualify:streaming`).
 */

import { assert, assertEquals } from "@std/assert";
import { runChunkStreamSoak } from "../../qualification/streaming_soak.ts";

const KIB = 1024;
const MIB = 1024 * 1024;

Deno.test("streaming smoke: 8 MiB ordered stream over TCP holds its window and hash chain", async () => {
  const metrics = await runChunkStreamSoak({
    label: "smoke-single-ordered",
    streams: [
      {
        totalBytes: 8 * MIB,
        chunkBytes: 64 * KIB,
        maxInFlight: 4,
        seed: 0x0515_0001,
      },
    ],
    maxRssGrowthBytes: 256 * MIB,
  });

  assertEquals(metrics.totalChunks, 128);
  assertEquals(metrics.finalReceiptAcceptedChunks, 128);
  const stream = metrics.streams[0];
  assertEquals(stream.chunksReceivedByServer, 128);
  assertEquals(stream.bytesReceivedByServer, 8 * MIB);
  assert(stream.sha256ChainSent !== null, "ordered stream records a chain");
  assertEquals(stream.sha256ChainSent, stream.sha256ChainReceived);
  assert(
    stream.maxConcurrentChunkRpcs <= 4,
    "chunk RPC concurrency must respect the window",
  );
  assert(
    stream.maxObservedSenderInFlight >= 2,
    "the soak should actually pipeline chunks",
  );
});

Deno.test("streaming smoke: two concurrent ordered streams with interleaved pings hold independent windows", async () => {
  const metrics = await runChunkStreamSoak({
    label: "smoke-concurrent-ordered",
    streams: [
      {
        totalBytes: 4 * MIB,
        chunkBytes: 64 * KIB,
        maxInFlight: 3,
        seed: 0x0515_0002,
      },
      {
        totalBytes: 4 * MIB,
        chunkBytes: 64 * KIB,
        maxInFlight: 5,
        seed: 0x0515_0003,
      },
    ],
    pingEveryChunks: 16,
    maxRssGrowthBytes: 256 * MIB,
  });

  assertEquals(metrics.totalChunks, 128);
  assertEquals(metrics.finalReceiptAcceptedChunks, 128);
  assert(metrics.maxPendingReturns <= metrics.pendingReturnsCeiling);
  for (const stream of metrics.streams) {
    assertEquals(stream.sha256ChainSent, stream.sha256ChainReceived);
    assert(
      stream.maxConcurrentChunkRpcs <= stream.configuredMaxInFlight,
      `stream ${stream.streamId} must respect its own window`,
    );
  }
  assertEquals(metrics.streams[0].configuredMaxInFlight, 3);
  assertEquals(metrics.streams[1].configuredMaxInFlight, 5);
});

Deno.test("streaming smoke: concurrent burst senders (unawaited sends) never overshoot their windows", async () => {
  const metrics = await runChunkStreamSoak({
    label: "smoke-concurrent-burst",
    streams: [
      {
        totalBytes: 2 * MIB,
        chunkBytes: 64 * KIB,
        maxInFlight: 4,
        seed: 0x0515_0004,
        burstSize: 8,
      },
      {
        totalBytes: 2 * MIB,
        chunkBytes: 64 * KIB,
        maxInFlight: 3,
        seed: 0x0515_0005,
        burstSize: 16,
      },
    ],
    maxRssGrowthBytes: 256 * MIB,
  });

  assertEquals(metrics.totalChunks, 64);
  assertEquals(metrics.finalReceiptAcceptedChunks, 64);
  for (const stream of metrics.streams) {
    assertEquals(stream.mode, "burst");
    assertEquals(stream.chunksReceivedByServer, 32);
    assertEquals(stream.bytesReceivedByServer, 2 * MIB);
    assert(
      stream.maxConcurrentChunkRpcs <= stream.configuredMaxInFlight,
      `stream ${stream.streamId} must respect its own window under ` +
        "unawaited concurrent sends",
    );
  }
});
