/**
 * M8 assembly: the two-daemon ticketed tunnel end to end, host-safe (UDS only).
 *
 * Unlike the M7 `tunnel_test.ts` — which injects the guest dial straight through
 * the `bridgeFactory` seam — this drives the REAL assembled bridge hop:
 *
 *   client --SBXTUN1--> hostd TunnelServer
 *          --[bridge UDS]--> rootd BridgeServer --> guest agent
 *
 * `HostControlCore` is wired with a {@link WireBridgeFactory}. Every burned
 * ticket triggers `gateway.openBridge` (the M8 wire method), which stands up a
 * real {@link BridgeServer}; the factory then dials that UDS and presents the
 * grant's `bridgeCredential` in the fixed `SBXBRG1` preface before the guest is
 * reached. The guest here is the REAL studioboxd over a UDS (`startFakeAgent`),
 * so a capnp `SandboxAgent` session is driven through BOTH spliced hops.
 *
 * Covered:
 *   - happy path: openTunnel -> dial -> ticket burn -> openBridge -> credential
 *     preface -> two-hop splice -> capnp agent ping + env round-trip;
 *   - a wrong bridge credential is rejected by the BridgeServer WITHOUT dialing
 *     the guest, and the endpoint keeps serving;
 *   - the bridge accept loop survives connect-then-close / garbage-preface peers
 *     with no bridge claimed and no global unhandled rejection.
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
import { dialTunnel } from "../../../src/transports/tunnel_client.ts";
import {
  BridgeServer,
  type BridgeServerOptions,
} from "../../../src/rootd/bridge_server.ts";
import {
  encodeBridgeRequest,
  readBridgeResponse,
} from "../../../src/transports/bridge_preface.ts";
import { WireBridgeFactory } from "../../../src/hostd/wire_bridge.ts";
import {
  type CreateSandboxInput,
  HostControlCore,
} from "../../../src/hostd/control_core.ts";
import type { SupervisorBridgeGrant } from "../../../src/rootd/supervisor_core_api.ts";
import {
  type FakeAgent,
  FakeGateway,
  startFakeAgent,
} from "./tunnel_harness.ts";

const CALL_TIMEOUT_MS = 20_000;
const DIAL_BUDGET_MS = 20_000;

const CAP_CALL = {
  timeoutMs: CALL_TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

// ---------------------------------------------------------------------------
// A RootdGateway whose openBridge stands up a REAL BridgeServer (the rootd half)
// ---------------------------------------------------------------------------

/**
 * Stands in for the two-daemon split: `openBridge` mints a grant + binds a
 * per-bridge UDS whose guest dial reaches the fake agent, exactly as rootd's
 * `onBridgeGranted` does in production (there the guest dial is a real vsock).
 */
class BridgeWireGateway extends FakeGateway implements AsyncDisposable {
  readonly openedBridges: SupervisorBridgeGrant[] = [];
  readonly #servers = new Set<BridgeServer>();
  readonly #dir: string;
  #seq = 0;

  private constructor(
    dir: string,
    private readonly guestSocket: string,
    private readonly agentCredential: Uint8Array,
  ) {
    super();
    this.#dir = dir;
  }

  static async start(agent: FakeAgent): Promise<BridgeWireGateway> {
    const dir = await Deno.makeTempDir({ prefix: "sbx-brg-" });
    return new BridgeWireGateway(dir, agent.socket, agent.credential);
  }

