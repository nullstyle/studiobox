/**
 * studioboxd (src/agent/main.ts) over a real UDS, speaking its REAL
 * protocol: boots the entrypoint as a subprocess with
 * `--root`/`--socket`/`--token-file`, connects with the GENERATED
 * `sandbox_agent.capnp` clients over `TcpTransport` + `RpcWireClient`
 * (onClose wired per the M1 close-ownership contract), performs the
 * fail-closed negotiate -> authenticate -> agent bootstrap, and drives:
 *
 * - spawn with stdout streamed through a client-hosted
 *   `streams.capnp` `OutputSink` (chunk sizes bounded by the
 *   negotiated `maxChunkBytes`, dense sequences, exact bytes, and a
 *   verified SHA-256 `TransferCommit`);
 * - stdin round-trip through the sequenced `writeStdin -> stream`
 *   flow with `closeStdin(TransferCommit)` verification (including a
 *   rejected mismatched commit);
 * - kill -> 128+n exit status;
 * - a 2 MiB file body up through `Upload` (`ByteSink` semantics) and
 *   back through `ByteReader`, with commit/receipt hash verification;
 * - env set/get/missing;
 * - `DenoRuntime.openRepl` state across two snippets;
 * - clean teardown with no hang, and SIGTERM shutdown (socket file
 *   removed, exit 0).
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";

import { decodeReplValue } from "../../../src/agent/deno_runtime_codec.ts";
import {
  AGENT_PLANE_FEATURES,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../../../src/agent/service.ts";
import { Sha256 } from "../../../src/agent/sha256.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";
import * as wire from "../../../src/wire/generated/sandbox_agent_types.ts";
import type * as wireCommon from "../../../src/wire/generated/common_types.ts";
import * as wireStreams from "../../../src/wire/generated/streams_types.ts";

const MAIN_TS = fromFileUrl(
  new URL("../../../src/agent/main.ts", import.meta.url),
);

const CALL_TIMEOUT_MS = 20_000;
const KIB = 1024;
const MIB = 1024 * 1024;

/**
 * Options for calls whose RESULTS carry a fresh capability. The agent
 * exports result capabilities wire-managed (their only wire reference
 * is the one the Return frame mints), so the client must finish these
 * questions with `releaseResultCaps: false` to retain the capability —
 * `RpcWireClient.finish` defaults to eager release, which would drop
 * the export before its first use. Stub `close()` (or `await using`)
 * releases the retained reference. Capability-free calls keep the
 * default options: an eager-release finish with no result caps is a
 * no-op.
 */
const CAP_CALL = {
  timeoutMs: CALL_TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
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

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Client-hosted OutputSink (the agent pumps process output INTO this)
// ---------------------------------------------------------------------------

interface SinkChannel {
  chunks: Uint8Array[];
  nextSequence: bigint;
  maxChunkBytes: number;
  done: Deferred<wireStreams.TransferCommit>;
}

class SinkCollector implements wireStreams.OutputSinkService {
  readonly #channels = new Map<wireStreams.OutputChannel, SinkChannel>();

  #channel(name: wireStreams.OutputChannel): SinkChannel {
    let channel = this.#channels.get(name);
    if (channel === undefined) {
      channel = {
        chunks: [],
        nextSequence: 0n,
        maxChunkBytes: 0,
        done: deferred<wireStreams.TransferCommit>(),
      };
      this.#channels.set(name, channel);
    }
    return channel;
  }

  chunk(params: wireStreams.ChunkParams2): void {
    const channel = this.#channel(params.channel);
    assertEquals(
      params.sequence,
      channel.nextSequence,
      `${params.channel}: dense sequence contract`,
    );
    channel.nextSequence += 1n;
    channel.maxChunkBytes = Math.max(
      channel.maxChunkBytes,
      params.data.byteLength,
    );
    channel.chunks.push(params.data.slice());
  }

  finish(params: wireStreams.FinishParams2): wireStreams.FinishResult {
    const channel = this.#channel(params.channel);
    const hash = new Sha256();
    let totalBytes = 0n;
    for (const chunk of channel.chunks) {
      hash.update(chunk);
      totalBytes += BigInt(chunk.byteLength);
    }
    channel.done.resolve(params.commit);
    return {
      which: "receipt",
      receipt: {
        totalBytes,
        chunkCount: BigInt(channel.chunks.length),
        sha256: hash.digest(),
      },
    };
  }

  fail(params: wireStreams.FailParams): wireCommon.EmptyResult {
    this.#channel(params.channel).done.reject(
      new Error(`${params.channel} pump failed: ${params.error.message}`),
    );
    return { which: "ok", ok: {} };
  }

  /** Resolves with the agent's commit once `finish` arrives. */
  commit(
    name: wireStreams.OutputChannel,
  ): Promise<wireStreams.TransferCommit> {
    return this.#channel(name).done.promise;
  }

  bytes(name: wireStreams.OutputChannel): Uint8Array {
    return concatBytes(this.#channel(name).chunks);
  }

  chunkCount(name: wireStreams.OutputChannel): number {
    return this.#channel(name).chunks.length;
  }

  maxChunkBytes(name: wireStreams.OutputChannel): number {
    return this.#channel(name).maxChunkBytes;
  }
}

