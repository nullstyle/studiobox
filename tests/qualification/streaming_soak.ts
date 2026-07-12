/**
 * M1 streaming qualification soak harness (PLAN.md M1 item 2).
 *
 * Streams deterministic pseudo-random payloads through the generated
 * `CodegenProbe.chunk` (`-> stream`) binding over a real `TcpTransport`
 * pair on 127.0.0.1, using only the published `jsr:@nullstyle/capnp`
 * runtime pinned in deno.json. Every run asserts:
 *
 * a. the configured in-flight window is never exceeded, measured from
 *    outside the stream sender (an instrumented client facade counts
 *    concurrently outstanding `chunk` RPCs per stream) and at the wire
 *    level (`RpcWireClient.stats.pendingReturns` and the TCP outbound
 *    queue are sampled against explicit ceilings);
 * b. process RSS stays bounded: `Deno.memoryUsage().rss` is sampled per
 *    chunk on both sides plus on a timer, and peak-minus-baseline must
 *    stay below the configured budget (streaming must never buffer the
 *    whole transfer). The qualify task additionally pins V8's old space
 *    (`--max-old-space-size=192`) far below the payload size so the
 *    bound measures the runtime's live set rather than V8's lazy-GC
 *    heap-growth heuristics — if the runtime buffered the gigabyte the
 *    soak would hard-OOM long before the assertion;
 * c. end-to-end integrity via SHA-256: ordered streams compare a SHA-256
 *    hash chain (`H_i = SHA-256(H_{i-1} || chunk_i)`, `H_0 = 0^32`)
 *    computed over what was sent against the same chain computed over
 *    what arrived, which also proves per-stream ordering; burst streams
 *    (unawaited concurrent `send()` calls, the window-atomic drain
 *    stress) regenerate each chunk from `(seed, index)` on the receiving
 *    side and require exact byte equality with exactly-once accounting;
 * d. clean completion: a final `ping` receipt must report every accepted
 *    chunk, and teardown must leave no pending returns, no exported
 *    capabilities, and closed transports on both sides.
 *
 * Consumed by `tests/unit/capnp/streaming_soak_smoke_test.ts` (few-MiB,
 * always on in CI) and `tests/qualification/streaming_soak_test.ts`
 * (full 1 GiB soak behind `SBX_QUALIFY=1`; `deno task qualify:streaming`).
 */

import { assert, assertEquals } from "@std/assert";
import { RpcWireClient, serveConnection, TcpTransport } from "@nullstyle/capnp";
import {
  CodegenProbe,
  type CodegenProbe as CodegenProbeApi,
  type CodegenProbeService,
  createCodegenProbeChunkStreamSender,
} from "../../src/wire/generated/codegen_probe_types.ts";

/** One logical stream pushed through `CodegenProbe.chunk` during a soak. */
export interface ChunkStreamPlan {
  /** Total payload bytes; must be a positive multiple of `chunkBytes`. */
  readonly totalBytes: number;
  /** Bytes per chunk; must be a positive multiple of 4. */
  readonly chunkBytes: number;
  /** Streaming window (`maxInFlight`) for the generated stream sender. */
  readonly maxInFlight: number;
  /** Deterministic payload seed for this stream. */
  readonly seed: number;
  /**
   * When set, the stream issues this many unawaited `send()` calls per
   * batch instead of awaiting each send (the window-atomic drain
   * stress). Delivery order within a batch is intentionally not
   * asserted; integrity switches to per-chunk regeneration.
   */
  readonly burstSize?: number;
}

/** Configuration for one full soak run (one connection, N streams). */
export interface ChunkStreamSoakOptions {
  /** Diagnostic label used in peer ids and log lines. */
  readonly label: string;
  /** Streams to drive concurrently over one TCP connection. */
  readonly streams: readonly ChunkStreamPlan[];
  /** Upper bound for RSS peak minus RSS baseline, in bytes. */
  readonly maxRssGrowthBytes: number;
  /** Per-call timeout. Defaults to 30_000 ms. */
  readonly callTimeoutMs?: number;
  /**
   * When set, each ordered stream fires an interleaved `ping` after
   * every N chunks (at most one outstanding per stream) to mix unary
   * traffic into the streaming window.
   */
  readonly pingEveryChunks?: number;
  /** RSS/stats sampling interval. Defaults to 25 ms. */
  readonly rssSampleIntervalMs?: number;
  /** Progress/diagnostic sink. Defaults to discarding lines. */
  readonly log?: (line: string) => void;
}

