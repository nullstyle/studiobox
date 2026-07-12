/**
 * The M7 ticketed-tunnel in-VM proof (PLAN.md §M7; DESIGN.md §4, T3 tier).
 *
 * Where the M7 fake tier drove the tunnel over a UDS "guest", this boots a
 * REAL jailed Firecracker microVM and runs the WHOLE tunnel against the real
 * studioboxd over real vsock — the "sandbox.sh answered through the real
 * tunnel" proof, driven from inside `fc-smoke`:
 *
 *   SupervisorCore.launch (real jailed VMM, studioboxd on real vsock)
 *     → issue a single-use ticket + stand up a per-tunnel loopback endpoint
 *       (the exact binding + bridgeRequest `HostControlCore.openTunnel` builds)
 *     → dialTunnel: SBXTUN1 preface carrying the ticket
 *     → the authorizer BURNS the ticket, THEN SupervisorBridgeFactory.openBridge
 *       dials the REAL guest agent vsock (connectBridge → connectVsock)
 *     → spliceDuplex pumps bytes verbatim between the tunnel conn and the vsock
 *     → a capnp SandboxAgent session driven THROUGH the tunnel:
 *         · ping echoes a full UInt64 nonce
 *         · exec `sh -c "echo tunneled"` → "tunneled\n"
 *         · write + read a file back through the FileSystem plane
 *         · deno repl `1 + 2 == 3`
 *     → teardown: EOF propagates, the vsock bridge conn closes, the endpoint /
 *       socket file is freed, the ticket is burned (a replay is rejected with no
 *       second bridge), no bridge leaks
 *     → kill → VM gone, jail reclaimed, vsock unlinked.
 *
 * A second case proves the dial-races-VMM-death guarantee against real
 * hardware: SIGKILL the VMM out from under a live record, then dial the tunnel
 * and assert a typed {@link TunnelDialError} within a bounded window — never a
 * hang (leans on the firecracker-deno dial-races-death fix + the connectBridge /
 * agent_dialer bounding).
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { Sha256 } from "../../src/agent/sha256.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../src/wire/contract.ts";
import { decodeReplValue } from "../../src/agent/deno_runtime_codec.ts";
import * as wire from "../../src/wire/generated/sandbox_agent_types.ts";

import { SupervisorBridgeFactory } from "../../src/rootd/bridge.ts";
import { SingleUseTicketStore } from "../../src/security/tickets.ts";
import { TunnelAuthorizer } from "../../src/hostd/tunnel_authorizer.ts";
import type {
  PrivilegedBridgeFactory,
  PrivilegedBridgeRequest,
} from "../../src/hostd/tunnel_authorizer.ts";
import { TunnelServer } from "../../src/hostd/tunnel_server.ts";
import {
  dialTunnel,
  TunnelDialError,
} from "../../src/transports/tunnel_client.ts";
// The production dialer accepts any Deno.Conn (the support.ts helper narrows to
// VsockConn); the spliced tunnel conn is a plain UnixConn, so drive it directly.
import { openAgentSession } from "../../src/rootd/agent_dialer.ts";

import {
  buildPlanner,
  CALL_TIMEOUT_MS,
  CAP_CALL,
  concatBytes,
  inGuest,
  jailExecDir,
  pathExists,
  pidAlive,
  readVmConfig,
  registerSink,
  requireProcess,
  SinkCollector,
  spec,
  toHex,
  vsockHostPath,
} from "./support.ts";

/** Dial budget for the tunnel handshake (< the 15s ticket TTL, per §M7). */
const TUNNEL_DIAL_MS = 10_000;

// ---------------------------------------------------------------------------
// A bridge factory that records requests and captures the live vsock conn, so a
// test can assert "exactly one real bridge opened" and "that vsock conn closed
// on teardown". It wraps the production SupervisorBridgeFactory verbatim.
// ---------------------------------------------------------------------------

class CapturingBridgeFactory implements PrivilegedBridgeFactory<Deno.Conn> {
  readonly requests: PrivilegedBridgeRequest[] = [];
  readonly conns: Deno.Conn[] = [];
  readonly #inner: SupervisorBridgeFactory;

  constructor(inner: SupervisorBridgeFactory) {
    this.#inner = inner;
  }

