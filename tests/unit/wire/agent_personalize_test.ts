// src/agent/personalize.ts + the template-mode bootstrap state machine
// (snapshot-restore §2.2): a template-mode agent accepts ONLY `personalize`
// after negotiate — `authenticate`/`agent` are rejected until it succeeds;
// `personalize` sets the per-restore credential (a later `authenticate` with
// THAT credential succeeds, a wrong one fails), runs the exact in-guest ip/route
// argv (asserted via an injected fake runner) and writes resolv.conf; a second
// `personalize` returns already-personalized; a cold (--token-file) agent is
// unaffected. Also a codec round-trip for the new wire structs. Driven through
// the GENERATED low-level dispatches with a fake capability-export context, like
// tests/unit/wire/agent_service_test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";

import type {
  AgentApi,
  AgentDenoRuntime,
  AgentEnvironment,
  AgentFileSystem,
  AgentProcessSpawner,
} from "../../../src/agent/api.ts";
import {
  createAgentWireConnection,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../../../src/agent/service.ts";
import {
  PersonalizationController,
  type PersonalizeCommandRunner,
  type PersonalizeFileWriter,
} from "../../../src/agent/personalize.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";
import * as wire from "../../../src/wire/generated/sandbox_agent_types.ts";
import type * as wireCommon from "../../../src/wire/generated/common_types.ts";
import type { RpcCallContext } from "@nullstyle/capnp/rpc";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeContext(): RpcCallContext {
  let next = 1;
  return {
    capability: { capabilityIndex: 0 },
    methodId: 0,
    signal: new AbortController().signal,
    exportCapability: () => ({ capabilityIndex: next++ }),
  };
}

function fakeApi(): AgentApi {
  const spawner: AgentProcessSpawner = {
    spawn: () => Promise.reject(new Error("not under test")),
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

class FakeRunner implements PersonalizeCommandRunner {
  readonly calls: string[][] = [];
  failAt: number | null = null;

  run(argv: readonly string[]): Promise<void> {
    this.calls.push([...argv]);
    if (this.failAt !== null && this.calls.length === this.failAt) {
      return Promise.reject(new Error(`fake failure at call ${this.failAt}`));
    }
    return Promise.resolve();
  }
}

class FakeWriter implements PersonalizeFileWriter {
  readonly writes: Array<{ path: string; contents: string }> = [];

  write(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTITY = m3AgentContractIdentity("studioboxd/test");
const CREDENTIAL = new Uint8Array(32).fill(7);
const BOOT_NONCE = new Uint8Array(32).fill(9);
const SANDBOX_ID = "sbx-personalize";
const RESOLV_PATH = "/etc/resolv.conf";

function offer(): wireCommon.ProtocolOffer {
  return {
    identity: identityToWire(IDENTITY),
    limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
    requiredFeatureBits: 0n,
  };
}

function networkedRequest(): wire.PersonalizeRequest {
  return {
    credential: CREDENTIAL,
    bootNonce: BOOT_NONCE,
    sandboxId: SANDBOX_ID,
    network: {
      guestCidr: "10.201.0.2/30",
      gateway: "10.201.0.1",
      dns: "10.201.0.3",
      iface: "eth0",
    },
  };
}

function pendingController(runner: FakeRunner, writer: FakeWriter) {
  return PersonalizationController.pending({
    runner,
    writer,
    resolvConfPath: RESOLV_PATH,
  });
}

function connectionFor(controller?: PersonalizationController) {
  return createAgentWireConnection({
    api: fakeApi(),
    identity: IDENTITY,
    credential: controller === undefined ? CREDENTIAL : null,
    ...(controller === undefined ? {} : { controller }),
  });
}

type Connection = ReturnType<typeof connectionFor>;

async function negotiateOk(connection: Connection, ctx: RpcCallContext) {
  const { result } = await connection.bootstrap.negotiate(
    { offer: offer() },
    ctx,
  );
  assertEquals(result.which, "accepted");
}

// ---------------------------------------------------------------------------
// Template-mode state machine
// ---------------------------------------------------------------------------

Deno.test("personalize: template mode rejects authenticate before personalize (not an auth failure)", async () => {
  const controller = pendingController(new FakeRunner(), new FakeWriter());
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);

  // Three attempts must NOT trip the auth attempt limit (they are not auth
  // failures); every one is a typed failedPrecondition and the gate stays open.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { result } = await connection.bootstrap.authenticate(
      { credential: CREDENTIAL, sandboxId: SANDBOX_ID, bootNonce: BOOT_NONCE },
      ctx,
    );
    assertEquals(result.which, "error", `attempt ${attempt}`);
    assertEquals(result.error?.code, "failedPrecondition");
    assert(result.error?.message.includes("not yet personalized"));
  }
  assertEquals(connection.phase, "negotiated");
  await connection.close();
});

Deno.test("personalize: template mode rejects agent() before personalize", async () => {
  const controller = pendingController(new FakeRunner(), new FakeWriter());
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);
  await assertRejects(
    async () => {
      await connection.bootstrap.agent({}, ctx);
    },
    Error,
    "not yet personalized",
  );
  await connection.close();
});

Deno.test("personalize: before negotiate fails closed", async () => {
  const runner = new FakeRunner();
  const controller = pendingController(runner, new FakeWriter());
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  const { result } = await connection.bootstrap.personalize(
    { request: networkedRequest() },
    ctx,
  );
  assertEquals(result.which, "error");
  assertEquals(result.error?.code, "failedPrecondition");
  assert(result.error?.message.includes("negotiated phase"));
  assertEquals(runner.calls.length, 0);
  assertEquals(controller.state, "pending");
  await connection.close();
});

Deno.test("personalize: sets the credential + runs the exact ip/route argv + writes resolv.conf; a later authenticate with THAT credential succeeds and a wrong one fails", async () => {
  const runner = new FakeRunner();
  const writer = new FakeWriter();
  const controller = pendingController(runner, writer);

  // rootd's connection: negotiate -> personalize.
  const rootd = connectionFor(controller);
  const rootdCtx = fakeContext();
  await negotiateOk(rootd, rootdCtx);
  const { result } = await rootd.bootstrap.personalize(
    { request: networkedRequest() },
    rootdCtx,
  );
  assertEquals(result.which, "ok");
  assertEquals(result.ok?.buildId, IDENTITY.buildId);
  assertEquals(result.ok?.appliedCidr, "10.201.0.2/30");
  assertEquals(controller.state, "personalized");

  // The exact in-guest network argv, in order.
  assertEquals(runner.calls, [
    ["ip", "addr", "flush", "dev", "eth0"],
    ["ip", "addr", "add", "10.201.0.2/30", "dev", "eth0"],
    ["ip", "link", "set", "eth0", "up"],
    ["ip", "route", "replace", "default", "via", "10.201.0.1"],
  ]);
  assertEquals(writer.writes, [
    { path: RESOLV_PATH, contents: "nameserver 10.201.0.3\n" },
  ]);

  // A LATER client connection (a different transport) shares the SAME
  // process-global controller: authenticate with the personalized credential
  // succeeds.
  const client = connectionFor(controller);
  const clientCtx = fakeContext();
  await negotiateOk(client, clientCtx);
  const good = await client.bootstrap.authenticate(
    { credential: CREDENTIAL, sandboxId: SANDBOX_ID, bootNonce: BOOT_NONCE },
    clientCtx,
  );
  assertEquals(good.result.which, "accepted");
  assertEquals(client.phase, "authenticated");

  // A wrong credential is refused (unauthenticated), and the bootNonce/sandboxId
  // binding personalize set is enforced.
  const attacker = connectionFor(controller);
  const attackerCtx = fakeContext();
  await negotiateOk(attacker, attackerCtx);
  const wrong = await attacker.bootstrap.authenticate(
    {
      credential: new Uint8Array(32).fill(1),
      sandboxId: SANDBOX_ID,
      bootNonce: BOOT_NONCE,
    },
    attackerCtx,
  );
  assertEquals(wrong.result.which, "error");
  assertEquals(wrong.result.error?.code, "unauthenticated");

  await rootd.close();
  await client.close();
  await attacker.close();
});

Deno.test("personalize: a second personalize returns already-personalized (one-shot)", async () => {
  const runner = new FakeRunner();
  const controller = pendingController(runner, new FakeWriter());
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);

  const first = await connection.bootstrap.personalize(
    { request: networkedRequest() },
    ctx,
  );
  assertEquals(first.result.which, "ok");

  const second = await connection.bootstrap.personalize(
    { request: networkedRequest() },
    ctx,
  );
  assertEquals(second.result.which, "error");
  assertEquals(second.result.error?.code, "failedPrecondition");
  assert(second.result.error?.message.includes("already personalized"));
  // The network is NOT re-applied on the rejected second call.
  assertEquals(runner.calls.length, 4);
  await connection.close();
});

