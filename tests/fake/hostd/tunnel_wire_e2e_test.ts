/**
 * M8 part 2b GATE: the PURE-WIRE end-to-end tunnel a Provider consumes.
 *
 * This is the leg the in-process fake tests could not prove: a client that
 * speaks `host_control.capnp` OVER A UDS (no in-process `HostControlCore`
 * handle) drives the whole flow the `@deno/sandbox` provider will drive —
 *
 *   wire HostControl.create -> HostSandbox.openTunnel -> (grant carries a
 *   ticket + agentCredential, NO endpoint) -> dial the STATIC tunnel router
 *   address the host was configured with -> SBXTUN1 -> ticket burn -> wire
 *   openBridge -> SBXBRG1 credential preface -> two-hop splice -> negotiate ->
 *   AgentBootstrap.authenticate(grant.agentCredential) -> SandboxAgent
 *
 * against the assembled hostd (`startHostControlServer` + `HostControlCore` +
 * `WireBridgeFactory`) + the rootd half (`BridgeWireGateway` standing up a real
 * `BridgeServer` per openBridge) + the REAL studioboxd over a UDS.
 *
 * The load-bearing fact for the Provider: the wire grant has NO endpoint field.
 * The client learns WHERE to dial out of band (the statically-forwarded tunnel
 * port — DESIGN.md §11), and the shared router routes the dial to the right
 * tunnel purely by the grant's ticket.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";

import {
  type CreateParams,
  HostBootstrap,
  type HostControl,
} from "../../../src/wire/generated/host_control_types.ts";
import { protocolOfferToWire } from "../../../src/rootd/service.ts";
import {
  buildHostContractIdentity,
  HOST_FEATURE_BITS,
  type HostCompatIdentitySource,
} from "../../../src/hostd/service.ts";
import { startHostControlServer } from "../../../src/hostd/main.ts";
import { HostControlCore } from "../../../src/hostd/control_core.ts";
import { WireBridgeFactory } from "../../../src/hostd/wire_bridge.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";
import {
  AGENT_PLANE_FEATURES,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../../../src/agent/service.ts";
import * as wire from "../../../src/wire/generated/sandbox_agent_types.ts";
import { dialTunnel } from "../../../src/transports/tunnel_client.ts";
import type { TunnelEndpoint } from "../../../src/transports/tunnel_client.ts";
import { BridgeWireGateway, startFakeAgent } from "./tunnel_harness.ts";

const TIMEOUT_MS = 20_000;
const CAP_CALL = {
  timeoutMs: TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

async function loadCompat(): Promise<HostCompatIdentitySource> {
  const text = await Deno.readTextFile(
    new URL("../../../compat/wire.json", import.meta.url),
  );
  return JSON.parse(text) as HostCompatIdentitySource;
}

function createParams(): CreateParams {
  return {
    options: {
      timeout: { which: "durationMs", durationMs: 300_000n },
      memoryMiB: 1024,
      vcpus: 2,
      allowNet: [],
      labels: [],
      region: "ord",
      netless: false,
      kernelArgs: [],
    },
    idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/** Speak host_control.capnp over a UDS: negotiate + authenticate + HostControl. */