  override openBridge(): Promise<SupervisorBridgeGrant> {
    const bridgeId = `b-${(this.#seq++).toString().padStart(4, "0")}`;
    const socketPath = `${this.#dir}/${bridgeId}.sock`;
    const bridgeCredential = crypto.getRandomValues(new Uint8Array(32));
    const options: BridgeServerOptions = {
      socketPath,
      credential: bridgeCredential,
      dialGuest: () =>
        Deno.connect({ transport: "unix", path: this.guestSocket }),
    };
    const server = BridgeServer.open(options);
    this.#servers.add(server);
    void server.finished.then(() => this.#servers.delete(server));
    const grant: SupervisorBridgeGrant = {
      bridgeId,
      socketPath,
      bridgeCredential,
      agentCredential: this.agentCredential.slice(),
      expiresAtUnixMs: Date.now() + 10_000,
    };
    this.openedBridges.push(grant);
    return Promise.resolve(grant);
  }

  /** The most recent bridge server (for adversarial probing of its endpoint). */
  get lastSocketPath(): string {
    return `${this.#dir}/b-${(this.#seq - 1).toString().padStart(4, "0")}.sock`;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.allSettled([...this.#servers].map((s) => s.close()));
    await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

function makeCore(gateway: BridgeWireGateway): HostControlCore {
  return new HostControlCore({
    gateway,
    bridgeFactory: new WireBridgeFactory(gateway),
    tunnelDialBudgetMs: DIAL_BUDGET_MS,
  });
}

async function createSandbox(core: HostControlCore): Promise<string> {
  const input: CreateSandboxInput = {
    timeout: { kind: "duration", durationMs: 300_000 },
    memoryMiB: 0,
    region: "loc",
    labels: [],
    idempotencyKey: new Uint8Array(0),
  };
  const result = await core.create(input);
  return result.sandbox.id;
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

/** Whether a filesystem path exists (the tunnel UDS is unlinked on free). */
async function pathExists(path: string): Promise<boolean> {
  if (path.length === 0) return false;
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Agent-plane session over an already-connected two-hop tunnel conn
// ---------------------------------------------------------------------------

interface TunnelAgentSession extends AsyncDisposable {
  readonly agent: RpcStub<wire.SandboxAgent>;
}

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
      identity: identityToWire(m3AgentContractIdentity("studiobox/m8-tunnel")),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(handshake.which, "accepted", handshake.error?.message);
    const auth = await bootstrap.authenticate({
      credential,
      sandboxId: "sbx-m8-tunnel",
      bootNonce: new Uint8Array(32),
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(auth.which, "accepted", auth.error?.message);
    const agent = await bootstrap.agent(CAP_CALL);
    return {
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

// ---------------------------------------------------------------------------
// 1) Happy path: capnp SandboxAgent driven through BOTH spliced hops
// ---------------------------------------------------------------------------

Deno.test("tunnel(M8): openTunnel -> wire openBridge -> BridgeServer -> two-hop splice -> capnp agent", async () => {
  await using agent = await startFakeAgent();
  await using gateway = await BridgeWireGateway.start(agent);
  const core = makeCore(gateway);
  try {
    const id = await createSandbox(core);
    const grant = await core.openTunnel(id);
    assertEquals(grant.sandboxId, id);

    // openTunnel reserved the bridge eagerly and surfaced the launch-scoped
    // guest-agent credential (PLAN.md §M8): the grant carries EXACTLY the bytes
    // the guest baked, so the client authenticates with grant.agentCredential —
    // never with a value it learned out of band.
    assertEquals(
      grant.agentCredential.byteLength,
      32,
      "the grant carries the guest-agent credential",
    );
    assertEquals(
      grant.agentCredential,
      agent.credential,
      "the grant credential matches the guest's baked token",
    );
    // Reserving happened at openTunnel — before the client dials — so the wire
    // openBridge already fired once.
    assertEquals(gateway.openedBridges.length, 1, "one wire openBridge");

    const conn = await dialTunnel(grant.endpoint, grant.ticket, {
      timeoutMs: DIAL_BUDGET_MS,
    });
    // Still exactly one bridge: the reservation's connect reused that grant.
    assertEquals(gateway.openedBridges.length, 1, "no second wire openBridge");

    await using session = await agentSessionOverTunnel(
      conn,
      grant.agentCredential,
    );
    const sandbox = session.agent;

    // ping echoes the full UInt64 range through the two-hop splice.
    const nonce = 2n ** 63n + 11n;
    assertEquals(
      await sandbox.ping(nonce, { timeoutMs: CALL_TIMEOUT_MS }),
      nonce,
    );

    // env set/get: a bidirectional request/response round-trip end to end.
    const env = await sandbox.environment(CAP_CALL);
    assertEquals(
      (await env.set({ key: "M8", value: "assembled" }, {
        timeoutMs: CALL_TIMEOUT_MS,
      })).which,
      "ok",
    );
    const got = await env.get("M8", { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(got.which, "value");
    assertEquals(got.value, "assembled");
    await env.close();
    await sandbox.close();
  } finally {
    await core.closeAllTunnels();
    await core.drain();
  }
});

// ---------------------------------------------------------------------------
// 1b) The guest agent verifies grant.agentCredential: a WRONG or ABSENT
//     credential is rejected by studioboxd; the ticket is single-use; teardown
//     leaves nothing behind.
// ---------------------------------------------------------------------------

/**
 * Negotiate then authenticate over an already-connected tunnel conn with the
 * given credential, WITHOUT asserting success — returns the `authenticate`
 * result arm so a test can assert the guest rejected a wrong/absent credential.
 * Always closes the wire client + transport.
 */
async function attemptAgentAuth(
  conn: Deno.Conn,
  credential: Uint8Array,
): Promise<"accepted" | "error"> {
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
      identity: identityToWire(m3AgentContractIdentity("studiobox/m8-auth")),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(handshake.which, "accepted", handshake.error?.message);
    const auth = await bootstrap.authenticate({
      credential,
      sandboxId: "sbx-m8-auth",
      bootNonce: new Uint8Array(32),
    }, { timeoutMs: CALL_TIMEOUT_MS });
    return auth.which === "accepted" ? "accepted" : "error";
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

Deno.test("tunnel(M8): studioboxd rejects a wrong/absent agentCredential over the assembled tunnel", async () => {
  await using agent = await startFakeAgent();
  await using gateway = await BridgeWireGateway.start(agent);
  const core = makeCore(gateway);
  // One sandbox, three fresh tunnels (each openTunnel mints its own ticket +
  // endpoint + bridge reservation) — the guest agent credential is launch-scoped
  // and identical across all three.
  const id = await createSandbox(core);
  const freshTunnelConn = async (): Promise<
    { conn: Deno.Conn; credential: Uint8Array }
  > => {
    const grant = await core.openTunnel(id);
    const conn = await dialTunnel(grant.endpoint, grant.ticket, {
      timeoutMs: DIAL_BUDGET_MS,
    });
    return { conn, credential: grant.agentCredential };
  };
  try {
    // A WRONG credential: the two-hop splice reaches the guest, but studioboxd's
    // constant-time authenticate refuses it.
    {
      const { conn, credential } = await freshTunnelConn();
      const wrong = new Uint8Array(32);
      wrong.set(credential);
      wrong[0] ^= 0xff; // flip a byte: a valid-length but wrong credential
      assertEquals(
        await attemptAgentAuth(conn, wrong),
        "error",
        "the guest rejects a wrong agentCredential",
      );
    }
    // An ABSENT (all-zero) credential is likewise refused.
    {
      const { conn } = await freshTunnelConn();
      assertEquals(
        await attemptAgentAuth(conn, new Uint8Array(32)),
        "error",
        "the guest rejects an absent agentCredential",
      );
    }
    // The RIGHT credential still authenticates — the endpoint was not poisoned.
    {
      const { conn, credential } = await freshTunnelConn();
      assertEquals(
        await attemptAgentAuth(conn, credential),
        "accepted",
        "the guest accepts the grant's agentCredential",
      );
    }
  } finally {
    await core.closeAllTunnels();
    await core.drain();
  }
});

Deno.test("tunnel(M8): the tunnel ticket is single-use and the endpoint frees on teardown", async () => {
  await using agent = await startFakeAgent();
  await using gateway = await BridgeWireGateway.start(agent);
  const core = makeCore(gateway);
  try {
    const id = await createSandbox(core);
    const grant = await core.openTunnel(id);
    const endpointPath = grant.endpoint.transport === "unix"
      ? grant.endpoint.path
      : "";

    // First dial burns the ticket and claims the tunnel.
    const conn = await dialTunnel(grant.endpoint, grant.ticket, {
      timeoutMs: DIAL_BUDGET_MS,
    });
    assertEquals(
      await attemptAgentAuth(conn, grant.agentCredential),
      "accepted",
    );

    // A REPLAY of the same ticket is rejected (single-use). The claimed tunnel's
    // endpoint frees after the first splice, so the replay may hit either a
    // burned ticket (dial error) or a freed endpoint (connection refused) —
    // either way it never yields a second agent session.
    await assertRejects(
      () => dialTunnel(grant.endpoint, grant.ticket, { timeoutMs: 2_000 }),
    );

    // Tearing the core down frees every endpoint + unlinks its socket file.
    await core.closeAllTunnels();
    await core.drain();
    assertEquals(
      await pathExists(endpointPath),
      false,
      "the tunnel endpoint socket is unlinked on teardown",
    );
  } finally {
    await core.closeAllTunnels();
    await core.drain();
  }
});

// ---------------------------------------------------------------------------
// 2) A wrong bridge credential is refused before the guest is dialed
// ---------------------------------------------------------------------------

Deno.test("bridge(M8): a wrong credential is rejected without dialing the guest; the endpoint keeps serving", async () => {
  await using agent = await startFakeAgent();
  const dir = await Deno.makeTempDir({ prefix: "sbx-brgc-" });
  const socketPath = `${dir}/b.sock`;
  const credential = crypto.getRandomValues(new Uint8Array(32));
  let dials = 0;
  const server = BridgeServer.open({
    socketPath,
    credential,
    dialGuest: () => {
      dials++;
      return Deno.connect({ transport: "unix", path: agent.socket });
    },
    ttlMs: 60_000,
  });
  try {
    // Wrong credential: the server closes with no ack and NO guest dial.
    const bad = await Deno.connect({ transport: "unix", path: socketPath });
    await writeAll(bad, encodeBridgeRequest(new Uint8Array(32)));
    // The server drops the connection; a read returns EOF (null) or throws.
    const probe = new Uint8Array(12);
    const n = await bad.read(probe).catch(() => null);
    assertEquals(n, null, "wrong credential closed before any ack");
    bad.close();
    assertEquals(dials, 0, "the guest was never dialed for a wrong credential");
    assert(!server.claimed, "no bridge was claimed by the bad credential");

    // The RIGHT credential still works: the endpoint kept serving.
    const good = await Deno.connect({ transport: "unix", path: socketPath });
    await writeAll(good, encodeBridgeRequest(credential));
    const response = await readBridgeResponse({
      read: (d) => good.read(d),
      close: () => good.close(),
    }, { timeoutMs: 5_000 });
    assertEquals(response.status, 0, "Ok status for the right credential");
    assertEquals(
      dials,
      1,
      "the guest was dialed once for the right credential",
    );
    good.close();
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 3) The bridge accept loop survives connect-then-close / garbage prefaces
// ---------------------------------------------------------------------------

Deno.test("bridge(M8): accept loop survives connect-then-close and garbage prefaces", async () => {
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  await using agent = await startFakeAgent();
  const dir = await Deno.makeTempDir({ prefix: "sbx-brgd-" });
  const socketPath = `${dir}/b.sock`;
  const credential = crypto.getRandomValues(new Uint8Array(32));
  let dials = 0;
  const server = BridgeServer.open({
    socketPath,
    credential,
    dialGuest: () => {
      dials++;
      return Deno.connect({ transport: "unix", path: agent.socket });
    },
    ttlMs: 60_000,
  });
  try {
    for (let i = 0; i < 40; i++) {
      const c = await Deno.connect({ transport: "unix", path: socketPath });
      c.close();
    }
    for (let i = 0; i < 20; i++) {
      const c = await Deno.connect({ transport: "unix", path: socketPath });
      await writeAll(c, crypto.getRandomValues(new Uint8Array(13)));
      c.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(dials, 0, "no abusive peer dialed the guest");
    assert(!server.claimed, "no bridge claimed by an abusive peer");

    // A genuine credential still completes: the loop (and endpoint) survived.
    const good = await Deno.connect({ transport: "unix", path: socketPath });
    await writeAll(good, encodeBridgeRequest(credential));
    const response = await readBridgeResponse({
      read: (d) => good.read(d),
      close: () => good.close(),
    }, { timeoutMs: 5_000 });
    assertEquals(response.status, 0);
    assertEquals(dials, 1);
    good.close();

    assertEquals(
      rejections.length,
      0,
      `no abusive peer should escape as a global unhandled rejection (saw ${rejections.length})`,
    );
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
});