// ---------------------------------------------------------------------------
// Agent process + connection scaffolding
// ---------------------------------------------------------------------------

interface RunningAgentd extends AsyncDisposable {
  readonly child: Deno.ChildProcess;
  readonly socket: string;
  readonly root: string;
  readonly credential: Uint8Array;
}

async function startAgentd(): Promise<RunningAgentd> {
  const root = await Deno.makeTempDir({ prefix: "sbx-agentd-" });
  await Deno.mkdir(`${root}/home/app`, { recursive: true });
  const socketDir = await Deno.makeTempDir({ prefix: "sbxd-" });
  const socket = `${socketDir}/a.sock`;
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const tokenFile = `${root}/token.hex`;
  await Deno.writeTextFile(tokenFile, toHex(credential));

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-q",
      "-A",
      MAIN_TS,
      "--root",
      root,
      "--socket",
      socket,
      "--token-file",
      tokenFile,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  // Wait for the ready line.
  const reader = child.stdout.getReader();
  let readyText = "";
  const decoder = new TextDecoder();
  while (!readyText.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("studioboxd exited before its ready line");
    readyText += decoder.decode(value, { stream: true });
  }
  const ready = JSON.parse(readyText.slice(0, readyText.indexOf("\n"))) as {
    studioboxd: { socket: string; pid: number; buildId: string; plane: string };
  };
  assertEquals(ready.studioboxd.socket, socket);
  assertEquals(ready.studioboxd.plane, "capnp");
  // Drain any further stdout so the child never blocks on a full pipe.
  const drained = (async () => {
    while (!(await reader.read()).done) {
      // discard
    }
  })().catch(() => {});

  return {
    child,
    socket,
    root,
    credential,
    async [Symbol.asyncDispose]() {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await child.status;
      await drained;
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(socketDir, { recursive: true }).catch(() => {});
    },
  };
}

interface AgentSession extends AsyncDisposable {
  readonly wireClient: RpcWireClient;
  readonly agent: RpcStub<wire.SandboxAgent>;
}

