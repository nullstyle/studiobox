// M1 gate 4: compiled-runtime probe.
//
// Self-contained proof that the WASM-backed capnp RPC session core from the
// published `jsr:@nullstyle/capnp` package works from a `deno compile`
// artifact. The WASM module is a static ES-module import inside the package
// (`generated/capnp_deno.wasm` behind `createRuntimePeer`), so a correct
// compile embeds it in the binary's module graph — no repo-relative path, no
// DENO_DIR, no network fetch. This probe:
//
//   1. boots a CodegenProbe server on an ephemeral loopback TCP port,
//   2. connects a client over a real socket pair,
//   3. asserts the production WASM ABI capabilities (fake-WASM fixtures fail),
//   4. performs a unary round-trip,
//   5. drives a bounded application stream (window held, order and payload
//      bytes verified server-side),
//   6. prints `PROBE_OK` and exits 0; any failure prints detail to stderr and
//      exits nonzero (watchdog exit 3 guards against hangs).
//
// Compile + run natively: `deno task compile:probe`. Cross-targets are built
// into .build/ by the M1 qualification run (see compat/wire.json).

import { RpcWireClient, serveConnection, TcpTransport } from "@nullstyle/capnp";
import {
  CodegenProbe,
  type CodegenProbeService,
  createCodegenProbeChunkStreamSender,
} from "../src/wire/generated/codegen_probe_types.ts";

const CALL_TIMEOUT_MS = 5_000;
const WATCHDOG_MS = 30_000;
const STREAM_COUNT = 32;
const STREAM_WINDOW = 4;
const CHUNK_BYTES = 4_096;

class ProbeFailure extends Error {}

function check(condition: boolean, detail: string): void {
  if (!condition) throw new ProbeFailure(detail);
}

function chunkPayload(sequence: bigint): Uint8Array {
  const bytes = new Uint8Array(CHUNK_BYTES);
  const seed = Number(sequence % 251n);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (seed * 31 + index * 7) & 0xff;
  }
  return bytes;
}

