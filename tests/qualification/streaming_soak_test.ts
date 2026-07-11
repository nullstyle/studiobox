/**
 * M1 streaming qualification soak (PLAN.md M1 item 2), gated behind
 * `SBX_QUALIFY=1`; run with `deno task qualify:streaming`.
 *
 * Pushes a full 1 GiB through the generated `CodegenProbe.chunk`
 * (`-> stream`) binding over TCP on 127.0.0.1 against the published
 * `jsr:@nullstyle/capnp` runtime, then repeats under two concurrent
 * senders and under unawaited burst sends (the window-atomic drain
 * stress). All window / memory / SHA-256 integrity / clean-completion
 * assertions live in the shared harness; this file sets the soak sizes
 * and reports the measured numbers.
 *
 * The task pins `--v8-flags=--max-old-space-size=192` so the RSS bound
 * is decisive: a runtime that buffered the transfer would OOM against
 * the 192 MiB heap cap, while a windowed streaming path completes with
 * RSS growth well inside the 256 MiB budget regardless of how lazily
 * the default GC heuristics would otherwise grow the heap.
 *
 * A few-MiB ungated variant of every scenario runs in CI via
 * `tests/unit/capnp/streaming_soak_smoke_test.ts`.
 */

import {
  type ChunkStreamSoakMetrics,
  runChunkStreamSoak,
} from "./streaming_soak.ts";

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const QUALIFY = ((): boolean => {
  try {
    return Deno.env.get("SBX_QUALIFY") === "1";
  } catch {
    return false;
  }
})();

function report(metrics: ChunkStreamSoakMetrics): void {
  console.log(`[${metrics.label}] measured metrics:`);
  console.log(JSON.stringify(metrics, null, 2));
}

Deno.test({
  name: "qualify streaming: 1 GiB single stream holds an 8-call window " +
    "and stays memory-bounded over TCP",
  ignore: !QUALIFY,
  fn: async () => {
    const metrics = await runChunkStreamSoak({
      label: "qualify-1gib-single",
      streams: [
        {
          totalBytes: 1 * GIB,
          chunkBytes: 256 * KIB,
          maxInFlight: 8,
          seed: 0x51ab_0001,
        },
      ],
      maxRssGrowthBytes: 256 * MIB,
      log: (line) => console.log(line),
    });
    report(metrics);
  },
});

Deno.test({
  name: "qualify streaming: two concurrent 512 MiB streams with " +
    "interleaved pings hold their independent windows",
  ignore: !QUALIFY,
  fn: async () => {
    const metrics = await runChunkStreamSoak({
      label: "qualify-2x512mib-concurrent",
      streams: [
        {
          totalBytes: 512 * MIB,
          chunkBytes: 256 * KIB,
          maxInFlight: 8,
          seed: 0x51ab_0002,
        },
        {
          totalBytes: 512 * MIB,
          chunkBytes: 256 * KIB,
          maxInFlight: 4,
          seed: 0x51ab_0003,
        },
      ],
      pingEveryChunks: 128,
      maxRssGrowthBytes: 256 * MIB,
      log: (line) => console.log(line),
    });
    report(metrics);
  },
});

Deno.test({
  name: "qualify streaming: two concurrent burst senders (unawaited " +
    "sends) never overshoot their windows",
  ignore: !QUALIFY,
  fn: async () => {
    const metrics = await runChunkStreamSoak({
      label: "qualify-2x64mib-burst",
      streams: [
        {
          totalBytes: 64 * MIB,
          chunkBytes: 128 * KIB,
          maxInFlight: 8,
          seed: 0x51ab_0004,
          burstSize: 32,
        },
        {
          totalBytes: 64 * MIB,
          chunkBytes: 128 * KIB,
          maxInFlight: 5,
          seed: 0x51ab_0005,
          burstSize: 32,
        },
      ],
      maxRssGrowthBytes: 256 * MIB,
      log: (line) => console.log(line),
    });
    report(metrics);
  },
});