/** Per-stream measured results. */
export interface ChunkStreamSoakStreamMetrics {
  readonly streamId: number;
  readonly mode: "ordered" | "burst";
  readonly configuredMaxInFlight: number;
  readonly chunkBytes: number;
  readonly chunksSent: number;
  readonly bytesSent: number;
  readonly chunksReceivedByServer: number;
  readonly bytesReceivedByServer: number;
  /** Highest `sender.inFlight` observed after any send. */
  readonly maxObservedSenderInFlight: number;
  /** Highest concurrent `chunk` RPC count observed outside the sender. */
  readonly maxConcurrentChunkRpcs: number;
  /** SHA-256 chain over sent chunks (ordered streams only). */
  readonly sha256ChainSent: string | null;
  /** SHA-256 chain over received chunks (ordered streams only). */
  readonly sha256ChainReceived: string | null;
  readonly durationMs: number;
}

/** Whole-run measured results returned by {@link runChunkStreamSoak}. */
export interface ChunkStreamSoakMetrics {
  readonly label: string;
  readonly totalBytes: number;
  readonly totalChunks: number;
  readonly durationMs: number;
  readonly throughputMiBPerSecond: number;
  readonly rssBaselineBytes: number;
  readonly rssPeakBytes: number;
  readonly rssAfterBytes: number;
  readonly rssGrowthBytes: number;
  readonly maxRssGrowthBytes: number;
  readonly maxPendingReturns: number;
  readonly pendingReturnsCeiling: number;
  readonly maxOutboundQueuedBytes: number;
  readonly outboundQueuedBytesCeiling: number;
  readonly maxConcurrentServerChunks: number;
  readonly finalReceiptAcceptedChunks: number;
  readonly streams: readonly ChunkStreamSoakStreamMetrics[];
}

const RECEIPT_NONCE = 0x600d_f00dn;
const SEQUENCE_INDEX_MASK = 0xffff_ffffn;

function createXorshift32(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e37_79b9;
  return (): number => {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state;
  };
}

function fillDeterministic(bytes: Uint8Array, next: () => number): void {
  const words = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 4,
  );
  for (let i = 0; i < words.length; i++) words[i] = next();
}

function burstChunkSeed(streamSeed: number, index: number): number {
  const mixed = (streamSeed ^ Math.imul(index + 0x7f4a_7c15, 0x9e37_79b9)) >>>
    0;
  return mixed || 0x2545_f491;
}