async function connectHostControl(
  socketPath: string,
  identity: Awaited<ReturnType<typeof buildHostContractIdentity>>,
  credential: Uint8Array,
): Promise<{ control: RpcStub<HostControl>; close: () => Promise<void> }> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  let wireClient: RpcWireClient | null = null;
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: TIMEOUT_MS,
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => {},
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: TIMEOUT_MS });
  const client = wireClient;
  const bootstrap = await HostBootstrap.bootstrapClient(client, {
    timeoutMs: TIMEOUT_MS,
  });
  const negotiated = await bootstrap.negotiate(
    protocolOfferToWire({
      identity,
      limits: DEFAULT_TRANSPORT_LIMITS,
      requiredFeatureBits: HOST_FEATURE_BITS,
    }),
    { timeoutMs: TIMEOUT_MS },
  );
  assertEquals(negotiated.which, "accepted", "host handshake negotiates");
  const authed = await bootstrap.authenticate(credential.slice(), {
    timeoutMs: TIMEOUT_MS,
  });
  assertEquals(authed.which, "accepted", "host handshake authenticates");
  const control = await bootstrap.host(CAP_CALL);
  return {
    control,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

/** Run the fail-closed agent bootstrap over a spliced tunnel conn. */
async function agentOverTunnel(
  conn: Deno.Conn,
  credential: Uint8Array,
): Promise<
  { agent: RpcStub<wire.SandboxAgent>; close: () => Promise<void> }
> {
  let wireClient: RpcWireClient | null = null;
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: TIMEOUT_MS,
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => {},
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: TIMEOUT_MS });
  const client = wireClient;
  try {
    const bootstrap = await wire.AgentBootstrap.bootstrapClient(client, {
      timeoutMs: TIMEOUT_MS,
    });
    const handshake = await bootstrap.negotiate({
      identity: identityToWire(
        m3AgentContractIdentity("studiobox/m8-wire-e2e"),
      ),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs: TIMEOUT_MS });
    assertEquals(handshake.which, "accepted", handshake.error?.message);
    const auth = await bootstrap.authenticate({
      credential,
      sandboxId: "sbx-m8-wire-e2e",
      bootNonce: new Uint8Array(32),
    }, { timeoutMs: TIMEOUT_MS });
    assertEquals(auth.which, "accepted", auth.error?.message);
    const agent = await bootstrap.agent(CAP_CALL);
    return {
      agent,
      close: async () => {
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

Deno.test("tunnel(wire E2E): pure host_control client -> static router -> assembled bridge -> SandboxAgent", async () => {
  await using agent = await startFakeAgent();
  await using gateway = await BridgeWireGateway.start(agent);
  const dir = await Deno.makeTempDir({ prefix: "sbx-wire-e2e-" });
  // The host control plane socket AND the static tunnel router socket. In
  // production these are the forwarded loopback ports (control 40000, tunnel
  // 40001); here they are two known UDS paths the client is configured with out
  // of band — the wire grant never carries the tunnel address.
  const controlSocket = join(dir, "host.sock");
  const tunnelSocket = join(dir, "tunnel.sock");
  const tunnelEndpoint: TunnelEndpoint = {
    transport: "unix",
    path: tunnelSocket,
  };

  const core = new HostControlCore({
    gateway,
    bridgeFactory: new WireBridgeFactory(gateway),
    tunnelListen: { transport: "unix", path: tunnelSocket },
  });
  const identity = await buildHostContractIdentity(await loadCompat(), {
    buildId: "hostd-wire-e2e",
  });
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const server = await startHostControlServer({
    listen: { kind: "unix", socketPath: controlSocket },
    core,
    identity,
    credential,
  });

  const host = await connectHostControl(controlSocket, identity, credential);
  try {
    // create over the wire.
    const created = await host.control.create(createParams(), {
      timeoutMs: TIMEOUT_MS,
    });
    assertEquals(created.which, "success", created.error?.message);
    const id = created.success!.sandbox.id;
    assert(id.startsWith("sbx_loc_"), "SDK-facing local id");

    // openTunnel over the wire: the grant carries a ticket + agentCredential,
    // and NO endpoint (the client already knows the static tunnel address).
    const sandbox = await host.control.sandbox(id, CAP_CALL);
    const opened = await sandbox.openTunnel(CAP_CALL);
    assertEquals(opened.which, "grant", opened.error?.message);
    const grant = opened.grant!;
    assertEquals(grant.sandboxId, id);
    assertEquals(grant.ticket.byteLength, 32, "the grant carries the ticket");
    assertEquals(
      grant.agentCredential,
      agent.credential,
      "the grant carries the guest's launch-scoped credential",
    );
    // Reserving the bridge at openTunnel already fired the wire openBridge once.
    assertEquals(gateway.openedBridges.length, 1, "one wire openBridge");

    // Dial the STATIC router address with ONLY the grant's ticket. The router
    // routes it to this sandbox's tunnel, burns the ticket, and the reservation
    // connects the assembled bridge (SBXBRG1) to the guest.
    const conn = await dialTunnel(tunnelEndpoint, grant.ticket, {
      timeoutMs: TIMEOUT_MS,
    });
    assertEquals(
      gateway.openedBridges.length,
      1,
      "the dial reused the reserved bridge — no second openBridge",
    );

    // Authenticate with grant.agentCredential and drive the SandboxAgent plane.
    const session = await agentOverTunnel(conn, grant.agentCredential);
    try {
      const nonce = 2n ** 63n + 5n;
      assertEquals(
        await session.agent.ping(nonce, { timeoutMs: TIMEOUT_MS }),
        nonce,
        "ping echoes through the full pure-wire path",
      );
      const env = await session.agent.environment(CAP_CALL);
      assertEquals(
        (await env.set({ key: "GATE", value: "open" }, {
          timeoutMs: TIMEOUT_MS,
        })).which,
        "ok",
      );
      const got = await env.get("GATE", { timeoutMs: TIMEOUT_MS });
      assertEquals(got.which, "value");
      assertEquals(got.value, "open");
      await env.close();
    } finally {
      await session.close();
    }
    await sandbox.close();
  } finally {
    await host.close();
    await server.close();
    await core.closeAllTunnels();
    await core.drain();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