  async openBridge(
    request: PrivilegedBridgeRequest,
    signal?: AbortSignal,
  ): Promise<Deno.Conn> {
    this.requests.push({ ...request });
    const conn = await this.#inner.openBridge(request, signal);
    this.conns.push(conn);
    return conn;
  }
}

/** Poll until a path is gone (the endpoint's socket file is unlinked on free). */
async function pollUntilAbsent(path: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!(await pathExists(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`endpoint ${path} was not freed within ${budgetMs}ms`);
}

/** A closed duplex reads EOF (null) or throws BadResource — never blocks. */
async function assertConnClosed(conn: Deno.Conn): Promise<void> {
  try {
    const count = await conn.read(new Uint8Array(1));
    assertEquals(count, null, "the closed bridge conn reads EOF");
  } catch (error) {
    assert(
      error instanceof Deno.errors.BadResource ||
        error instanceof Deno.errors.Interrupted,
      `the closed bridge conn read threw an unexpected error: ${error}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1) Full tunnel end to end against a real microVM
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "M7 tunnel: openTunnel → preface → burn → real vsock bridge → capnp agent (exec/fs/eval) → teardown",
  ignore: !inGuest,
  // The real VMM's outbound vsock conn and the jailer subprocess are torn down
  // inside the test; the sanitizers still verify nothing leaks.
}, async () => {
  const config = readVmConfig();
  const workDir = await Deno.makeTempDir({
    dir: config.workBase,
    prefix: "t7-",
  });
  const planner = buildPlanner(config, workDir);
  const store = new JsonFileSandboxStore(join(workDir, "state.json"));
  const core = new SupervisorCore({
    store,
    planner,
    reclaimHooks: [planner.reclaimHook],
    buildId: "m7-tunnel",
  });

  const sandboxId = "sbx-m7-tunnel";
  const executionId = "e-tun-1";
  const bootNonce = crypto.getRandomValues(new Uint8Array(32));

  let server: TunnelServer | undefined;
  try {
    // -- launch a real jailed VMM ------------------------------------------
    const status = await core.launch({
      sandboxId,
      executionId,
      artifactId: "artifact-golden",
      allocationId: "alloc-m7",
      bootNonce,
      idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
    });
    assertEquals(status.state, "running", "launch reaches running");
    const pid = status.pid!;
    assert(pidAlive(pid), "the real Firecracker VMM is alive");
    await core.probeAgent(executionId);

    const coordinates = planner.coordinatesFor(executionId)!;

    // -- stand up the tunnel exactly as HostControlCore.openTunnel does ----
    const bridge = new CapturingBridgeFactory(
      new SupervisorBridgeFactory(core),
    );
    const tickets = new SingleUseTicketStore();
    const authorizer = new TunnelAuthorizer(tickets, bridge);
    const binding = {
      sessionId: "lease-m7-vm",
      sandboxId,
      bootNonce: toHex(bootNonce),
      leaseGeneration: 1,
    };
    const issued = await tickets.issue(binding);
    const tunnelSock = join(workDir, "tun.sock");
    server = TunnelServer.open({
      authorizer,
      binding,
      bridgeRequest: {
        sandboxId,
        executionId,
        guestPort: coordinates.vsockPort,
      },
      listen: { transport: "unix", path: tunnelSock },
    });

    // -- dial: SBXTUN1 preface → ticket BURN → real vsock bridge → splice --
    const conn = await dialTunnel(server.endpoint, issued.ticket, {
      timeoutMs: TUNNEL_DIAL_MS,
    });
    assertEquals(bridge.requests.length, 1, "exactly one real bridge opened");
    assertEquals(bridge.requests[0].executionId, executionId);
    assertEquals(bridge.requests[0].guestPort, coordinates.vsockPort);
    const bridgeConn = bridge.conns[0];

    // -- drive a capnp SandboxAgent session THROUGH the tunnel -------------
    const session = await openAgentSession(conn, {
      credential: coordinates.credential,
      sandboxId,
      bootNonce,
      callerBuildId: "studiobox/m7-tunnel",
      timeoutMs: CALL_TIMEOUT_MS,
    });
    try {
      const { agent, wireClient } = session;

      // ping echoes the full UInt64 range across the splice.
      const nonce = 2n ** 63n + 7n;
      assertEquals(
        await agent.ping(nonce, { timeoutMs: CALL_TIMEOUT_MS }),
        nonce,
        "agent ping through the real tunnel",
      );

      const spawner = await agent.processes(CAP_CALL);
      const fs = await agent.filesystem(CAP_CALL);
      const deno = await agent.deno(CAP_CALL);

      // exec: sh -c "echo tunneled" → "tunneled\n"
      {
        const sink = new SinkCollector();
        const process = requireProcess(
          await spawner.spawn({
            spec: spec({ command: "/bin/sh", args: ["-c", "echo tunneled"] }),
            output: registerSink(wireClient, sink),
          }, CAP_CALL),
        );
        await sink.commit("stdout");
        assertEquals(
          new TextDecoder().decode(sink.bytes("stdout")),
          "tunneled\n",
          "exec stdout arrives through the tunnel",
        );
        const done = await process.wait({ timeoutMs: CALL_TIMEOUT_MS });
        assertEquals(done.status?.code, 0, "exec exits 0");
        await process.close();
      }

      // fs: write then read a file back through the plane.
      {
        const payload = new TextEncoder().encode("tunneled fs\n");
        const payloadSha = new Sha256().update(payload).digest();
        const path = "/home/app/tunnel.txt";
        const up = await fs.beginUpload({ path, mode: 0o644 }, CAP_CALL);
        assertEquals(up.which, "upload", up.error?.message);
        const upload = up.upload!;
        const sender = wire.createUploadChunkStreamSender(upload, {
          maxInFlight: DEFAULT_TRANSPORT_LIMITS.maxChunksInFlight,
          call: { timeoutMs: CALL_TIMEOUT_MS },
        });
        await sender.waitForCapacity();
        await sender.send({ sequence: 0n, data: payload });
        await sender.flush();
        const receipt = await upload.finish({
          totalBytes: BigInt(payload.byteLength),
          chunkCount: 1n,
          sha256: payloadSha,
        }, { timeoutMs: CALL_TIMEOUT_MS });
        assertEquals(receipt.which, "receipt", receipt.error?.message);
        await upload.close();

        const down = await fs.beginDownload(path, CAP_CALL);
        assertEquals(down.which, "reader", down.error?.message);
        const reader = down.reader!;
        const received: Uint8Array[] = [];
        let ended = false;
        while (!ended) {
          const r = await reader.read(64 * 1024, {
            timeoutMs: CALL_TIMEOUT_MS,
          });
          if (r.which === "chunk") {
            received.push(r.chunk!.data.slice());
            continue;
          }
          assertEquals(r.which, "end", r.error?.message);
          ended = true;
        }
        await reader.close();
        assertEquals(
          new TextDecoder().decode(concatBytes(received)),
          "tunneled fs\n",
          "the file round-trips through the tunnelled FileSystem plane",
        );
        assertEquals(
          toHex(new Sha256().update(concatBytes(received)).digest()),
          toHex(payloadSha),
        );
      }

      // deno repl: 1 + 2 == 3.
      {
        const replResult = await deno.openRepl([], CAP_CALL);
        assertEquals(replResult.which, "repl", replResult.error?.message);
        const repl = replResult.repl!;
        const result = await repl.eval("1 + 2", { timeoutMs: CALL_TIMEOUT_MS });
        assertEquals(result.which, "json", result.error?.message);
        const frame = JSON.parse(new TextDecoder().decode(result.json!)) as {
          value: unknown;
        };
        assertEquals(decodeReplValue(frame.value), 3, "deno.eval 1+2 == 3");
        await repl.close({ timeoutMs: CALL_TIMEOUT_MS });
        await repl[Symbol.asyncDispose]();
      }

      // -- while the tunnel is live, a REPLAY of the (burned) ticket is
      //    rejected before ACK and opens NO second bridge. Proof the ticket
      //    was burned by the first dial's authorizer.
      await assertRejects(
        () => dialTunnel(server!.endpoint, issued.ticket, { timeoutMs: 3_000 }),
        TunnelDialError,
        undefined,
        "a replayed (already-burned) ticket is rejected",
      );
      assertEquals(
        bridge.requests.length,
        1,
        "the replay opened no second bridge",
      );

      await spawner.close();
      await fs.close();
      await deno.close();
      await agent.close();
    } finally {
      await session[Symbol.asyncDispose]();
    }

    // -- teardown: closing the client end propagated EOF through the splice.
    await server.finished;
    assert(server.claimed, "the tunnel was claimed (ticket burned + bridge)");
    // The vsock bridge conn is closed (both directions torn down).
    await assertConnClosed(bridgeConn);
    // The endpoint / socket file is freed — nothing leaks.
    await pollUntilAbsent(tunnelSock);
    assertEquals(
      await pathExists(tunnelSock),
      false,
      "the tunnel endpoint socket file is unlinked on free",
    );

    // -- kill → VM gone, jail reclaimed, vsock unlinked --------------------
    await core.kill(executionId);
    assert(!pidAlive(pid), "the VMM is gone after kill");
    assertEquals(
      await pathExists(jailExecDir(workDir, executionId)),
      false,
      "the jail exec dir is reclaimed",
    );
    assertEquals(
      await pathExists(vsockHostPath(workDir, executionId)),
      false,
      "the guest vsock socket is unlinked",
    );
    // (Artifact refcount release is proven by the M5 cycle test; this suite may
    // share the golden set with a concurrent in-VM run, so the tunnel test does
    // not assert on the shared, cross-execution refcount.)
  } finally {
    if (server !== undefined) await server.close().catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2) A vsock bridge dial that races VMM death yields a typed error, not a hang
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "M7 tunnel: a bridge dial racing VMM death fails typed (TunnelDialError), never hangs",
  ignore: !inGuest,
}, async () => {
  const config = readVmConfig();
  const workDir = await Deno.makeTempDir({
    dir: config.workBase,
    prefix: "t7d-",
  });
  const planner = buildPlanner(config, workDir);
  const store = new JsonFileSandboxStore(join(workDir, "state.json"));
  const core = new SupervisorCore({
    store,
    planner,
    reclaimHooks: [planner.reclaimHook],
    buildId: "m7-tunnel-death",
  });

  const sandboxId = "sbx-m7-death";
  const executionId = "e-tun-die";
  const bootNonce = crypto.getRandomValues(new Uint8Array(32));

  let server: TunnelServer | undefined;
  try {
    const status = await core.launch({
      sandboxId,
      executionId,
      artifactId: "artifact-golden",
      allocationId: "alloc-m7d",
      bootNonce,
      idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
    });
    assertEquals(status.state, "running");
    const pid = status.pid!;
    await core.probeAgent(executionId);
    const coordinates = planner.coordinatesFor(executionId)!;

    const bridge = new CapturingBridgeFactory(
      new SupervisorBridgeFactory(core),
    );
    const tickets = new SingleUseTicketStore();
    const authorizer = new TunnelAuthorizer(tickets, bridge);
    const binding = {
      sessionId: "lease-m7-death",
      sandboxId,
      bootNonce: toHex(bootNonce),
      leaseGeneration: 1,
    };
    const issued = await tickets.issue(binding);
    const tunnelSock = join(workDir, "tun.sock");
    server = TunnelServer.open({
      authorizer,
      binding,
      bridgeRequest: {
        sandboxId,
        executionId,
        guestPort: coordinates.vsockPort,
      },
      listen: { transport: "unix", path: tunnelSock },
      // A generous dial budget so the endpoint stays open while the bridge dial
      // to the dead VMM resolves to a typed error rather than the budget firing.
      ttlMs: 30_000,
    });

    // Kill the VMM out from under the still-"live" record (no core.kill, so the
    // supervisor has not reconciled the death away): the next bridge dial races
    // a dead guest.
    Deno.kill(pid, "SIGKILL");
    const gone = Date.now() + 10_000;
    while (pidAlive(pid) && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(!pidAlive(pid), "the VMM is dead before the racing dial");

    // The dial: the ticket burns, then the bridge dial to the dead guest must
    // surface a TYPED tunnel error within a bounded window — never hang.
    const start = Date.now();
    await assertRejects(
      () => dialTunnel(server!.endpoint, issued.ticket, { timeoutMs: 12_000 }),
      TunnelDialError,
      undefined,
      "a bridge dial racing VMM death fails typed",
    );
    const elapsed = Date.now() - start;
    assert(
      elapsed < 20_000,
      `the racing dial returned a typed error within budget, not a hang (${elapsed}ms)`,
    );
    // No live bridge conn survived the failed dial.
    assertEquals(bridge.conns.length, 0, "no vsock bridge conn leaked");
  } finally {
    if (server !== undefined) await server.close().catch(() => {});
    // Reclaim the jail even though the VMM is already dead.
    await core.kill(executionId).catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});