/** Dial, run the fail-closed bootstrap, and return the agent plane. */
async function connectAgent(agentd: RunningAgentd): Promise<AgentSession> {
  const conn = await Deno.connect({ transport: "unix", path: agentd.socket });
  let wireClient: RpcWireClient | null = null;
  // Close-ownership contract: the transport observes EOF; the owner
  // closes the wire client. onError is wired so out-of-band conn
  // destruction never escapes as a global unhandled rejection.
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: CALL_TIMEOUT_MS,
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => {},
  });
  wireClient = new RpcWireClient(transport, {
    defaultTimeoutMs: CALL_TIMEOUT_MS,
  });
  const client = wireClient;
  try {
    const bootstrap = await wire.AgentBootstrap.bootstrapClient(client, {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    const handshake = await bootstrap.negotiate({
      identity: identityToWire(
        m3AgentContractIdentity("studiobox/agent-wire-test"),
      ),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(handshake.which, "accepted", handshake.error?.message);
    const auth = await bootstrap.authenticate({
      credential: agentd.credential,
      sandboxId: "sbx-agent-wire-test",
      bootNonce: new Uint8Array(32),
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(auth.which, "accepted", auth.error?.message);
    const agent = await bootstrap.agent(CAP_CALL);
    return {
      wireClient: client,
      agent,
      async [Symbol.asyncDispose]() {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
}

/**
 * Export a client-hosted OutputSink for `spawn`'s `output` param.
 *
 * referenceCount 2 pins the export past the WASM relay's post-call
 * release: the agent RETAINS the sink param cap to pump stdout/stderr
 * after `spawn` returns, but the relay drops its only param-cap import
 * (one Release frame) as soon as the host call completes — the ABI has
 * no way for the host to signal retention yet. One reference absorbs
 * that Release; the standing one keeps the sink alive for the pumps
 * (the connection teardown reclaims it).
 */
function registerSink(
  wireClient: RpcWireClient,
  sink: SinkCollector,
): RpcStub<wireStreams.OutputSink> {
  return wireStreams.OutputSink.registerServer(wireClient, sink, {
    referenceCount: 2,
  }) as unknown as RpcStub<wireStreams.OutputSink>;
}

function spec(overrides: Partial<wire.SpawnSpec>): wire.SpawnSpec {
  return {
    command: "",
    args: [],
    cwd: "",
    env: [],
    stdin: "discard",
    stdout: "piped",
    stderr: "piped",
    ...overrides,
  };
}

function requireProcess(result: wire.SpawnResult): RpcStub<wire.Process> {
  assertEquals(result.which, "process", result.error?.message);
  assertExists(result.process);
  return result.process;
}

// ---------------------------------------------------------------------------
// The end-to-end plane drive
// ---------------------------------------------------------------------------

Deno.test("studioboxd serves the capnp agent plane over UDS end to end", async () => {
  await using agentd = await startAgentd();
  await using session = await connectAgent(agentd);
  const { agent, wireClient } = session;

  // ping echoes the full UInt64 range.
  assertEquals(
    await agent.ping(18446744073709551615n, { timeoutMs: CALL_TIMEOUT_MS }),
    18446744073709551615n,
  );

  const spawner = await agent.processes(CAP_CALL);
  const fs = await agent.filesystem(CAP_CALL);
  const env = await agent.environment(CAP_CALL);
  const deno = await agent.deno(CAP_CALL);

  // -- spawn: 256 KiB of stdout streamed through the OutputSink -----------
  {
    const sink = new SinkCollector();
    const process = requireProcess(
      await spawner.spawn({
        spec: spec({
          command: "/bin/bash",
          args: ["-c", `head -c ${256 * KIB} /dev/zero | tr '\\0' 'x'`],
        }),
        output: registerSink(wireClient, sink),
      }, CAP_CALL),
    );

    const commit = await withTimeout(
      sink.commit("stdout"),
      CALL_TIMEOUT_MS,
      "stdout finish",
    );
    const bytes = sink.bytes("stdout");
    assertEquals(bytes.byteLength, 256 * KIB, "exact stdout byte count");
    assert(
      bytes.every((byte) => byte === 0x78),
      "exact stdout bytes ('x' fill)",
    );
    // Bounded streaming: every chunk respects the negotiated
    // maxChunkBytes and the body crossed in multiple chunks (the
    // sender-side window itself is pinned by the unit streaming soak).
    assert(
      sink.maxChunkBytes("stdout") <= DEFAULT_TRANSPORT_LIMITS.maxChunkBytes,
      `chunk of ${
        sink.maxChunkBytes("stdout")
      } bytes exceeds the negotiated maxChunkBytes`,
    );
    assert(sink.chunkCount("stdout") >= 4, "body crossed in multiple chunks");
    assertEquals(commit.totalBytes, BigInt(256 * KIB));
    assertEquals(commit.chunkCount, BigInt(sink.chunkCount("stdout")));
    assertEquals(
      toHex(commit.sha256),
      toHex(new Sha256().update(bytes).digest()),
      "TransferCommit sha256 matches the received bytes",
    );
    // The discarded... nothing was written to stderr: empty commit.
    const stderrCommit = await withTimeout(
      sink.commit("stderr"),
      CALL_TIMEOUT_MS,
      "stderr finish",
    );
    assertEquals(stderrCommit.totalBytes, 0n);

    const status = await process.wait({ timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(status.which, "status");
    assertEquals(status.status?.code, 0);
    assertEquals((await process.release()).which, "ok");
    await process.close();
  }

  // -- stdin round-trip with TransferCommit verification ------------------
  {
    const sink = new SinkCollector();
    const process = requireProcess(
      await spawner.spawn({
        spec: spec({ command: "/bin/cat", stdin: "piped" }),
        output: registerSink(wireClient, sink),
      }, CAP_CALL),
    );
    const parts = [
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("wire\n"),
    ];
    const payload = concatBytes(parts);
    await process.writeStdin({ sequence: 0n, data: parts[0] });
    await process.writeStdin({ sequence: 1n, data: parts[1] });

    // A mismatched commit is rejected and leaves stdin open.
    const mismatch = await process.closeStdin({
      totalBytes: BigInt(payload.byteLength),
      chunkCount: 2n,
      sha256: new Uint8Array(32),
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(mismatch.which, "error");
    assertEquals(mismatch.error?.code, "invalidArgument");

    const receipt = await process.closeStdin({
      totalBytes: BigInt(payload.byteLength),
      chunkCount: 2n,
      sha256: new Sha256().update(payload).digest(),
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(receipt.which, "receipt", receipt.error?.message);
    assertEquals(receipt.receipt?.totalBytes, BigInt(payload.byteLength));

    const commit = await withTimeout(
      sink.commit("stdout"),
      CALL_TIMEOUT_MS,
      "cat stdout finish",
    );
    assertEquals(commit.totalBytes, BigInt(payload.byteLength));
    assertEquals(
      new TextDecoder().decode(sink.bytes("stdout")),
      "hello wire\n",
    );
    const status = await process.wait({ timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(status.status?.code, 0);
    await process.close();
  }

  // -- kill -> 128+n -------------------------------------------------------
  {
    const process = requireProcess(
      await spawner.spawn({
        spec: spec({
          command: "/bin/sleep",
          args: ["5"],
          stdout: "discard",
          stderr: "discard",
        }),
        output: null,
      }, CAP_CALL),
    );
    const running = await process.status({ timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(running.which, "status");
    assertEquals(running.status?.running, true);
    assertEquals((await process.signal("sigterm")).which, "ok");
    const status = await process.wait({ timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(status.which, "status");
    assertEquals(status.status?.running, false);
    assertEquals(status.status?.code, 143, "SIGTERM exits 128+15");
    assertEquals(status.status?.signaled, true);
    assertEquals(status.status?.signal, "sigterm");
    await process.close();
  }

  // -- fs: 2 MiB body through Upload (ByteSink) and ByteReader -------------
  {
    const payload = deterministicBytes(2 * MIB, 0xb10b);
    const payloadSha = new Sha256().update(payload).digest();
    const chunkBytes = 64 * KIB;

    const uploadResult = await fs.beginUpload({
      path: "/home/app/blob.bin",
      mode: 0o644,
    }, CAP_CALL);
    assertEquals(uploadResult.which, "upload", uploadResult.error?.message);
    assertExists(uploadResult.upload);
    const upload = uploadResult.upload;

    const sender = wire.createUploadChunkStreamSender(upload, {
      maxInFlight: DEFAULT_TRANSPORT_LIMITS.maxChunksInFlight,
      call: { timeoutMs: CALL_TIMEOUT_MS },
    });
    let sequence = 0n;
    for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
      await sender.waitForCapacity();
      await sender.send({
        sequence,
        data: payload.subarray(offset, offset + chunkBytes),
      });
      sequence += 1n;
    }
    await sender.flush();
    const finish = await upload.finish({
      totalBytes: BigInt(payload.byteLength),
      chunkCount: sequence,
      sha256: payloadSha,
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(finish.which, "receipt", finish.error?.message);
    assertEquals(finish.receipt?.totalBytes, BigInt(payload.byteLength));
    assertEquals(finish.receipt?.chunkCount, sequence);
    assertEquals(
      toHex(finish.receipt?.sha256 ?? new Uint8Array()),
      toHex(payloadSha),
    );
    await upload.close();

    // The body landed as a real in-sandbox file.
    const stat = await fs.stat("/home/app/blob.bin", {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    assertEquals(stat.which, "info");
    assertEquals(stat.info?.size, BigInt(payload.byteLength));
    assertEquals(stat.info?.kind, "regular");

    const downloadResult = await fs.beginDownload(
      "/home/app/blob.bin",
      CAP_CALL,
    );
    assertEquals(downloadResult.which, "reader", downloadResult.error?.message);
    assertExists(downloadResult.reader);
    const reader = downloadResult.reader;
    const received: Uint8Array[] = [];
    let end: wireStreams.TransferReceipt | null = null;
    let expectedSequence = 0n;
    while (end === null) {
      const result = await reader.read(chunkBytes, {
        timeoutMs: CALL_TIMEOUT_MS,
      });
      if (result.which === "chunk") {
        assertExists(result.chunk);
        assertEquals(result.chunk.sequence, expectedSequence);
        expectedSequence += 1n;
        received.push(result.chunk.data.slice());
        continue;
      }
      assertEquals(result.which, "end", result.error?.message);
      assertExists(result.end);
      end = result.end;
    }
    const downloaded = concatBytes(received);
    assertEquals(downloaded.byteLength, payload.byteLength);
    assertEquals(
      toHex(new Sha256().update(downloaded).digest()),
      toHex(payloadSha),
      "downloaded bytes match the uploaded body",
    );
    assertEquals(end.totalBytes, BigInt(payload.byteLength));
    assertEquals(toHex(end.sha256), toHex(payloadSha));
    await reader.close();
  }

  // -- env ------------------------------------------------------------------
  {
    assertEquals(
      (await env.set({ key: "AGENT_WIRE_TEST", value: "on" }, {
        timeoutMs: CALL_TIMEOUT_MS,
      })).which,
      "ok",
    );
    const got = await env.get("AGENT_WIRE_TEST", {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    assertEquals(got.which, "value");
    assertEquals(got.value, "on");
    const missing = await env.get("AGENT_WIRE_TEST_MISSING", {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    assertEquals(missing.which, "missing");
  }

  // -- deno repl: state across two snippets --------------------------------
  {
    const replResult = await deno.openRepl([], CAP_CALL);
    assertEquals(replResult.which, "repl", replResult.error?.message);
    assertExists(replResult.repl);
    const repl = replResult.repl;
    const evalJson = (result: wire.EvalResult): unknown => {
      assertEquals(result.which, "json", result.error?.message);
      assertExists(result.json);
      const frame = JSON.parse(new TextDecoder().decode(result.json)) as {
        value: unknown;
      };
      return decodeReplValue(frame.value);
    };
    assertEquals(
      evalJson(
        await repl.eval("let x = 41; x", {
          timeoutMs: CALL_TIMEOUT_MS,
        }),
      ),
      41,
    );
    assertEquals(
      evalJson(await repl.eval("x + 1", { timeoutMs: CALL_TIMEOUT_MS })),
      42,
      "repl state survives across snippets",
    );
    // capnp 0.3.0 forwards schema-defined `close` methods through the
    // stub lifecycle proxy, so `repl.close()` IS wire `DenoRepl.close`;
    // the capability release stays reachable via Symbol.asyncDispose.
    assertEquals(
      (await repl.close({ timeoutMs: CALL_TIMEOUT_MS })).which,
      "ok",
      "wire DenoRepl.close tears the session down",
    );
    await repl[Symbol.asyncDispose](); // stub release (capability drop)
  }

  // -- clean close (no hang; sanitizers prove no leaked conns) -------------
  await spawner.close();
  await fs.close();
  await env.close();
  await deno.close();
  await agent.close();
});

Deno.test("studioboxd SIGTERM shutdown removes the socket and exits 0", async () => {
  const agentd = await startAgentd();
  try {
    await using session = await connectAgent(agentd);
    assertEquals(
      await session.agent.ping(1n, { timeoutMs: CALL_TIMEOUT_MS }),
      1n,
    );
    agentd.child.kill("SIGTERM");
    const status = await agentd.child.status;
    assertEquals(status.code, 0);
    // The socket file is gone after shutdown.
    const stat = await Deno.lstat(agentd.socket).then(
      () => "present",
      () => "absent",
    );
    assertEquals(stat, "absent");
  } finally {
    await agentd[Symbol.asyncDispose]();
  }
});

Deno.test("studioboxd rejects a wrong credential and keeps serving fresh conns", async () => {
  await using agentd = await startAgentd();
  // Wrong credential: authenticate returns the typed error arm.
  {
    const conn = await Deno.connect({
      transport: "unix",
      path: agentd.socket,
    });
    let wireClient: RpcWireClient | null = null;
    const transport = new TcpTransport(conn, {
      closeTimeoutMs: CALL_TIMEOUT_MS,
      onClose: () => void wireClient?.close().catch(() => {}),
      onError: () => {},
    });
    wireClient = new RpcWireClient(transport, {
      defaultTimeoutMs: CALL_TIMEOUT_MS,
    });
    try {
      const bootstrap = await wire.AgentBootstrap.bootstrapClient(wireClient, {
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const handshake = await bootstrap.negotiate({
        identity: identityToWire(
          m3AgentContractIdentity("studiobox/agent-wire-test"),
        ),
        limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
        requiredFeatureBits: AGENT_PLANE_FEATURES,
      }, { timeoutMs: CALL_TIMEOUT_MS });
      assertEquals(handshake.which, "accepted");
      const auth = await bootstrap.authenticate({
        credential: new Uint8Array(32),
        sandboxId: "sbx-agent-wire-test",
        bootNonce: new Uint8Array(32),
      }, { timeoutMs: CALL_TIMEOUT_MS });
      assertEquals(auth.which, "error");
      assertEquals(auth.error?.code, "unauthenticated");
    } finally {
      await wireClient.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  }
  // A fresh connection with the right credential still works.
  {
    await using session = await connectAgent(agentd);
    assertEquals(
      await session.agent.ping(2n, { timeoutMs: CALL_TIMEOUT_MS }),
      2n,
    );
  }
});

Deno.test(
  "studioboxd accept loop survives rapid connect-then-close peers (accept DoS)",
  async () => {
    // A peer that connects and immediately closes (zero bytes) races the
    // guest agent's `Deno.Listener.accept()` on macOS into a transient
    // `EINVAL` ("Invalid argument (os error 22)"). Before the accept loop was
    // hardened, that error propagated straight out of the `for await` async
    // iterator and KILLED the loop — the whole agent process crashed and
    // stopped serving. Hammer the listener with many such peers, then prove a
    // normal client still completes a full bootstrap + round-trip: the loop
    // (and the process) survived.
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", onRejection);
    await using agentd = await startAgentd();
    try {
      for (let i = 0; i < 60; i++) {
        const conn = await Deno.connect({
          transport: "unix",
          path: agentd.socket,
        });
        conn.close();
      }
      // Give the accept loop a beat to drain the aborted backlog.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // The agent must still be alive and serving: a full bootstrap plus a
      // ping that carries the whole UInt64 range round-trips exactly.
      await using session = await connectAgent(agentd);
      const nonce = 2n ** 63n + 5n;
      assertEquals(
        await session.agent.ping(nonce, { timeoutMs: CALL_TIMEOUT_MS }),
        nonce,
      );
      assertEquals(
        rejections.length,
        0,
        `no out-of-band close should escape as a global unhandled rejection (saw ${rejections.length})`,
      );
    } finally {
      globalThis.removeEventListener("unhandledrejection", onRejection);
    }
  },
);
