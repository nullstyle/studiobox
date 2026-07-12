// src/agent/service.ts — in-process conformance of the agent-plane
// bootstrap: fail-closed negotiate -> authenticate -> agent ordering,
// attempt-limited constant-time authentication, and the pinned wire ->
// domain mappings (StdioMode lowering, KillSignal round-trip, 128+n
// signal status) driven through the GENERATED low-level dispatches with
// a fake capability-export context. Transport-level behavior lives in
// tests/fake/agent/agent_wire_test.ts.

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";

import type {
  AgentApi,
  AgentDenoRuntime,
  AgentEnvironment,
  AgentFileSystem,
  AgentProcess,
  AgentProcessSpawner,
  AgentSpawnSpec,
} from "../../../src/agent/api.ts";
import {
  createAgentWireConnection,
  m3AgentContractIdentity,
} from "../../../src/agent/service.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";
import * as wire from "../../../src/wire/generated/sandbox_agent_types.ts";
import type * as wireCommon from "../../../src/wire/generated/common_types.ts";
import { identityToWire, limitsToWire } from "../../../src/agent/service.ts";
import type { RpcCallContext } from "@nullstyle/capnp/rpc";

// The generated dispatch contract (RpcGeneratedServerDispatch), which
// the fake context below feeds directly.
type GeneratedDispatch = wire.RpcServerDispatch;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeContext {
  readonly ctx: RpcCallContext;
  /** Dispatches exported through ctx.exportCapability, by index. */
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

function fakeProcess(): AgentProcess & { kills: string[] } {
  const kills: string[] = [];
  return {
    pid: 42,
    stdout: null,
    stderr: null,
    status: Promise.resolve({
      code: 143,
      signal: "SIGTERM",
      signaled: true,
      oom: false,
    }),
    kill(signal = "SIGTERM") {
      kills.push(signal);
      return Promise.resolve();
    },
    writeStdin() {
      return Promise.resolve();
    },
    closeStdin() {
      return Promise.resolve();
    },
    kills,
  };
}

function fakeApi(spawned: AgentSpawnSpec[]): AgentApi {
  const spawner: AgentProcessSpawner = {
    spawn(spec) {
      spawned.push(spec);
      return Promise.resolve(fakeProcess());
    },
  };
  return {
    processes: spawner,
    fs: {} as AgentFileSystem,
    env: {} as AgentEnvironment,
    deno: {} as AgentDenoRuntime,
    info: () => Promise.reject(new Error("not under test")),
    ping: (nonce) => Promise.resolve(nonce),
  };
}

const CREDENTIAL = new Uint8Array(32).fill(7);
const IDENTITY = m3AgentContractIdentity("studioboxd/test");

function connectionUnderTest(spawned: AgentSpawnSpec[] = []) {
  return createAgentWireConnection({
    api: fakeApi(spawned),
    identity: IDENTITY,
    credential: CREDENTIAL,
  });
}

function offer(): wireCommon.ProtocolOffer {
  return {
    identity: identityToWire(IDENTITY),
    limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
    requiredFeatureBits: 0n,
  };
}

function authParams(
  credential: Uint8Array = CREDENTIAL,
): wire.AuthenticateParams {
  return { credential, sandboxId: "sbx-test", bootNonce: new Uint8Array(32) };
}

async function negotiateOk(
  connection: ReturnType<typeof connectionUnderTest>,
  ctx: RpcCallContext,
): Promise<wireCommon.NegotiatedContract> {
  const { result } = await connection.bootstrap.negotiate(
    { offer: offer() },
    ctx,
  );
  assertEquals(result.which, "accepted");
  assertExists(result.accepted);
  return result.accepted;
}

// ---------------------------------------------------------------------------
// Bootstrap ordering + authentication
// ---------------------------------------------------------------------------

Deno.test("agent wire: negotiate accepts the matching M3 identity and intersects limits", async () => {
  const connection = connectionUnderTest();
  const { ctx } = fakeContext();
  const accepted = await negotiateOk(connection, ctx);
  assertEquals(connection.phase, "negotiated");
  assertEquals(accepted.selectedFeatureBits, IDENTITY.featureBits);
  assertEquals(
    accepted.limits.maxChunkBytes,
    DEFAULT_TRANSPORT_LIMITS.maxChunkBytes,
  );
  await connection.close();
});

Deno.test("agent wire: a divergent artifact identity is rejected and closes the gate", async () => {
  const connection = connectionUnderTest();
  const { ctx } = fakeContext();
  const divergent = offer();
  divergent.identity.artifactHash = new Uint8Array(32).fill(9);
  const { result } = await connection.bootstrap.negotiate(
    { offer: divergent },
    ctx,
  );
  assertEquals(result.which, "error");
  assertEquals(result.error?.code, "incompatibleRuntime");
  assertEquals(connection.phase, "closed");
  // Once closed, another negotiate fails closed instead of restarting.
  const retry = await connection.bootstrap.negotiate({ offer: offer() }, ctx);
  assertEquals(retry.result.which, "error");
  assertEquals(retry.result.error?.code, "failedPrecondition");
  await connection.close();
});

Deno.test("agent wire: authenticate before negotiate fails closed", async () => {
  const connection = connectionUnderTest();
  const { ctx } = fakeContext();
  const { result } = await connection.bootstrap.authenticate(
    authParams(),
    ctx,
  );
  assertEquals(result.which, "error");
  assertEquals(result.error?.code, "failedPrecondition");
  assertEquals(connection.phase, "closed");
  await connection.close();
});

Deno.test("agent wire: wrong credentials are attempt-limited, then the gate closes", async () => {
  const connection = connectionUnderTest();
  const { ctx } = fakeContext();
  await negotiateOk(connection, ctx);
  const wrong = new Uint8Array(32).fill(8);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { result } = await connection.bootstrap.authenticate(
      authParams(wrong),
      ctx,
    );
    assertEquals(result.which, "error", `attempt ${attempt}`);
    assertEquals(result.error?.code, "unauthenticated", `attempt ${attempt}`);
  }
  assertEquals(connection.phase, "closed");
  // Even the RIGHT credential is refused after the limit.
  const late = await connection.bootstrap.authenticate(authParams(), ctx);
  assertEquals(late.result.which, "error");
  assertEquals(late.result.error?.code, "failedPrecondition");
  await connection.close();
});