Deno.test("personalize: a netless request (empty guestCidr) applies no commands and leaves the NIC down", async () => {
  const runner = new FakeRunner();
  const writer = new FakeWriter();
  const controller = pendingController(runner, writer);
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);

  const request: wire.PersonalizeRequest = {
    credential: CREDENTIAL,
    bootNonce: BOOT_NONCE,
    sandboxId: SANDBOX_ID,
    network: { guestCidr: "", gateway: "", dns: "", iface: "" },
  };
  const { result } = await connection.bootstrap.personalize({ request }, ctx);
  assertEquals(result.which, "ok");
  assertEquals(result.ok?.appliedCidr, "");
  assertEquals(runner.calls.length, 0);
  assertEquals(writer.writes.length, 0);
  assertEquals(controller.state, "personalized");
  await connection.close();
});

Deno.test("personalize: an invalid credential length is rejected and does not personalize", async () => {
  const runner = new FakeRunner();
  const controller = pendingController(runner, new FakeWriter());
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);

  const request: wire.PersonalizeRequest = {
    credential: new Uint8Array(8), // below the 16-byte floor
    bootNonce: BOOT_NONCE,
    sandboxId: SANDBOX_ID,
    network: { guestCidr: "", gateway: "", dns: "", iface: "" },
  };
  const { result } = await connection.bootstrap.personalize({ request }, ctx);
  assertEquals(result.which, "error");
  assertEquals(result.error?.code, "invalidArgument");
  assertEquals(controller.state, "pending");
  await connection.close();
});

