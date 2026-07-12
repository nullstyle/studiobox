/**
 * M7 end-to-end ticketed tunnel over the fake (UDS) tier — host-safe, no VM.
 *
 * Exercises the whole path with the domain core driven directly:
 * `HostControlCore.openTunnel` -> per-tunnel loopback endpoint -> client dial
 * with the real `SBXTUN1` preface -> `SBXACK1` -> ticket BURN before bridge ->
 * splice -> a capnp `SandboxAgent` session driven THROUGH the tunnel, plus the
 * adversarial cases: single-use (replay rejected), expiry, close-before-ack on
 * a bad/absent ticket (no bridge opened), teardown-frees-the-endpoint, and an
 * accept loop that survives connect-then-close / garbage-preface peers.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";

import {
  AGENT_PLANE_FEATURES,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../../../src/agent/service.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";
import * as wire from "../../../src/wire/generated/sandbox_agent_types.ts";
import type * as wireCommon from "../../../src/wire/generated/common_types.ts";
import * as wireStreams from "../../../src/wire/generated/streams_types.ts";
import {
  dialTunnel,
  TunnelDialError,
} from "../../../src/transports/tunnel_client.ts";
import { SingleUseTicketStore } from "../../../src/security/tickets.ts";
import {
  EchoServer,
  FakeClock,
  makeTunnelCore,
  startFakeAgent,
} from "./tunnel_harness.ts";

const CALL_TIMEOUT_MS = 20_000;
const DIAL_BUDGET_MS = 20_000;

const CAP_CALL = {
  timeoutMs: CALL_TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function pollUntilAbsent(path: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const present = await Deno.lstat(path).then(() => true, () => false);
    if (!present) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`endpoint ${path} was not freed within ${budgetMs}ms`);
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function readN(conn: Deno.Conn, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const count = await conn.read(out.subarray(offset));
    if (count === null) throw new Error("stream ended early");
    offset += count;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent-plane session over an already-connected tunnel conn
// ---------------------------------------------------------------------------

interface TunnelAgentSession extends AsyncDisposable {
  readonly agent: RpcStub<wire.SandboxAgent>;
  readonly wireClient: RpcWireClient;
}

/** Wrap the spliced tunnel conn and run the fail-closed agent bootstrap. */
async function agentSessionOverTunnel(
  conn: Deno.Conn,
  credential: Uint8Array,
): Promise<TunnelAgentSession> {
  let wireClient: RpcWireClient | null = null;
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
      identity: identityToWire(m3AgentContractIdentity("studiobox/m7-tunnel")),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(handshake.which, "accepted", handshake.error?.message);
    const auth = await bootstrap.authenticate({
      credential,
      sandboxId: "sbx-m7-tunnel",
      bootNonce: new Uint8Array(32),
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(auth.which, "accepted", auth.error?.message);
    const agent = await bootstrap.agent(CAP_CALL);
    return {
      agent,
      wireClient: client,
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

// Minimal stdout collector for the spawn echo.
class StdoutSink implements wireStreams.OutputSinkService {
  readonly #chunks: Uint8Array[] = [];
  #next = 0n;
  #done!: () => void;
  readonly finished: Promise<void> = new Promise((r) => (this.#done = r));

  chunk(params: wireStreams.ChunkParams2): void {
    if (params.channel !== "stdout") return;
    assertEquals(params.sequence, this.#next);
    this.#next += 1n;
    this.#chunks.push(params.data.slice());
  }

  finish(params: wireStreams.FinishParams2): wireStreams.FinishResult {
    if (params.channel === "stdout") this.#done();
    return {
      which: "receipt",
      receipt: { totalBytes: 0n, chunkCount: 0n, sha256: new Uint8Array(32) },
    };
  }

  fail(params: wireStreams.FailParams): wireCommon.EmptyResult {
    if (params.channel === "stdout") this.#done();
    return { which: "ok", ok: {} };
  }

  text(): string {
    let length = 0;
    for (const chunk of this.#chunks) length += chunk.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(out);
  }
}

// ---------------------------------------------------------------------------
// 1) Happy path: a capnp SandboxAgent ping + echo driven THROUGH the tunnel
// ---------------------------------------------------------------------------

Deno.test("tunnel: openTunnel -> preface -> ACK -> bridge -> capnp agent ping + echo", async () => {
  await using agent = await startFakeAgent();
  const bridge = agent.bridgeFactory();
  await using h = makeTunnelCore({
    bridgeFactory: bridge,
    tunnelDialBudgetMs: DIAL_BUDGET_MS,
  });
  const id = await h.createSandbox();

  const grant = await h.core.openTunnel(id);
  assertEquals(grant.endpoint.transport, "unix");
  assertEquals(grant.sandboxId, id);
  assert(grant.ticket.byteLength === 32, "ticket is 32 bytes");

  const conn = await dialTunnel(grant.endpoint, grant.ticket, {
    timeoutMs: DIAL_BUDGET_MS,
  });
  assertEquals(bridge.requests.length, 1, "exactly one bridge opened");
  assertEquals(bridge.requests[0].executionId.length > 0, true);

  const endpointPath = grant.endpoint.transport === "unix"
    ? grant.endpoint.path
    : "";

  {
    await using session = await agentSessionOverTunnel(conn, agent.credential);
    const { agent: sandbox, wireClient } = session;

    // ping echoes the full UInt64 range THROUGH the splice.
    const nonce = 2n ** 63n + 7n;
    assertEquals(
      await sandbox.ping(nonce, { timeoutMs: CALL_TIMEOUT_MS }),
      nonce,
    );

    // env set/get: a bidirectional request/response round-trip.
    const env = await sandbox.environment(CAP_CALL);
    assertEquals(
      (await env.set({ key: "M7", value: "on" }, {
        timeoutMs: CALL_TIMEOUT_MS,
      }))
        .which,
      "ok",
    );
    const got = await env.get("M7", { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(got.which, "value");
    assertEquals(got.value, "on");
    await env.close();

    // spawn /bin/echo: stdout streamed back through the OutputSink over the tunnel.
    const spawner = await sandbox.processes(CAP_CALL);
    const sink = new StdoutSink();
    const sinkStub = wireStreams.OutputSink.registerServer(wireClient, sink, {
      referenceCount: 2,
    }) as unknown as RpcStub<wireStreams.OutputSink>;
    const spawned = await spawner.spawn({
      spec: {
        command: "/bin/echo",
        args: ["hello-through-the-tunnel"],
        cwd: "",
        env: [],
        stdin: "discard",
        stdout: "piped",
        stderr: "discard",
      },
      output: sinkStub,
    }, CAP_CALL);
    assertEquals(spawned.which, "process", spawned.error?.message);
    await sink.finished;
    assertEquals(sink.text(), "hello-through-the-tunnel\n");
    const status = await spawned.process!.wait({ timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(status.status?.code, 0);
    await spawned.process!.release();
    await spawned.process!.close();
    await spawner.close();
    await sandbox.close();
  }

  // Teardown from the client end propagated EOF: the endpoint is freed with no
  // leaked listener / socket file.
  await pollUntilAbsent(endpointPath);
});

// ---------------------------------------------------------------------------
// 2) The ticket is single-use: a replay is rejected (closed before ACK)
// ---------------------------------------------------------------------------

Deno.test("tunnel: a replayed ticket is rejected (single-use), first tunnel still live", async () => {
  await using echo = await EchoServer.start();
  const bridge = echo.bridgeFactory();
  await using h = makeTunnelCore({
    bridgeFactory: bridge,
    tunnelDialBudgetMs: DIAL_BUDGET_MS,
  });
  const id = await h.createSandbox();
  const grant = await h.core.openTunnel(id);

  // First dial burns the ticket and splices to the echo guest.
  const conn = await dialTunnel(grant.endpoint, grant.ticket, {
    timeoutMs: DIAL_BUDGET_MS,
  });
  assertEquals(bridge.requests.length, 1);
  // Prove the splice carries bytes: echo round-trip.
  await writeAll(conn, new TextEncoder().encode("ping-1"));
  assertEquals(
    new TextDecoder().decode(await readN(conn, 6)),
    "ping-1",
  );

  // A second dial presenting the SAME ticket is rejected — closed before ACK,
  // and NO second bridge is opened.
  await assertRejects(
    () => dialTunnel(grant.endpoint, grant.ticket, { timeoutMs: 3_000 }),
    TunnelDialError,
  );
  assertEquals(bridge.requests.length, 1, "replay opened no bridge");

  // The first tunnel is unaffected.
  await writeAll(conn, new TextEncoder().encode("ping-2"));
  assertEquals(new TextDecoder().decode(await readN(conn, 6)), "ping-2");
  conn.close();
});

// ---------------------------------------------------------------------------
// 3) A bad / absent ticket closes before ACK and opens no bridge
// ---------------------------------------------------------------------------

Deno.test("tunnel: a bad ticket closes before ACK with no bridge; the real ticket still works", async () => {
  await using echo = await EchoServer.start();
  const bridge = echo.bridgeFactory();
  await using h = makeTunnelCore({
    bridgeFactory: bridge,
    tunnelDialBudgetMs: DIAL_BUDGET_MS,
  });
  const id = await h.createSandbox();
  const grant = await h.core.openTunnel(id);

  // A random (wrong) 32-byte ticket is rejected before ACK; no bridge opens and
  // the real ticket is NOT burned.
  const wrongTicket = crypto.getRandomValues(new Uint8Array(32));
  await assertRejects(
    () => dialTunnel(grant.endpoint, wrongTicket, { timeoutMs: 3_000 }),
    TunnelDialError,
  );
  assertEquals(bridge.requests.length, 0, "bad ticket opened no bridge");

  // The genuine ticket still works: the endpoint kept serving.
  const conn = await dialTunnel(grant.endpoint, grant.ticket, {
    timeoutMs: DIAL_BUDGET_MS,
  });
  assertEquals(bridge.requests.length, 1);
  await writeAll(conn, new TextEncoder().encode("ok"));
  assertEquals(new TextDecoder().decode(await readN(conn, 2)), "ok");
  conn.close();
});

// ---------------------------------------------------------------------------
// 4) An expired ticket is rejected (dial budget > ticket TTL is a mistake we
//    guard: here we advance the clock past the 15s TTL and prove rejection)
// ---------------------------------------------------------------------------

Deno.test("tunnel: an expired ticket is rejected before ACK", async () => {
  await using echo = await EchoServer.start();
  const bridge = echo.bridgeFactory();
  const clock = new FakeClock();
  const tickets = new SingleUseTicketStore({ now: () => clock.now() });
  await using h = makeTunnelCore({
    bridgeFactory: bridge,
    clock,
    tickets,
    // A long real-time budget so the endpoint stays open while the LOGICAL
    // clock advances past the ticket's 15s TTL.
    tunnelDialBudgetMs: 60_000,
  });
  const id = await h.createSandbox();
  const grant = await h.core.openTunnel(id);

  // Advance the logical clock past the 15s ticket TTL.
  clock.advance(20_000);

  await assertRejects(
    () => dialTunnel(grant.endpoint, grant.ticket, { timeoutMs: 3_000 }),
    TunnelDialError,
  );
  assertEquals(bridge.requests.length, 0, "expired ticket opened no bridge");
});

// ---------------------------------------------------------------------------
// 5) The accept loop survives connect-then-close / garbage-preface peers
// ---------------------------------------------------------------------------

Deno.test("tunnel: accept loop survives connect-then-close and garbage prefaces", async () => {
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  await using echo = await EchoServer.start();
  const bridge = echo.bridgeFactory();
  await using h = makeTunnelCore({
    bridgeFactory: bridge,
    tunnelDialBudgetMs: 60_000,
  });
  try {
    const id = await h.createSandbox();
    const grant = await h.core.openTunnel(id);
    const path = grant.endpoint.transport === "unix" ? grant.endpoint.path : "";

    // Connect-then-immediately-close peers.
    for (let i = 0; i < 40; i++) {
      const c = await Deno.connect({ transport: "unix", path });
      c.close();
    }
    // Garbage-preface peers: wrong magic / partial bytes, then close.
    for (let i = 0; i < 20; i++) {
      const c = await Deno.connect({ transport: "unix", path });
      await writeAll(c, crypto.getRandomValues(new Uint8Array(13)));
      c.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    // No bridge should have opened for any of the abusive peers.
    assertEquals(bridge.requests.length, 0, "abuse opened no bridge");

    // A genuine dial still completes: the loop (and endpoint) survived.
    const conn = await dialTunnel(grant.endpoint, grant.ticket, {
      timeoutMs: DIAL_BUDGET_MS,
    });
    assertEquals(bridge.requests.length, 1);
    await writeAll(conn, new TextEncoder().encode("alive"));
    assertEquals(new TextDecoder().decode(await readN(conn, 5)), "alive");
    conn.close();

    assertEquals(
      rejections.length,
      0,
      `no abusive peer should escape as a global unhandled rejection (saw ${rejections.length})`,
    );
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
});