Deno.test("agent wire: agent() before authentication throws and closes the gate", async () => {
  const connection = connectionUnderTest();
  const { ctx } = fakeContext();
  await negotiateOk(connection, ctx);
  await assertRejects(async () => {
    await connection.bootstrap.agent({}, ctx);
  });
  assertEquals(connection.phase, "closed");
  await connection.close();
});

Deno.test("agent wire: a null credential config fails every authentication closed", async () => {
  const connection = createAgentWireConnection({
    api: fakeApi([]),
    identity: IDENTITY,
    credential: null,
  });
  const { ctx } = fakeContext();
  await negotiateOk(connection, ctx);
  const { result } = await connection.bootstrap.authenticate(
    authParams(),
    ctx,
  );
  assertEquals(result.which, "error");
  assertEquals(result.error?.code, "unauthenticated");
  await connection.close();
});

// ---------------------------------------------------------------------------
// Post-auth service graph through the generated dispatches
// ---------------------------------------------------------------------------

async function authenticatedAgentDispatch(
  connection: ReturnType<typeof connectionUnderTest>,
  fake: FakeContext,
): Promise<GeneratedDispatch> {
  await negotiateOk(connection, fake.ctx);
  const auth = await connection.bootstrap.authenticate(authParams(), fake.ctx);
  assertEquals(auth.result.which, "accepted");
  const { agent } = await connection.bootstrap.agent({}, fake.ctx);
  const pointer = agent as unknown as { capabilityIndex: number };
  const dispatch = fake.exports.get(pointer.capabilityIndex);
  assertExists(dispatch);
  return dispatch;
}

