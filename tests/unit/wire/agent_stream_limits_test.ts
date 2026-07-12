// src/agent/service.ts — inbound `-> stream` chunk-limit enforcement and
// tally consistency, driven through the GENERATED low-level dispatches
// with a fake capability-export context (the same harness shape as
// agent_service_test.ts). These pin the security + correctness fixes:
//
//  1. An inbound chunk larger than the negotiated
//     `TransportLimits.maxChunkBytes` is rejected with a typed
//     `SBX_AGENT_VALIDATION` error BEFORE any buffering/write, so it
//     commits no partial data (Process.writeStdin and Upload.chunk).
//  2. A ByteSink (`Upload`) commit whose SHA-256 does not match the
//     received bytes rejects, and the half-written file is discarded
//     (never visible on disk).
//  3. A mid-stream write failure leaves the StreamTally consistent: the
//     failed chunk advances neither the sequence nor the hash/byte/chunk
//     accounting, so a retry lands and the final TransferCommit verifies.

import { assert, assertEquals, assertExists } from "@std/assert";

import type {
  AgentApi,
  AgentDenoRuntime,
  AgentEnvironment,
  AgentFileSystem,
  AgentProcess,
} from "../../../src/agent/api.ts";
import { AgentError } from "../../../src/agent/api.ts";
import { AgentFs } from "../../../src/agent/fs.ts";
import {
  createAgentWireConnection,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../../../src/agent/service.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";
import { Sha256 } from "../../../src/agent/sha256.ts";
import * as wire from "../../../src/wire/generated/sandbox_agent_types.ts";
import type { RpcCallContext } from "@nullstyle/capnp/rpc";

type GeneratedDispatch = wire.RpcServerDispatch;

const CREDENTIAL = new Uint8Array(32).fill(7);
const IDENTITY = m3AgentContractIdentity("studioboxd/stream-limits-test");
const MAX_CHUNK = DEFAULT_TRANSPORT_LIMITS.maxChunkBytes;

// ---------------------------------------------------------------------------
// Fake capability-export context + dispatch helpers
// ---------------------------------------------------------------------------

interface FakeContext {
  readonly ctx: RpcCallContext;
  readonly exports: Map<number, GeneratedDispatch>;
}

function fakeContext(): FakeContext {
  const exports = new Map<number, GeneratedDispatch>();
  let next = 1;
  const ctx: RpcCallContext = {
    capability: { capabilityIndex: 0 },
    methodId: 0,
    signal: new AbortController().signal,
    exportCapability: (dispatch) => {
      const capabilityIndex = next++;
      exports.set(capabilityIndex, dispatch);
      return { capabilityIndex };
    },
  };
  return { ctx, exports };
}

async function callDispatch<T>(
  fake: FakeContext,
  dispatch: GeneratedDispatch,
  methodId: number,
  params: Uint8Array,
  decode: (content: Uint8Array, capTable: unknown[]) => T,
): Promise<T> {
  const raw = await dispatch.dispatch(methodId, params, fake.ctx);
  if (raw instanceof Uint8Array) return decode(raw, []);
  return decode(raw.content, raw.capTable ?? []);
}

function capabilityDispatch(
  fake: FakeContext,
  stub: unknown,
): GeneratedDispatch {
  const pointer = stub as { capabilityIndex: number };
  const dispatch = fake.exports.get(pointer.capabilityIndex);
  assertExists(dispatch);
  return dispatch;
}

/**
 * Assert that `op` rejects with a typed {@linkcode AgentError} of `code`.
 * The generated `-> stream` server wrapper re-throws handler faults as a
 * `SessionError` carrying the original as `.cause`, so a thrown
 * `AgentError` surfaces either directly or one `.cause` hop down.
 */
async function expectAgentErrorRejection(
  op: () => Promise<unknown>,
  code: AgentError["code"],
): Promise<AgentError> {
  const thrown = await op().then(() => null, (error: unknown) => error);
  assert(thrown !== null, "expected the call to reject");
  const cause = thrown instanceof AgentError
    ? thrown
    : (thrown as { cause?: unknown }).cause;
  assert(
    cause instanceof AgentError,
    `expected an AgentError, got ${String(thrown)}`,
  );
  assertEquals(cause.code, code);
  return cause;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeProcess {
  readonly process: AgentProcess;
  /** Bytes actually accepted by `writeStdin` (post-failure filter). */
  readonly writes: Uint8Array[];
}

function fakeProcess(failOnCall?: number): FakeProcess {
  const writes: Uint8Array[] = [];
  let call = 0;
  let failed = false;
  const process: AgentProcess = {
    pid: 1,
    stdout: null,
    stderr: null,
    status: Promise.resolve({
      code: 0,
      signal: null,
      signaled: false,
      oom: false,
    }),
    kill: () => Promise.resolve(),
    writeStdin(data) {
      const index = call++;
      // Fail exactly once at the configured call so a retry can land.
      if (failOnCall !== undefined && index === failOnCall && !failed) {
        failed = true;
        return Promise.reject(
          new AgentError("SBX_AGENT_STATE", "simulated stdin write failure"),
        );
      }
      writes.push(data.slice());
      return Promise.resolve();
    },
    closeStdin: () => Promise.resolve(),
  };
  return { process, writes };
}

function fakeApi(overrides: {
  process?: AgentProcess;
  fs?: AgentFileSystem;
}): AgentApi {
  return {
    processes: {
      spawn: () => Promise.resolve(overrides.process ?? fakeProcess().process),
    },
    fs: overrides.fs ?? ({} as AgentFileSystem),
    env: {} as AgentEnvironment,
    deno: {} as AgentDenoRuntime,
    info: () => Promise.reject(new Error("not under test")),
    ping: (nonce) => Promise.resolve(nonce),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap to the authenticated SandboxAgent dispatch
// ---------------------------------------------------------------------------

async function authenticatedAgent(
  api: AgentApi,
  fake: FakeContext,
): Promise<{
  connection: ReturnType<typeof createAgentWireConnection>;
  agentDispatch: GeneratedDispatch;
}> {
  const connection = createAgentWireConnection({
    api,
    identity: IDENTITY,
    credential: CREDENTIAL,
  });
  const negotiated = await connection.bootstrap.negotiate({
    offer: {
      identity: identityToWire(IDENTITY),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: 0n,
    },
  }, fake.ctx);
  assertEquals(negotiated.result.which, "accepted");
  const auth = await connection.bootstrap.authenticate({
    credential: CREDENTIAL,
    sandboxId: "sbx-test",
    bootNonce: new Uint8Array(32),
  }, fake.ctx);
  assertEquals(auth.result.which, "accepted");
  const { agent } = await connection.bootstrap.agent({}, fake.ctx);
  return { connection, agentDispatch: capabilityDispatch(fake, agent) };
}

async function spawnProcessDispatch(
  fake: FakeContext,
  agentDispatch: GeneratedDispatch,
): Promise<GeneratedDispatch> {
  const processes = await callDispatch(
    fake,
    agentDispatch,
    wire.SandboxAgentMethodOrdinals.processes,
    wire.encodeStructMessage(wire.ProcessesParamsStruct, {}),
    (content, capTable) =>
      wire.decodeStructMessageWithCaps(
        wire.ProcessesResultsStruct,
        content,
        capTable as never[],
      ) as wire.ProcessesResults,
  );
  const spawnerDispatch = capabilityDispatch(fake, processes.service);
  const spawn = await callDispatch(
    fake,
    spawnerDispatch,
    wire.ProcessSpawnerMethodOrdinals.spawn,
    wire.encodeStructMessageWithCaps(wire.SpawnParamsStruct, {
      spec: {
        command: "/bin/cat",
        args: [],
        cwd: "",
        env: [],
        stdin: "piped",
        stdout: "discard",
        stderr: "discard",
      },
      output: null,
    }).content,
    (content, capTable) =>
      wire.decodeStructMessageWithCaps(
        wire.SpawnResultsStruct,
        content,
        capTable as never[],
      ) as wire.SpawnResults,
  );
  assertEquals(spawn.result.which, "process", spawn.result.error?.message);
  return capabilityDispatch(fake, spawn.result.process);
}

async function writeStdin(
  fake: FakeContext,
  processDispatch: GeneratedDispatch,
  sequence: bigint,
  data: Uint8Array,
): Promise<void> {
  await processDispatch.dispatch(
    wire.ProcessMethodOrdinals.writeStdin,
    wire.encodeStructMessage(wire.WriteStdinParamsStruct, { sequence, data }),
    fake.ctx,
  );
}

function closeStdin(
  fake: FakeContext,
  processDispatch: GeneratedDispatch,
  commit: { totalBytes: bigint; chunkCount: bigint; sha256: Uint8Array },
): Promise<wire.CloseStdinResults> {
  return callDispatch(
    fake,
    processDispatch,
    wire.ProcessMethodOrdinals.closeStdin,
    wire.encodeStructMessage(wire.CloseStdinParamsStruct, { commit }),
    (content) =>
      wire.decodeStructMessage(wire.CloseStdinResultsStruct, content),
  );
}

// ---------------------------------------------------------------------------
// 1. Oversized inbound stdin chunk is rejected typed, commits nothing
// ---------------------------------------------------------------------------

Deno.test("agent stream limits: an oversized writeStdin chunk is rejected typed and writes no partial data", async () => {
  const fake = fakeContext();
  const proc = fakeProcess();
  const { connection, agentDispatch } = await authenticatedAgent(
    fakeApi({ process: proc.process }),
    fake,
  );
  const processDispatch = await spawnProcessDispatch(fake, agentDispatch);

  const oversized = new Uint8Array(MAX_CHUNK + 1).fill(0xab);
  const error = await expectAgentErrorRejection(
    () => writeStdin(fake, processDispatch, 0n, oversized),
    "SBX_AGENT_VALIDATION",
  );
  assert(
    error.message.includes("maxChunkBytes"),
    `expected a maxChunkBytes rejection, got: ${error.message}`,
  );
  // Nothing was written to the child, and the sequence never advanced —
  // the oversized frame committed no partial data.
  assertEquals(proc.writes.length, 0, "oversized chunk wrote no bytes");

  // A valid chunk still lands at sequence 0 (the rejected frame did not
  // consume the sequence), and its TransferCommit verifies — proof the
  // tally was untouched by the rejected oversized frame.
  const payload = new TextEncoder().encode("hello");
  await writeStdin(fake, processDispatch, 0n, payload);
  assertEquals(proc.writes.length, 1);
  assertEquals([...proc.writes[0]], [...payload]);

  const closed = await closeStdin(fake, processDispatch, {
    totalBytes: BigInt(payload.byteLength),
    chunkCount: 1n,
    sha256: new Sha256().update(payload).digest(),
  });
  assertEquals(closed.result.which, "receipt", closed.result.error?.message);
  assertEquals(closed.result.receipt?.totalBytes, BigInt(payload.byteLength));
  assertEquals(closed.result.receipt?.chunkCount, 1n);

  await connection.close();
});

// ---------------------------------------------------------------------------
// 3. A mid-stream write failure leaves the tally consistent
// ---------------------------------------------------------------------------

Deno.test("agent stream limits: a mid-stream writeStdin failure leaves the tally consistent and retryable", async () => {
  const fake = fakeContext();
  // Fail the SECOND writeStdin (call index 1) exactly once.
  const proc = fakeProcess(1);
  const { connection, agentDispatch } = await authenticatedAgent(
    fakeApi({ process: proc.process }),
    fake,
  );
  const processDispatch = await spawnProcessDispatch(fake, agentDispatch);

  const chunk0 = new TextEncoder().encode("alpha");
  const chunk1 = new TextEncoder().encode("bravo");

  await writeStdin(fake, processDispatch, 0n, chunk0);
  assertEquals(proc.writes.length, 1);

  // The write of chunk 1 fails downstream; the handler propagates the
  // typed error and must NOT have advanced the tally.
  await expectAgentErrorRejection(
    () => writeStdin(fake, processDispatch, 1n, chunk1),
    "SBX_AGENT_STATE",
  );
  assertEquals(proc.writes.length, 1, "the failed chunk wrote nothing");

  // Because the failed write neither advanced the sequence nor the
  // accounting, chunk 1 is retryable at the same sequence and lands.
  await writeStdin(fake, processDispatch, 1n, chunk1);
  assertEquals(proc.writes.length, 2);

  // The commit for exactly the two delivered chunks verifies: the failed
  // attempt was not double-counted in bytes, chunks, or the hash.
  const both = new Uint8Array(chunk0.byteLength + chunk1.byteLength);
  both.set(chunk0, 0);
  both.set(chunk1, chunk0.byteLength);
  const closed = await closeStdin(fake, processDispatch, {
    totalBytes: BigInt(both.byteLength),
    chunkCount: 2n,
    sha256: new Sha256().update(both).digest(),
  });
  assertEquals(closed.result.which, "receipt", closed.result.error?.message);
  assertEquals(closed.result.receipt?.totalBytes, BigInt(both.byteLength));
  assertEquals(closed.result.receipt?.chunkCount, 2n);

  await connection.close();
});

// ---------------------------------------------------------------------------
// Upload (ByteSink) chunk-limit + commit verification over a real fs
// ---------------------------------------------------------------------------

interface UploadHarness extends AsyncDisposable {
  readonly root: string;
  readonly fs: AgentFs;
  readonly connection: ReturnType<typeof createAgentWireConnection>;
  readonly fake: FakeContext;
  readonly fsDispatch: GeneratedDispatch;
}

async function uploadHarness(): Promise<UploadHarness> {
  const root = await Deno.makeTempDir({ prefix: "sbx-stream-limits-" });
  await Deno.mkdir(`${root}/home/app`, { recursive: true });
  const fs = new AgentFs({ root });
  const fake = fakeContext();
  const { connection, agentDispatch } = await authenticatedAgent(
    fakeApi({ fs }),
    fake,
  );
  const filesystem = await callDispatch(
    fake,
    agentDispatch,
    wire.SandboxAgentMethodOrdinals.filesystem,
    wire.encodeStructMessage(wire.FilesystemParamsStruct, {}),
    (content, capTable) =>
      wire.decodeStructMessageWithCaps(
        wire.FilesystemResultsStruct,
        content,
        capTable as never[],
      ) as wire.FilesystemResults,
  );
  const fsDispatch = capabilityDispatch(fake, filesystem.service);
  return {
    root,
    fs,
    connection,
    fake,
    fsDispatch,
    async [Symbol.asyncDispose]() {
      await connection.close();
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

async function beginUploadDispatch(
  harness: UploadHarness,
  path: string,
): Promise<GeneratedDispatch> {
  const begin = await callDispatch(
    harness.fake,
    harness.fsDispatch,
    wire.FileSystemMethodOrdinals.beginUpload,
    wire.encodeStructMessage(wire.BeginUploadParamsStruct, {
      path,
      mode: 0o644,
    }),
    (content, capTable) =>
      wire.decodeStructMessageWithCaps(
        wire.BeginUploadResultsStruct,
        content,
        capTable as never[],
      ) as wire.BeginUploadResults,
  );
  assertEquals(begin.result.which, "upload", begin.result.error?.message);
  return capabilityDispatch(harness.fake, begin.result.upload);
}

async function uploadChunk(
  harness: UploadHarness,
  uploadDispatch: GeneratedDispatch,
  sequence: bigint,
  data: Uint8Array,
): Promise<void> {
  await uploadDispatch.dispatch(
    wire.UploadMethodOrdinals.chunk,
    wire.encodeStructMessage(wire.ChunkParams2Struct, { sequence, data }),
    harness.fake.ctx,
  );
}

function uploadFinish(
  harness: UploadHarness,
  uploadDispatch: GeneratedDispatch,
  commit: { totalBytes: bigint; chunkCount: bigint; sha256: Uint8Array },
): Promise<wire.FinishResults2> {
  return callDispatch(
    harness.fake,
    uploadDispatch,
    wire.UploadMethodOrdinals.finish,
    wire.encodeStructMessage(wire.FinishParams2Struct, { commit }),
    (content) => wire.decodeStructMessage(wire.FinishResults2Struct, content),
  );
}

async function fileVisible(
  root: string,
  sandboxPath: string,
): Promise<boolean> {
  return await Deno.lstat(`${root}${sandboxPath}`).then(
    () => true,
    () => false,
  );
}

// ---------------------------------------------------------------------------
// 1b. Oversized Upload chunk is rejected typed, commits nothing
// ---------------------------------------------------------------------------

Deno.test("agent stream limits: an oversized Upload.chunk is rejected typed and no file becomes visible", async () => {
  await using harness = await uploadHarness();
  const uploadDispatch = await beginUploadDispatch(
    harness,
    "/home/app/oversized.bin",
  );

  const oversized = new Uint8Array(MAX_CHUNK + 1).fill(0x5a);
  const error = await expectAgentErrorRejection(
    () => uploadChunk(harness, uploadDispatch, 0n, oversized),
    "SBX_AGENT_VALIDATION",
  );
  assert(
    error.message.includes("maxChunkBytes"),
    `expected a maxChunkBytes rejection, got: ${error.message}`,
  );

  // The upload never committed; a mismatched-size commit that claims the
  // oversized bytes is rejected and the half-open file is discarded.
  const finish = await uploadFinish(harness, uploadDispatch, {
    totalBytes: BigInt(oversized.byteLength),
    chunkCount: 1n,
    sha256: new Sha256().update(oversized).digest(),
  });
  assertEquals(finish.result.which, "error");
  assertEquals(finish.result.error?.code, "invalidArgument");
  assertEquals(
    await fileVisible(harness.root, "/home/app/oversized.bin"),
    false,
    "the discarded upload left no visible file",
  );
});

// ---------------------------------------------------------------------------
// 2. A wrong-SHA-256 ByteSink commit rejects and discards the file
// ---------------------------------------------------------------------------

Deno.test("agent stream limits: an Upload commit with a wrong SHA-256 rejects and the file is not visible", async () => {
  await using harness = await uploadHarness();
  const uploadDispatch = await beginUploadDispatch(
    harness,
    "/home/app/wrongsha.bin",
  );

  const payload = new TextEncoder().encode("the quick brown fox");
  await uploadChunk(harness, uploadDispatch, 0n, payload);

  // Correct totalBytes and chunkCount, but a bogus SHA-256: the commit
  // must reject and the written body must be discarded, not published.
  const finish = await uploadFinish(harness, uploadDispatch, {
    totalBytes: BigInt(payload.byteLength),
    chunkCount: 1n,
    sha256: new Uint8Array(32),
  });
  assertEquals(finish.result.which, "error");
  assertEquals(finish.result.error?.code, "invalidArgument");
  assert(
    (finish.result.error?.message ?? "").includes("sha256"),
    `expected a sha256 mismatch, got: ${finish.result.error?.message}`,
  );
  assertEquals(
    await fileVisible(harness.root, "/home/app/wrongsha.bin"),
    false,
    "a rejected commit leaves no visible file",
  );
});

// ---------------------------------------------------------------------------
// Positive control: a well-formed Upload still commits and publishes
// ---------------------------------------------------------------------------

Deno.test("agent stream limits: a well-formed Upload commit publishes the file (positive control)", async () => {
  await using harness = await uploadHarness();
  const uploadDispatch = await beginUploadDispatch(
    harness,
    "/home/app/good.bin",
  );

  const payload = new TextEncoder().encode("payload bytes that land");
  await uploadChunk(harness, uploadDispatch, 0n, payload);
  const finish = await uploadFinish(harness, uploadDispatch, {
    totalBytes: BigInt(payload.byteLength),
    chunkCount: 1n,
    sha256: new Sha256().update(payload).digest(),
  });
  assertEquals(finish.result.which, "receipt", finish.result.error?.message);
  assertEquals(finish.result.receipt?.totalBytes, BigInt(payload.byteLength));
  assertEquals(
    await fileVisible(harness.root, "/home/app/good.bin"),
    true,
    "a verified commit publishes the file",
  );
  const landed = await Deno.readFile(`${harness.root}/home/app/good.bin`);
  assertEquals([...landed], [...payload]);
});