Deno.test("personalize: a network-apply failure surfaces as internal and leaves the controller pending", async () => {
  const runner = new FakeRunner();
  runner.failAt = 2; // fail on `ip addr add`
  const controller = pendingController(runner, new FakeWriter());
  const connection = connectionFor(controller);
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);

  const { result } = await connection.bootstrap.personalize(
    { request: networkedRequest() },
    ctx,
  );
  assertEquals(result.which, "error");
  assertEquals(result.error?.code, "internal");
  // Credential is NOT set, so a later authenticate still fails closed.
  assertEquals(controller.state, "pending");
  assertEquals(controller.credential, null);
  await connection.close();
});

Deno.test("personalize: is one-shot against CONCURRENT calls — a second call that interleaves across the NIC-apply await cannot swap the credential", async () => {
  // A runner that BLOCKS the first `ip addr flush` until we release it, so a
  // second personalize can interleave while the first is awaiting its apply.
  const gate = Promise.withResolvers<void>();
  let firstCall = true;
  const runner: PersonalizeCommandRunner = {
    run: async () => {
      if (firstCall) {
        firstCall = false;
        await gate.promise;
      }
    },
  };
  const controller = PersonalizationController.pending({
    runner,
    writer: new FakeWriter(),
    resolvConfPath: RESOLV_PATH,
  });

  const credA = new Uint8Array(32).fill(0xa);
  const credB = new Uint8Array(32).fill(0xb);
  const inputFor = (credential: Uint8Array) => ({
    credential,
    bootNonce: BOOT_NONCE,
    sandboxId: SANDBOX_ID,
    network: {
      guestCidr: "10.201.0.2/30",
      gateway: "10.201.0.1",
      dns: "10.201.0.3",
      iface: "eth0",
    },
  });

  // A claims the controller and parks on the gated first command; B then
  // interleaves synchronously — it must be rejected by the in-progress latch,
  // NOT allowed to also pass the pending guard and overwrite the credential.
  const callA = controller.personalize(inputFor(credA));
  await assertRejects(
    () => controller.personalize(inputFor(credB)),
    Error,
    "already personalized",
  );
  gate.resolve();
  const outcome = await callA;
  assertEquals(outcome.appliedCidr, "10.201.0.2/30");

  // A's credential is the one every later authenticate is checked against —
  // B never got to swap it.
  assertEquals(controller.state, "personalized");
  assertEquals(controller.credential, credA);
});