async function dispatchStruct<T>(
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

Deno.test("agent wire: spawn maps StdioMode/cwd/env onto the domain contract and returns a live Process capability", async () => {
  const spawned: AgentSpawnSpec[] = [];
  const connection = connectionUnderTest(spawned);
  const fake = fakeContext();
  const agentDispatch = await authenticatedAgentDispatch(connection, fake);

  // ping round-trips through the generated SandboxAgent dispatch.
  const pong = await dispatchStruct(
    fake,
    agentDispatch,
    wire.SandboxAgentMethodOrdinals.ping,
    wire.encodeStructMessage(wire.PingParamsStruct, { nonce: 7n }),
    (content) => wire.decodeStructMessage(wire.PingResultsStruct, content),
  );
  assertEquals(pong.nonce, 7n);

  // processes() exports a ProcessSpawner capability.
  const processesResult = await dispatchStruct(
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
  const spawnerPointer = processesResult.service as unknown as {
    capabilityIndex: number;
  };
  const spawnerDispatch = fake.exports.get(spawnerPointer.capabilityIndex);
  assertExists(spawnerDispatch);

  // spawn with the full StdioMode spread: inherit and piped both lower
  // to "piped"; discard lowers to "null"; empty cwd/env lower to
  // undefined.
  const spawnParams = wire.encodeStructMessageWithCaps(
    wire.SpawnParamsStruct,
    {
      spec: {
        command: "/bin/echo",
        args: ["hello"],
        cwd: "",
        env: [],
        stdin: "discard",
        stdout: "piped",
        stderr: "inherit",
      },
      output: null,
    },
  );
  const spawnResult = await dispatchStruct(
    fake,
    spawnerDispatch,
    wire.ProcessSpawnerMethodOrdinals.spawn,
    spawnParams.content,
    (content, capTable) =>
      wire.decodeStructMessageWithCaps(
        wire.SpawnResultsStruct,
        content,
        capTable as never[],
      ) as wire.SpawnResults,
  );
  assertEquals(spawnResult.result.which, "process");
  assertEquals(spawned.length, 1);
  assertEquals(spawned[0].command, "/bin/echo");
  assertEquals(spawned[0].args, ["hello"]);
  assertEquals(spawned[0].cwd, undefined);
  assertEquals(spawned[0].env, undefined);
  assertEquals(spawned[0].stdin, "null");
  assertEquals(spawned[0].stdout, "piped");
  assertEquals(spawned[0].stderr, "piped");

  // The exported Process capability reports the terminal 128+n status
  // with the wire KillSignal round-trip.
  const processPointer = spawnResult.result.process as unknown as {
    capabilityIndex: number;
  };
  const processDispatch = fake.exports.get(processPointer.capabilityIndex);
  assertExists(processDispatch);
  // Let the constructor's status subscription settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const statusResult = await dispatchStruct(
    fake,
    processDispatch,
    wire.ProcessMethodOrdinals.status,
    wire.encodeStructMessage(wire.StatusParamsStruct, {}),
    (content) => wire.decodeStructMessage(wire.StatusResultsStruct, content),
  );
  assertEquals(statusResult.result.which, "status");
  assertEquals(statusResult.result.status?.running, false);
  assertEquals(statusResult.result.status?.code, 143);
  assertEquals(statusResult.result.status?.signal, "sigterm");
  assertEquals(statusResult.result.status?.signaled, true);

  await connection.close();
});

Deno.test("agent wire: http() defers loudly with unsupportedFeature", async () => {
  const connection = connectionUnderTest();
  const fake = fakeContext();
  const agentDispatch = await authenticatedAgentDispatch(connection, fake);
  const error = await dispatchStruct(
    fake,
    agentDispatch,
    wire.SandboxAgentMethodOrdinals.http,
    wire.encodeStructMessage(wire.HttpParamsStruct, {}),
    (content) => content,
  ).then(() => null, (thrown: unknown) => thrown);
  assert(error instanceof Error, `expected a thrown error, got ${error}`);
  assert(
    error.message.includes("deferred to M8"),
    `expected a loud M8 deferral, got: ${error.message}`,
  );
  await connection.close();
});