async function main(): Promise<void> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const acceptPromise = listener.accept();
  const clientConn = await Deno.connect({ hostname: "127.0.0.1", port });
  const serverConn = await acceptPromise;
  listener.close();

  let acceptedChunks = 0n;
  const chunkErrors: string[] = [];
  const service: CodegenProbeService = {
    ping(nonce) {
      return { nonce, acceptedChunks };
    },
    chunk(params) {
      if (params.sequence !== acceptedChunks) {
        chunkErrors.push(
          `chunk out of order: got sequence ${params.sequence}, expected ${acceptedChunks}`,
        );
        return;
      }
      const expected = chunkPayload(params.sequence);
      if (params.data.length !== expected.length) {
        chunkErrors.push(
          `chunk ${params.sequence}: got ${params.data.length} bytes, expected ${expected.length}`,
        );
        return;
      }
      for (let index = 0; index < expected.length; index++) {
        if (params.data[index] !== expected[index]) {
          chunkErrors.push(
            `chunk ${params.sequence}: payload mismatch at byte ${index}`,
          );
          return;
        }
      }
      acceptedChunks++;
    },
  };

  const serverTransport = new TcpTransport(serverConn, {
    closeTimeoutMs: CALL_TIMEOUT_MS,
  });
  let wireClient: RpcWireClient | null = null;
  const clientTransport = new TcpTransport(clientConn, {
    closeTimeoutMs: CALL_TIMEOUT_MS,
    onClose: () => wireClient?.close(),
  });

  const handle = await serveConnection(
    CodegenProbe,
    {
      transport: serverTransport,
      localAddress: { transport: "tcp" },
      remoteAddress: { transport: "tcp" },
      id: "studiobox-compiled-probe",
    },
    service,
  );

  try {
    // Production-WASM feature assertions: the session runtime behind
    // serveConnection statically imports the package's capnp_deno.wasm; the
    // fake-WASM test fixtures upstream do not advertise these capabilities.
    const capabilities = handle.runtime.peer.abi.capabilities;
    check(
      capabilities.abiVersion === 1,
      `unexpected WASM ABI version: ${capabilities.abiVersion}`,
    );
    check(
      capabilities.hasHostCallBridge === true,
      "WASM peer is missing the host-call bridge capability",
    );
    check(
      capabilities.hasHostCallReturnFrame === true,
      "WASM peer is missing the host-call return-frame capability",
    );
    check(
      capabilities.hasLifecycleHelpers === true,
      "WASM peer is missing the lifecycle helper capability",
    );

    wireClient = new RpcWireClient(clientTransport, {
      defaultTimeoutMs: CALL_TIMEOUT_MS,
    });
    const client = await CodegenProbe.bootstrapClient(wireClient, {
      timeoutMs: CALL_TIMEOUT_MS,
    });

    // Unary round-trip with a random nonce.
    const nonceBytes = new BigUint64Array(1);
    crypto.getRandomValues(nonceBytes);
    const nonce = nonceBytes[0];
    const echoed = await client.ping(nonce, { timeoutMs: CALL_TIMEOUT_MS });
    check(
      echoed.nonce === nonce,
      `unary nonce mismatch: sent ${nonce}, got ${echoed.nonce}`,
    );
    check(
      echoed.acceptedChunks === 0n,
      `expected zero accepted chunks pre-stream, got ${echoed.acceptedChunks}`,
    );

    // Bounded application stream.
    const sender = createCodegenProbeChunkStreamSender(client, {
      maxInFlight: STREAM_WINDOW,
      call: { timeoutMs: CALL_TIMEOUT_MS },
    });
    for (let index = 0; index < STREAM_COUNT; index++) {
      await sender.send({
        sequence: BigInt(index),
        data: chunkPayload(BigInt(index)),
      });
      check(
        sender.inFlight <= STREAM_WINDOW,
        `stream sender exceeded its ${STREAM_WINDOW}-call window (inFlight=${sender.inFlight})`,
      );
    }
    await sender.flush();
    check(
      sender.inFlight === 0,
      `stream sender still has ${sender.inFlight} calls in flight after flush`,
    );
    check(
      sender.totalSent === STREAM_COUNT,
      `stream sender sent ${sender.totalSent} items, expected ${STREAM_COUNT}`,
    );
    check(
      sender.totalReceived === STREAM_COUNT,
      `stream sender received ${sender.totalReceived} acks, expected ${STREAM_COUNT}`,
    );
    check(
      chunkErrors.length === 0,
      `server rejected stream chunks: ${chunkErrors.join("; ")}`,
    );

    // Post-stream unary observes the server-side stream effects.
    const final = await client.ping(nonce + 1n, {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    check(
      final.acceptedChunks === BigInt(STREAM_COUNT),
      `server accepted ${final.acceptedChunks} chunks, expected ${STREAM_COUNT}`,
    );

    console.log(
      `PROBE_OK deno=${Deno.version.deno} target=${Deno.build.target} ` +
        `unary=2 streamChunks=${STREAM_COUNT} streamBytes=${
          STREAM_COUNT * CHUNK_BYTES
        } window=${STREAM_WINDOW}`,
    );
  } finally {
    await wireClient?.close().catch(() => {});
    await handle.close().catch(() => {});
    await serverTransport.close().catch(() => {});
    await clientTransport.close().catch(() => {});
  }
}

const watchdog = setTimeout(() => {
  console.error(`PROBE_FAIL watchdog fired after ${WATCHDOG_MS}ms`);
  Deno.exit(3);
}, WATCHDOG_MS);

try {
  await main();
  clearTimeout(watchdog);
  Deno.exit(0);
} catch (error) {
  clearTimeout(watchdog);
  console.error("PROBE_FAIL", error);
  Deno.exit(1);
}