Deno.test("personalize: a failed NIC apply releases the latch so a retry can re-personalize", async () => {
  const runner = new FakeRunner();
  runner.failAt = 2; // fail on `ip addr add`
  const controller = PersonalizationController.pending({
    runner,
    writer: new FakeWriter(),
    resolvConfPath: RESOLV_PATH,
  });
  const input = {
    credential: CREDENTIAL,
    bootNonce: BOOT_NONCE,
    sandboxId: SANDBOX_ID,
    network: {
      guestCidr: "10.201.0.2/30",
      gateway: "10.201.0.1",
      dns: "10.201.0.3",
      iface: "eth0",
    },
  };
  await assertRejects(() => controller.personalize(input), Error);
  assertEquals(controller.state, "pending");
  assertEquals(controller.credential, null);

  // The latch is released: a fresh personalize (rootd retry) now succeeds.
  runner.failAt = null;
  const outcome = await controller.personalize(input);
  assertEquals(outcome.appliedCidr, "10.201.0.2/30");
  assertEquals(controller.state, "personalized");
  assertEquals(controller.credential, CREDENTIAL);
});

// ---------------------------------------------------------------------------
// Cold-path parity
// ---------------------------------------------------------------------------

Deno.test("personalize: a cold (--token-file) agent rejects personalize as already-personalized and authenticates unchanged", async () => {
  // No controller supplied: the wire plane synthesizes a `personalized`
  // controller from the boot credential (the cold path).
  const connection = connectionFor();
  const ctx = fakeContext();
  await negotiateOk(connection, ctx);

  const personalize = await connection.bootstrap.personalize(
    { request: networkedRequest() },
    ctx,
  );
  assertEquals(personalize.result.which, "error");
  assert(personalize.result.error?.message.includes("already personalized"));

  // authenticate with the boot credential still works exactly as before.
  const auth = await connection.bootstrap.authenticate(
    {
      credential: CREDENTIAL,
      sandboxId: "sbx-cold",
      bootNonce: new Uint8Array(32),
    },
    ctx,
  );
  assertEquals(auth.result.which, "accepted");
  assertEquals(connection.phase, "authenticated");
  await connection.close();
});

// ---------------------------------------------------------------------------
// Wire round-trip
// ---------------------------------------------------------------------------

Deno.test("personalize: PersonalizeRequest / PersonalizeResult round-trip through the generated codecs", () => {
  const request = networkedRequest();
  const decodedRequest = wire.PersonalizeRequestCodec.decode(
    wire.PersonalizeRequestCodec.encode(request),
  );
  assertEquals(decodedRequest.credential, CREDENTIAL);
  assertEquals(decodedRequest.bootNonce, BOOT_NONCE);
  assertEquals(decodedRequest.sandboxId, SANDBOX_ID);
  assertEquals(decodedRequest.network.guestCidr, "10.201.0.2/30");
  assertEquals(decodedRequest.network.gateway, "10.201.0.1");
  assertEquals(decodedRequest.network.dns, "10.201.0.3");
  assertEquals(decodedRequest.network.iface, "eth0");

  const ok: wire.PersonalizeResult = {
    which: "ok",
    ok: { buildId: IDENTITY.buildId, appliedCidr: "10.201.0.2/30" },
  };
  const decodedOk = wire.PersonalizeResultCodec.decode(
    wire.PersonalizeResultCodec.encode(ok),
  );
  assertEquals(decodedOk.which, "ok");
  assertEquals(decodedOk.ok?.buildId, IDENTITY.buildId);
  assertEquals(decodedOk.ok?.appliedCidr, "10.201.0.2/30");

  // The method wrappers carry the payloads.
  const params = wire.PersonalizeParamsCodec.decode(
    wire.PersonalizeParamsCodec.encode({ request }),
  );
  assertEquals(params.request.sandboxId, SANDBOX_ID);
  const results = wire.PersonalizeResultsCodec.decode(
    wire.PersonalizeResultsCodec.encode({ result: ok }),
  );
  assertEquals(results.result.ok?.appliedCidr, "10.201.0.2/30");
});