function generateBurstChunk(plan: ChunkStreamPlan, index: number): Uint8Array {
  const data = new Uint8Array(plan.chunkBytes);
  fillDeterministic(data, createXorshift32(burstChunkSeed(plan.seed, index)));
  return data;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Incremental SHA-256 hash chain: `H_0 = 0^32`,
 * `H_i = SHA-256(H_{i-1} || chunk_i)`. Equal chains prove the two sides
 * saw byte-identical chunks in the identical order without either side
 * buffering more than one chunk.
 */
class Sha256Chain {
  #state = new Uint8Array(32);
  #scratch = new Uint8Array(0);

  async absorb(chunk: Uint8Array): Promise<void> {
    const needed = 32 + chunk.byteLength;
    if (this.#scratch.byteLength < needed) {
      this.#scratch = new Uint8Array(needed);
    }
    this.#scratch.set(this.#state, 0);
    this.#scratch.set(chunk, 32);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      this.#scratch.subarray(0, needed),
    );
    this.#state = new Uint8Array(digest);
  }

  get hex(): string {
    return toHex(this.#state);
  }
}

function chunkCountOf(plan: ChunkStreamPlan): number {
  return plan.totalBytes / plan.chunkBytes;
}

function validatePlan(plan: ChunkStreamPlan, streamId: number): void {
  const name = `streams[${streamId}]`;
  assert(
    Number.isInteger(plan.totalBytes) && plan.totalBytes > 0,
    `${name}.totalBytes must be a positive integer`,
  );
  assert(
    Number.isInteger(plan.chunkBytes) && plan.chunkBytes > 0 &&
      plan.chunkBytes % 4 === 0,
    `${name}.chunkBytes must be a positive multiple of 4`,
  );
  assert(
    plan.totalBytes % plan.chunkBytes === 0,
    `${name}.totalBytes must be a multiple of chunkBytes`,
  );
  assert(
    Number.isInteger(plan.maxInFlight) && plan.maxInFlight >= 1,
    `${name}.maxInFlight must be a positive integer`,
  );
  assert(
    chunkCountOf(plan) <= 0xffff_ffff,
    `${name} chunk count exceeds the 32-bit sequence index space`,
  );
  if (plan.burstSize !== undefined) {
    assert(
      Number.isInteger(plan.burstSize) && plan.burstSize >= 1,
      `${name}.burstSize must be a positive integer`,
    );
  }
}

interface ServerStreamState {
  chunksReceived: number;
  bytesReceived: number;
  nextOrderedIndex: number;
  readonly chain: Sha256Chain;
  readonly receivedIndices: Set<number>;
}

/**
 * Run one streaming soak: serve `CodegenProbe` over a fresh loopback TCP
 * connection, drive every configured stream concurrently through the
 * generated chunk stream sender, and enforce the window / memory /
 * integrity / completion assertions documented on this module.
 *
 * @param options - Soak configuration (streams, budgets, logging).
 * @returns Measured metrics for reporting; all assertions have already
 * passed when the promise resolves.
 */
export async function runChunkStreamSoak(
  options: ChunkStreamSoakOptions,
): Promise<ChunkStreamSoakMetrics> {
  assert(options.streams.length >= 1, "at least one stream plan is required");
  options.streams.forEach((plan, streamId) => validatePlan(plan, streamId));
  const callTimeoutMs = options.callTimeoutMs ?? 30_000;
  const pingEveryChunks = options.pingEveryChunks;
  const log = options.log ?? ((): void => {});

  const rssBaselineBytes = Deno.memoryUsage().rss;
  let rssPeakBytes = rssBaselineBytes;
  let maxPendingReturns = 0;
  let maxOutboundQueuedBytes = 0;

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  const acceptPromise = listener.accept();
  let clientConn: Deno.TcpConn;
  let serverConn: Deno.TcpConn;
  try {
    clientConn = await Deno.connect({
      hostname: "127.0.0.1",
      port: address.port,
    });
    serverConn = await acceptPromise;
  } finally {
    listener.close();
  }
  clientConn.setNoDelay(true);
  serverConn.setNoDelay(true);

  const transportLimits = {
    frameLimits: { maxFrameBytes: 8 * 1024 * 1024 },
    maxOutboundFrameBytes: 8 * 1024 * 1024,
    maxQueuedOutboundFrames: 4096,
    maxQueuedOutboundBytes: 128 * 1024 * 1024,
    sendTimeoutMs: callTimeoutMs,
    closeTimeoutMs: callTimeoutMs,
  };

  let wireClient: RpcWireClient | null = null;
  const serverTransport = new TcpTransport(serverConn, transportLimits);
  const clientTransport = new TcpTransport(clientConn, {
    ...transportLimits,
    onClose: () => wireClient?.close(),
  });

  const sample = (): void => {
    if (wireClient !== null) {
      const pending = wireClient.stats.pendingReturns;
      if (pending > maxPendingReturns) maxPendingReturns = pending;
    }
    const transportStats = clientTransport.stats;
    const outbound = transportStats.queuedOutboundBytes +
      transportStats.inflightOutboundBytes;
    if (outbound > maxOutboundQueuedBytes) maxOutboundQueuedBytes = outbound;
    const rss = Deno.memoryUsage().rss;
    if (rss > rssPeakBytes) rssPeakBytes = rss;
  };

  const serverStreams: ServerStreamState[] = options.streams.map(() => ({
    chunksReceived: 0,
    bytesReceived: 0,
    nextOrderedIndex: 0,
    chain: new Sha256Chain(),
    receivedIndices: new Set<number>(),
  }));
  let totalAcceptedChunks = 0;
  let activeServerChunks = 0;
  let maxConcurrentServerChunks = 0;

  const service: CodegenProbeService = {
    ping(nonce) {
      return { nonce, acceptedChunks: BigInt(totalAcceptedChunks) };
    },
    async chunk(params) {
      activeServerChunks += 1;
      maxConcurrentServerChunks = Math.max(
        maxConcurrentServerChunks,
        activeServerChunks,
      );
      try {
        const streamId = Number(params.sequence >> 32n);
        const index = Number(params.sequence & SEQUENCE_INDEX_MASK);
        const plan = options.streams[streamId];
        const state = serverStreams[streamId];
        assert(
          plan !== undefined && state !== undefined,
          `server received a chunk for unknown stream ${streamId}`,
        );
        assertEquals(
          params.data.byteLength,
          plan.chunkBytes,
          `stream ${streamId} chunk ${index}: unexpected chunk size`,
        );
        if (plan.burstSize !== undefined) {
          assert(
            index >= 0 && index < chunkCountOf(plan),
            `stream ${streamId}: chunk index ${index} out of range`,
          );
          assert(
            !state.receivedIndices.has(index),
            `stream ${streamId}: duplicate chunk ${index}`,
          );
          state.receivedIndices.add(index);
          const expected = generateBurstChunk(plan, index);
          assert(
            bytesEqual(expected, params.data),
            `stream ${streamId}: chunk ${index} payload mismatch`,
          );
        } else {
          assertEquals(
            index,
            state.nextOrderedIndex,
            `stream ${streamId}: out-of-order chunk`,
          );
          state.nextOrderedIndex += 1;
          await state.chain.absorb(params.data);
        }
        state.chunksReceived += 1;
        state.bytesReceived += params.data.byteLength;
        totalAcceptedChunks += 1;
        sample();
      } finally {
        activeServerChunks -= 1;
      }
    },
  };

  const rssTimer = setInterval(sample, options.rssSampleIntervalMs ?? 25);
  let handle: Awaited<ReturnType<typeof serveConnection>> | null = null;
  try {
    handle = await serveConnection(
      CodegenProbe,
      {
        transport: serverTransport,
        localAddress: { transport: "tcp" },
        remoteAddress: { transport: "tcp" },
        id: `studiobox-streaming-soak-${options.label}`,
      },
      service,
    );
    wireClient = new RpcWireClient(clientTransport, {
      defaultTimeoutMs: callTimeoutMs,
    });
    const probe = await CodegenProbe.bootstrapClient(wireClient, {
      timeoutMs: callTimeoutMs,
    });

    const driveStream = async (
      plan: ChunkStreamPlan,
      streamId: number,
    ): Promise<ChunkStreamSoakStreamMetrics> => {
      const chunkCount = chunkCountOf(plan);
      const startedAt = performance.now();
      let activeRpcs = 0;
      let maxActiveRpcs = 0;
      let maxSenderInFlight = 0;

      const facade: CodegenProbeApi = {
        ping: (nonce, callOptions) => probe.ping(nonce, callOptions),
        chunk: async (params, callOptions) => {
          activeRpcs += 1;
          maxActiveRpcs = Math.max(maxActiveRpcs, activeRpcs);
          assert(
            activeRpcs <= plan.maxInFlight,
            `stream ${streamId}: ${activeRpcs} concurrent chunk RPCs ` +
              `overshoot the configured ${plan.maxInFlight}-call window`,
          );
          sample();
          try {
            await probe.chunk(params, callOptions);
          } finally {
            activeRpcs -= 1;
            sample();
          }
        },
      };
      const sender = createCodegenProbeChunkStreamSender(facade, {
        maxInFlight: plan.maxInFlight,
        call: { timeoutMs: callTimeoutMs },
      });
      const observeWindow = (): void => {
        maxSenderInFlight = Math.max(maxSenderInFlight, sender.inFlight);
        assert(
          sender.inFlight <= plan.maxInFlight,
          `stream ${streamId}: sender.inFlight=${sender.inFlight} exceeds ` +
            `the configured ${plan.maxInFlight}-call window`,
        );
      };

      let pendingPing: Promise<void> | null = null;
      const maybePing = async (index: number): Promise<void> => {
        if (pingEveryChunks === undefined) return;
        if ((index + 1) % pingEveryChunks !== 0) return;
        if (pendingPing !== null) await pendingPing;
        const nonce = (BigInt(streamId) << 32n) | BigInt(index);
        pendingPing = probe
          .ping(nonce, { timeoutMs: callTimeoutMs })
          .then((result) => {
            assertEquals(result.nonce, nonce, "interleaved ping echo");
          });
      };

      const sequenceOf = (index: number): bigint =>
        (BigInt(streamId) << 32n) | BigInt(index);

      let chainHex: string | null = null;
      if (plan.burstSize === undefined) {
        const next = createXorshift32(plan.seed);
        const chain = new Sha256Chain();
        for (let index = 0; index < chunkCount; index++) {
          await sender.waitForCapacity();
          const data = new Uint8Array(plan.chunkBytes);
          fillDeterministic(data, next);
          await chain.absorb(data);
          await sender.send({ sequence: sequenceOf(index), data });
          observeWindow();
          await maybePing(index);
          if (chunkCount > 1024 && (index + 1) % 1024 === 0) {
            log(
              `[${options.label}] stream ${streamId}: ` +
                `${index + 1}/${chunkCount} chunks ` +
                `(${formatMiB((index + 1) * plan.chunkBytes)} MiB), ` +
                `rss=${formatMiB(Deno.memoryUsage().rss)} MiB, ` +
                `pendingReturns=${wireClient?.stats.pendingReturns}`,
            );
          }
        }
        chainHex = chain.hex;
      } else {
        let index = 0;
        while (index < chunkCount) {
          const batchSize = Math.min(plan.burstSize, chunkCount - index);
          const batch: Promise<void>[] = [];
          for (let offset = 0; offset < batchSize; offset++) {
            const chunkIndex = index + offset;
            const data = generateBurstChunk(plan, chunkIndex);
            batch.push(
              sender.send({ sequence: sequenceOf(chunkIndex), data }),
            );
            observeWindow();
          }
          await Promise.all(batch);
          observeWindow();
          await maybePing(index + batchSize - 1);
          index += batchSize;
        }
      }

      await sender.flush();
      if (pendingPing !== null) await pendingPing;
      observeWindow();
      assertEquals(sender.inFlight, 0, `stream ${streamId}: window drained`);
      assertEquals(sender.totalSent, chunkCount);
      assertEquals(sender.totalReceived, chunkCount);
      assertEquals(sender.state, "open");
      assertEquals(sender.maxInFlight, plan.maxInFlight);

      return {
        streamId,
        mode: plan.burstSize === undefined ? "ordered" : "burst",
        configuredMaxInFlight: plan.maxInFlight,
        chunkBytes: plan.chunkBytes,
        chunksSent: chunkCount,
        bytesSent: plan.totalBytes,
        chunksReceivedByServer: 0,
        bytesReceivedByServer: 0,
        maxObservedSenderInFlight: maxSenderInFlight,
        maxConcurrentChunkRpcs: maxActiveRpcs,
        sha256ChainSent: chainHex,
        sha256ChainReceived: null,
        durationMs: performance.now() - startedAt,
      };
    };

    const streamingStartedAt = performance.now();
    const driven = await Promise.all(
      options.streams.map((plan, streamId) => driveStream(plan, streamId)),
    );
    const durationMs = performance.now() - streamingStartedAt;

    // (d) Final receipt: the server must have accepted every chunk.
    const totalChunks = options.streams.reduce(
      (acc, plan) => acc + chunkCountOf(plan),
      0,
    );
    const receipt = await probe.ping(RECEIPT_NONCE, {
      timeoutMs: callTimeoutMs,
    });
    assertEquals(receipt.nonce, RECEIPT_NONCE, "final receipt echo");
    assertEquals(
      receipt.acceptedChunks,
      BigInt(totalChunks),
      "final receipt must account for every streamed chunk",
    );

    // (c) Integrity: per-stream server-side accounting and SHA-256 chains.
    const streams = driven.map((metrics): ChunkStreamSoakStreamMetrics => {
      const plan = options.streams[metrics.streamId];
      const state = serverStreams[metrics.streamId];
      assertEquals(
        state.chunksReceived,
        metrics.chunksSent,
        `stream ${metrics.streamId}: server chunk count`,
      );
      assertEquals(
        state.bytesReceived,
        plan.totalBytes,
        `stream ${metrics.streamId}: server byte count`,
      );
      let chainReceived: string | null = null;
      if (plan.burstSize === undefined) {
        chainReceived = state.chain.hex;
        assertEquals(
          chainReceived,
          metrics.sha256ChainSent,
          `stream ${metrics.streamId}: SHA-256 chain mismatch between ` +
            `sent and received payloads`,
        );
      } else {
        assertEquals(
          state.receivedIndices.size,
          metrics.chunksSent,
          `stream ${metrics.streamId}: burst chunks must arrive exactly once`,
        );
      }
      return {
        ...metrics,
        chunksReceivedByServer: state.chunksReceived,
        bytesReceivedByServer: state.bytesReceived,
        sha256ChainReceived: chainReceived,
      };
    });

    // (a) Wire-level window ceilings across all concurrent streams.
    const sumWindows = options.streams.reduce(
      (acc, plan) => acc + plan.maxInFlight,
      0,
    );
    const pendingReturnsCeiling = sumWindows + options.streams.length;
    assert(
      maxPendingReturns <= pendingReturnsCeiling,
      `pendingReturns peaked at ${maxPendingReturns}, exceeding the ` +
        `window ceiling ${pendingReturnsCeiling}`,
    );
    const outboundQueuedBytesCeiling = options.streams.reduce(
      (acc, plan) => acc + plan.maxInFlight * (plan.chunkBytes + 4096),
      1024 * 1024,
    );
    assert(
      maxOutboundQueuedBytes <= outboundQueuedBytesCeiling,
      `client outbound queue peaked at ${maxOutboundQueuedBytes} bytes, ` +
        `exceeding the window-derived ceiling ${outboundQueuedBytesCeiling}`,
    );
    assertEquals(
      maxConcurrentServerChunks,
      1,
      "generated server must serialize -> stream chunk handlers",
    );

    // (d) Clean completion: explicit teardown with post-close assertions.
    await wireClient.close();
    assertEquals(wireClient.stats.closed, true);
    assertEquals(wireClient.stats.pendingReturns, 0);
    assertEquals(wireClient.stats.exportedCapabilities, 0);
    await handle.close();
    await serverTransport.close();
    await clientTransport.close();
    assertEquals(clientTransport.stats.closed, true);
    assertEquals(serverTransport.stats.closed, true);

    // (b) Memory bound over the whole run, including teardown.
    sample();
    const rssAfterBytes = Deno.memoryUsage().rss;
    const rssGrowthBytes = rssPeakBytes - rssBaselineBytes;
    assert(
      rssGrowthBytes < options.maxRssGrowthBytes,
      `rss grew ${formatMiB(rssGrowthBytes)} MiB ` +
        `(baseline ${formatMiB(rssBaselineBytes)} MiB, ` +
        `peak ${formatMiB(rssPeakBytes)} MiB); ` +
        `budget is ${formatMiB(options.maxRssGrowthBytes)} MiB`,
    );

    const totalBytes = options.streams.reduce(
      (acc, plan) => acc + plan.totalBytes,
      0,
    );
    return {
      label: options.label,
      totalBytes,
      totalChunks,
      durationMs,
      throughputMiBPerSecond: totalBytes / (1024 * 1024) /
        (durationMs / 1000),
      rssBaselineBytes,
      rssPeakBytes,
      rssAfterBytes,
      rssGrowthBytes,
      maxRssGrowthBytes: options.maxRssGrowthBytes,
      maxPendingReturns,
      pendingReturnsCeiling,
      maxOutboundQueuedBytes,
      outboundQueuedBytesCeiling,
      maxConcurrentServerChunks,
      finalReceiptAcceptedChunks: Number(receipt.acceptedChunks),
      streams,
    };
  } finally {
    clearInterval(rssTimer);
    await wireClient?.close().catch(() => {});
    if (handle !== null) await handle.close().catch(() => {});
    await serverTransport.close().catch(() => {});
    await clientTransport.close().catch(() => {});
  }
}
