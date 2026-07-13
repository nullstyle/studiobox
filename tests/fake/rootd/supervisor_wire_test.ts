// M2-wire: full capnp round-trips of schema/supervisor.capnp over a real
// Unix-domain socket, against a real SupervisorCore driving the fake
// VMM/jailer shims from @nullstyle/firecracker/testing (macOS-safe; no KVM).
//
// Covered here:
//   - bootstrap flow: negotiate (ContractIdentity from the REAL
//     compat/wire.json schema bundle hash) -> authenticate (32-byte token,
//     constant-time compare) -> Supervisor capability;
//   - launch/status/usage/probeAgent/openBridge/kill/health/ping round-trips
//     through the GENERATED codecs and result unions;
//   - reconcile refusal mid-launch surfacing as the typed `unavailable`
//     SbxError through the wire;
//   - gate behavior: pre-auth capability request refused (typed) and
//     gate-latching; a live Supervisor stub goes inert once the gate
//     latches (per-method re-assert, defense in depth); wrong token
//     rate-limited to the gate's failure budget; authenticate-before-
//     negotiate refused; tampered schema hash rejected at negotiation;
//   - transport hygiene: a client that disconnects mid-call leaves the
//     accept loop healthy for the next client (pinned M1 ownership contract:
//     every client transport wires onClose -> wire-client close, and
//     onError);
//   - capability handout contract (capnp 0.3.0, schema-pure):
//     `SupervisorBootstrap.supervisor` returns a FRESH wire-managed
//     `Supervisor` capability per call; releasing one handout drops only
//     its own export (the bootstrap root and later handouts keep working),
//     and the released stub itself is dead. Clients over `RpcWireClient`
//     must finish the handout call with `releaseResultCaps: false` (the
//     CAP_CALL accommodation below; see the CLIENT CONTRACT note in
//     src/rootd/service.ts).

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  makeFakeJailerBin,
  makeFakeVmmBin,
} from "@nullstyle/firecracker/testing";
import {
  type RpcAcceptedTransport,
  RpcWireClient,
  TcpTransport,
} from "@nullstyle/capnp";
import {
  type BridgeRequest as WireBridgeRequest,
  type LaunchRequest as WireLaunchRequest,
  type RpcStub,
  type Supervisor,
  SupervisorBootstrap,
} from "../../../src/wire/generated/supervisor_types.ts";
import {
  buildSupervisorContractIdentity,
  protocolOfferToWire,
  SUPERVISOR_FEATURE_BITS,
  type SupervisorCompatIdentitySource,
} from "../../../src/rootd/service.ts";
import {
  startSupervisorServer,
  type SupervisorServerHandle,
  UdsSupervisorAcceptSource,
} from "../../../src/rootd/main.ts";
import {
  SupervisorCore,
  type SupervisorLaunchPlanner,
} from "../../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";
import {
  type ContractIdentity,
  DEFAULT_TRANSPORT_LIMITS,
} from "../../../src/wire/contract.ts";
import { BRIDGE_SOCKET_ROOT } from "../../../src/wire/supervisor.ts";

const TIMEOUT_MS = 5_000;
// Launch spans jail staging + fake VMM boot + readiness probing.
const LAUNCH_TIMEOUT_MS = 15_000;

/**
 * Options for calls whose RESULTS carry a fresh capability (here: only
 * `bootstrap.supervisor()`). The server exports the handout wire-managed
 * (its only wire reference is the one the Return frame mints), so the
 * client must finish the question with `releaseResultCaps: false` to
 * retain the capability — `RpcWireClient.finish` defaults to eager
 * release, which would drop the export before its first use. Stub
 * `close()` releases the retained reference.
 */
const CAP_CALL = {
  timeoutMs: TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
// Harness
// ---------------------------------------------------------------------------

interface PlannerControls {
  /** Resolves when the NEXT gated resolve() begins. */
  readonly started: Deferred<void>;
  /** Release the gated resolve. */
  readonly release: Deferred<void>;
  /** Gate exactly one upcoming resolve() call. */
  armGate(): void;
}

interface WireHarness {
  readonly dir: string;
  readonly core: SupervisorCore;
  readonly identity: ContractIdentity;
  readonly credential: Uint8Array;
  readonly server: SupervisorServerHandle;
  readonly socketPath: string;
  readonly planner: PlannerControls;
  readonly connectionErrors: unknown[];
}

async function loadCompat(): Promise<SupervisorCompatIdentitySource> {
  const text = await Deno.readTextFile(
    new URL("../../../compat/wire.json", import.meta.url),
  );
  return JSON.parse(text) as SupervisorCompatIdentitySource;
}

async function withWireHarness(
  run: (harness: WireHarness) => Promise<void>,
): Promise<void> {
  // Short base path: the jail path prefixes in-jail Unix socket paths and
  // the server socket itself (sun_path ~104 bytes on macOS).
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-wr-" });
  let server: SupervisorServerHandle | undefined;
  let core: SupervisorCore | undefined;
  try {
    const firecrackerBin = await makeFakeVmmBin(dir, "ready");
    const jailerBin = await makeFakeJailerBin(dir);
    const kernel = join(dir, "vmlinux-src");
    await Deno.writeTextFile(kernel, "wire test kernel fixture\n");
    const chrootBaseDir = join(dir, "j");

    // `pending` gates exactly one upcoming resolve(); `armed` keeps the
    // deferred pair readable AFTER the gated resolve consumed it (the
    // launch can reach the planner before the test reads `started`).
    type PlannerGate = { started: Deferred<void>; release: Deferred<void> };
    let pending: PlannerGate | null = null;
    let armed: PlannerGate | null = null;
    const controls: PlannerControls = {
      get started() {
        if (armed === null) throw new Error("planner gate was never armed");
        return armed.started;
      },
      get release() {
        if (armed === null) throw new Error("planner gate was never armed");
        return armed.release;
      },
      armGate() {
        armed = { started: deferred<void>(), release: deferred<void>() };
        pending = armed;
      },
    };
    const planner: SupervisorLaunchPlanner = {
      resolve: async () => {
        if (pending !== null) {
          const taken = pending;
          pending = null;
          taken.started.resolve();
          await taken.release.promise;
        }
        return {
          jailer: {
            jailerBin,
            firecrackerBin,
            uid: Deno.uid() ?? 0,
            gid: Deno.gid() ?? 0,
            chrootBaseDir,
          },
          stage: [{ hostPath: kernel, jailPath: "/vmlinux" }],
          config: { boot_source: { kernel_image_path: "/vmlinux" } },
          readinessTimeoutMs: 10_000,
        };
      },
    };

    core = new SupervisorCore({
      store: new JsonFileSandboxStore(join(dir, "state.json")),
      planner,
      buildId: "wire-test",
    });
    const identity = await buildSupervisorContractIdentity(
      await loadCompat(),
      { buildId: "wire-test" },
    );
    const credential = crypto.getRandomValues(new Uint8Array(32));
    const socketPath = join(dir, "s.sock");
    const connectionErrors: unknown[] = [];
    server = await startSupervisorServer({
      socketPath,
      api: core,
      identity,
      credential,
      onConnectionError: (error) => connectionErrors.push(error),
    });

    await run({
      dir,
      core,
      identity,
      credential,
      server,
      socketPath,
      planner: controls,
      connectionErrors,
    });
  } finally {
    await server?.close().catch(() => {});
    // Reap anything a test launched (destructive restart-policy sweep) so
    // no fake VMM outlives the test process.
    await core?.reconcile().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

interface WireClient {
  readonly bootstrap: SupervisorBootstrap;
  readonly wireClient: RpcWireClient;
  readonly transport: TcpTransport;
  close(): Promise<void>;
}

/** Dial the server UDS with the pinned onClose/onError ownership wiring. */
async function dialBootstrap(socketPath: string): Promise<WireClient> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  let wireClient: RpcWireClient | null = null;
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: TIMEOUT_MS,
    // Pinned M1 ownership contract: remote EOF settles in-flight calls only
    // when the owner closes the wire client; out-of-band conn failures must
    // be observed or they escape as global unhandled rejections.
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => {},
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: TIMEOUT_MS });
  const owner = wireClient;
  const bootstrap = await SupervisorBootstrap.bootstrapClient(owner, {
    timeoutMs: TIMEOUT_MS,
  });
  return {
    bootstrap,
    wireClient: owner,
    transport,
    close: async () => {
      await owner.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

interface AuthenticatedClient extends WireClient {
  readonly supervisor: RpcStub<Supervisor>;
}

/** Full handshake: negotiate -> authenticate -> Supervisor capability. */
async function openSupervisor(
  harness: WireHarness,
): Promise<AuthenticatedClient> {
  const client = await dialBootstrap(harness.socketPath);
  const negotiated = await client.bootstrap.negotiate(
    protocolOfferToWire({
      identity: harness.identity,
      limits: DEFAULT_TRANSPORT_LIMITS,
      requiredFeatureBits: SUPERVISOR_FEATURE_BITS,
    }),
    { timeoutMs: TIMEOUT_MS },
  );
  assertEquals(negotiated.which, "accepted", "handshake must negotiate");
  const authenticated = await client.bootstrap.authenticate(
    harness.credential.slice(),
    { timeoutMs: TIMEOUT_MS },
  );
  assertEquals(authenticated.which, "accepted", "handshake must authenticate");
  // The schema-pure handout: a fresh wire-managed capability per call.
  const supervisor = await client.bootstrap.supervisor(CAP_CALL);
  return { ...client, supervisor };
}

function launchRequest(
  sandboxId: string,
  executionId: string,
): WireLaunchRequest {
  return {
    sandboxId,
    executionId,
    artifactId: "artifact-fixture",
    allocationId: "alloc-fixture",
    bootNonce: crypto.getRandomValues(new Uint8Array(32)),
    idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
    // Unrestricted egress (the default): allowNetSet=false, so rootd ignores
    // the empty allowNet and grants full internet.
    allowNet: [],
    allowNetSet: false,
    netless: false,
    vcpus: 2,
  };
}

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

Deno.test("supervisor wire: launch/status/usage/probe/bridge/kill/health/ping round-trip over UDS", async () => {
  await withWireHarness(async (harness) => {
    const client = await openSupervisor(harness);
    try {
      const sup = client.supervisor;

      // ping: liveness echo through the generated bigint plumbing.
      assertEquals(await sup.ping(42n, { timeoutMs: TIMEOUT_MS }), 42n);

      // launch: journal-before-spawn through the real core + fake VMM.
      const launched = await sup.launch(
        launchRequest("sbx-wire-a", "exec-wa"),
        { timeoutMs: LAUNCH_TIMEOUT_MS },
      );
      assertEquals(launched.which, "status");
      assertExists(launched.status);
      assertEquals(launched.status.sandboxId, "sbx-wire-a");
      assertEquals(launched.status.executionId, "exec-wa");
      assertEquals(launched.status.state, "running");
      assert(launched.status.pid > 0, "a live VMM pid crosses the wire");

      // status: journal + liveness view.
      const status = await sup.status("exec-wa", { timeoutMs: TIMEOUT_MS });
      assertEquals(status.which, "status");
      assertEquals(status.status?.state, "running");
      assertEquals(status.status?.pid, launched.status.pid);

      // usage: committed zero shape until M10/M11 accounting.
      const usage = await sup.usage("exec-wa", { timeoutMs: TIMEOUT_MS });
      assertEquals(usage.which, "usage");
      assertEquals(usage.usage, {
        cpuTimeMicros: 0n,
        memoryCurrentBytes: 0n,
        memoryPeakBytes: 0n,
        diskBytes: 0n,
        rxBytes: 0n,
        txBytes: 0n,
      });

      // probeAgent: ready arm for a live machine (vsock dial lands M5/M7).
      const probe = await sup.probeAgent("exec-wa", { timeoutMs: TIMEOUT_MS });
      assertEquals(probe.which, "ready");

      // health: one active machine, no bridges, not reconciling.
      const health = await sup.health({ timeoutMs: TIMEOUT_MS });
      assertEquals(health.which, "health");
      assertEquals(health.health?.buildId, "wire-test");
      assertEquals(health.health?.activeMachines, 1);
      assertEquals(health.health?.activeBridges, 0);
      assertEquals(health.health?.reconciling, false);

      // openBridge: a one-shot grant struct comes back typed.
      const bridgeRequest: WireBridgeRequest = {
        sandboxId: "sbx-wire-a",
        executionId: "exec-wa",
        leaseId: "lease-1",
        leaseGeneration: 1n,
        tunnelNonce: crypto.getRandomValues(new Uint8Array(32)),
        expiresAtUnixMs: BigInt(Date.now() + 10_000),
      };
      const bridge = await sup.openBridge(bridgeRequest, {
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(bridge.which, "grant");
      assertExists(bridge.grant);
      assert(bridge.grant.bridgeId.startsWith("b-"));
      assert(bridge.grant.socketPath.startsWith(BRIDGE_SOCKET_ROOT));
      assertEquals(bridge.grant.bridgeCredential.byteLength, 32);
      assertEquals(bridge.grant.agentCredential.byteLength, 32);
      assertEquals(bridge.grant.expiresAtUnixMs, bridgeRequest.expiresAtUnixMs);

      // kill: SIGKILL + full reclaim, then the terminal journal view.
      const killed = await sup.kill("exec-wa", {
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      assertEquals(killed.which, "ok");
      const terminal = await sup.status("exec-wa", { timeoutMs: TIMEOUT_MS });
      assertEquals(terminal.which, "status");
      assertEquals(terminal.status?.state, "exited");
      assertEquals(terminal.status?.reason, "kill");

      // The wire error mapping for a vanished execution.
      const missing = await sup.status("exec-none", { timeoutMs: TIMEOUT_MS });
      assertEquals(missing.which, "error");
      assertEquals(missing.error?.code, "notFound");
      assertEquals(
        missing.error?.details,
        [{ key: "supervisorCode", value: "SBX_SUP_NOT_FOUND" }],
      );

      // Duplicate sandbox id maps onto alreadyExists.
      await sup.launch(launchRequest("sbx-wire-b", "exec-wb"), {
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      const duplicate = await sup.launch(
        launchRequest("sbx-wire-b", "exec-wb2"),
        { timeoutMs: LAUNCH_TIMEOUT_MS },
      );
      assertEquals(duplicate.which, "error");
      assertEquals(duplicate.error?.code, "alreadyExists");
      const cleanup = await sup.kill("exec-wb", {
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      assertEquals(cleanup.which, "ok");

      // Wire-boundary validation refuses garbage before the core runs.
      const invalid = await sup.launch(
        {
          ...launchRequest("sbx-wire-c", "exec-wc"),
          bootNonce: new Uint8Array(3),
        },
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(invalid.which, "error");
      assertEquals(invalid.error?.code, "invalidArgument");
    } finally {
      await client.close();
    }
  });
});

Deno.test("supervisor wire: reconcile refusal mid-launch surfaces the typed unavailable error", async () => {
  await withWireHarness(async (harness) => {
    const clientA = await openSupervisor(harness);
    const clientB = await openSupervisor(harness);
    try {
      harness.planner.armGate();
      const pendingLaunch = clientA.supervisor.launch(
        launchRequest("sbx-wire-r", "exec-wr"),
        { timeoutMs: LAUNCH_TIMEOUT_MS },
      );
      await withTimeout(
        harness.planner.started.promise,
        TIMEOUT_MS,
        "gated launch reaching the planner",
      );

      // The launch is in flight: the sweep must refuse, typed, via capnp.
      const refused = await clientB.supervisor.reconcile({
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(refused.which, "error");
      assertEquals(refused.error?.code, "unavailable");
      assertEquals(refused.error?.retryable, true);
      assertEquals(
        refused.error?.details,
        [{ key: "supervisorCode", value: "SBX_SUP_UNAVAILABLE" }],
      );

      harness.planner.release.resolve();
      const launched = await withTimeout(
        pendingLaunch,
        LAUNCH_TIMEOUT_MS,
        "released launch settlement",
      );
      assertEquals(launched.which, "status");

      // Once the operation settles, the sweep is accepted and reaps the
      // machine (destructive restart policy), and the summary crosses the
      // wire intact.
      const swept = await clientB.supervisor.reconcile({
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      assertEquals(swept.which, "summary");
      assertEquals(swept.summary?.examined, 1);
      assertEquals(swept.summary?.killed, 1);
      assertEquals(swept.summary?.reclaimed, 1);
      assertEquals(swept.summary?.quarantined, 0);
      assertEquals(swept.summary?.failures, []);
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Bootstrap gate
// ---------------------------------------------------------------------------

Deno.test("supervisor wire gate: pre-auth capability request is refused and latches the gate closed", async () => {
  await withWireHarness(async (harness) => {
    const client = await dialBootstrap(harness.socketPath);
    try {
      const negotiated = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: harness.identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: SUPERVISOR_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(negotiated.which, "accepted");

      // Capability request before authenticate: typed rejection, and the
      // out-of-order call latches the gate closed. (No pre-auth Supervisor
      // capability exists to probe — the handout IS the only wire path.)
      await assertRejects(() => client.bootstrap.supervisor(CAP_CALL));

      // Even the correct token cannot reopen a latched gate.
      const late = await client.bootstrap.authenticate(
        harness.credential.slice(),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(late.which, "error");
      assertEquals(late.error?.code, "failedPrecondition");
    } finally {
      await client.close();
    }
  });
});

Deno.test("supervisor wire gate: authenticate before negotiate fails closed", async () => {
  await withWireHarness(async (harness) => {
    const client = await dialBootstrap(harness.socketPath);
    try {
      const early = await client.bootstrap.authenticate(
        harness.credential.slice(),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(early.which, "error");
      assertEquals(early.error?.code, "failedPrecondition");

      // The out-of-order call latched the gate: negotiation is refused too.
      const negotiated = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: harness.identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: SUPERVISOR_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(negotiated.which, "error");
      assertEquals(negotiated.error?.code, "failedPrecondition");
    } finally {
      await client.close();
    }
  });
});

Deno.test("supervisor wire gate: wrong token is rate-limited to the gate's failure budget", async () => {
  await withWireHarness(async (harness) => {
    const client = await dialBootstrap(harness.socketPath);
    try {
      const negotiated = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: harness.identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: SUPERVISOR_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(negotiated.which, "accepted");

      const wrong = crypto.getRandomValues(new Uint8Array(32));
      for (const attempt of [1, 2]) {
        const result = await client.bootstrap.authenticate(wrong.slice(), {
          timeoutMs: TIMEOUT_MS,
        });
        assertEquals(result.which, "error", `attempt ${attempt}`);
        assertEquals(result.error?.code, "unauthenticated");
        assertEquals(result.error?.retryable, true, `attempt ${attempt}`);
      }
      // Third failure exhausts the budget: the gate closes.
      const third = await client.bootstrap.authenticate(wrong.slice(), {
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(third.which, "error");
      assertEquals(third.error?.code, "unauthenticated");
      assertEquals(third.error?.retryable, false);

      // Post-close, even the REAL token is refused and no capability exists.
      const late = await client.bootstrap.authenticate(
        harness.credential.slice(),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(late.which, "error");
      assertEquals(late.error?.code, "failedPrecondition");
      await assertRejects(() =>
        client.bootstrap.supervisor({ timeoutMs: TIMEOUT_MS })
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test("supervisor wire gate: a tampered schema bundle hash rejects at negotiation", async () => {
  await withWireHarness(async (harness) => {
    const client = await dialBootstrap(harness.socketPath);
    try {
      const tamperedHash = harness.identity.schemaHash.slice();
      tamperedHash[0] ^= 0xff;
      const rejected = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: { ...harness.identity, schemaHash: tamperedHash },
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: SUPERVISOR_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(rejected.which, "error");
      assertEquals(rejected.error?.code, "incompatibleSchema");

      // The rejection latched the gate: nothing downstream is reachable.
      const late = await client.bootstrap.authenticate(
        harness.credential.slice(),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(late.which, "error");
      assertEquals(late.error?.code, "failedPrecondition");
      await assertRejects(() =>
        client.bootstrap.supervisor({ timeoutMs: TIMEOUT_MS })
      );
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Capability handout contract (see the handout note in service.ts)
// ---------------------------------------------------------------------------

Deno.test("supervisor wire handout: bootstrap.supervisor() mints a fresh wire-managed capability per call", async () => {
  await withWireHarness(async (harness) => {
    const client = await dialBootstrap(harness.socketPath);
    try {
      const negotiated = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: harness.identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: SUPERVISOR_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(negotiated.which, "accepted");
      const authenticated = await client.bootstrap.authenticate(
        harness.credential.slice(),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(authenticated.which, "accepted");

      // The schema-pure handout: a FRESHLY exported capability in the
      // method return (capnp 0.3.0 relays host-minted exports — a timeout
      // here means the fresh-export return path regressed).
      const sup = await client.bootstrap.supervisor(CAP_CALL);
      assertEquals(await sup.ping(9n, { timeoutMs: TIMEOUT_MS }), 9n);
      const health = await sup.health({ timeoutMs: TIMEOUT_MS });
      assertEquals(health.which, "health");

      // Releasing one handout drops only ITS export: the bootstrap root
      // still serves, and a second handout mints a fresh working
      // capability.
      await sup.close();
      const late = await client.bootstrap.supervisor(CAP_CALL);
      assertEquals(await late.ping(13n, { timeoutMs: TIMEOUT_MS }), 13n);
      const lateHealth = await late.health({ timeoutMs: TIMEOUT_MS });
      assertEquals(lateHealth.which, "health");
      await late.close();

      // Nothing on this path may fail silently server-side.
      assertEquals(harness.connectionErrors, []);

      // The wire-managed release is REAL: the closed stub's export is gone,
      // so calling through it fails typed instead of answering.
      await assertRejects(() => sup.ping(15n, { timeoutMs: TIMEOUT_MS }));
    } finally {
      await client.close();
    }
  });
});

Deno.test("supervisor wire gate: a live Supervisor stub goes inert when the gate latches closed (defense in depth)", async () => {
  await withWireHarness(async (harness) => {
    const client = await openSupervisor(harness);
    try {
      // Sanity: the authenticated handout works.
      assertEquals(
        await client.supervisor.ping(1n, { timeoutMs: TIMEOUT_MS }),
        1n,
      );

      // An out-of-order bootstrap call (authenticate AFTER authenticated)
      // latches the connection gate closed...
      const repeat = await client.bootstrap.authenticate(
        harness.credential.slice(),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(repeat.which, "error");
      assertEquals(repeat.error?.code, "failedPrecondition");

      // ...and every method on the ALREADY-live stub re-asserts the gate:
      // result-union methods answer permissionDenied, ping rejects typed.
      const launch = await client.supervisor.launch(
        launchRequest("sbx-wire-d", "exec-wd"),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(launch.which, "error");
      assertEquals(launch.error?.code, "permissionDenied");
      await assertRejects(() =>
        client.supervisor.ping(2n, { timeoutMs: TIMEOUT_MS })
      );
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Transport hygiene
// ---------------------------------------------------------------------------

Deno.test("supervisor wire hygiene: client disconnect mid-call leaves the accept loop healthy", async () => {
  await withWireHarness(async (harness) => {
    // Client A parks a launch inside the planner, then vanishes.
    const clientA = await openSupervisor(harness);
    harness.planner.armGate();
    const abandoned = clientA.supervisor
      .launch(launchRequest("sbx-wire-h", "exec-wh"), {
        timeoutMs: LAUNCH_TIMEOUT_MS,
      })
      .then(() => null, (error: unknown) => error);
    await withTimeout(
      harness.planner.started.promise,
      TIMEOUT_MS,
      "gated launch reaching the planner",
    );
    // Abrupt disconnect: close the raw transport out from under the call
    // (the wired onClose then closes the stub, settling the local promise).
    await clientA.transport.close();
    const abandonedOutcome = await withTimeout(
      abandoned,
      TIMEOUT_MS,
      "abandoned call settlement after transport close",
    );
    assert(
      abandonedOutcome instanceof Error,
      "the abandoned call settles with a typed error, never hangs",
    );

    // The server-side launch is still running; release it so the core
    // finishes journaling (nobody is listening for the response).
    harness.planner.release.resolve();

    // A fresh client on the SAME accept loop completes a full cycle.
    const clientB = await openSupervisor(harness);
    try {
      assertEquals(
        await clientB.supervisor.ping(7n, { timeoutMs: TIMEOUT_MS }),
        7n,
      );
      const launched = await clientB.supervisor.launch(
        launchRequest("sbx-wire-i", "exec-wi"),
        { timeoutMs: LAUNCH_TIMEOUT_MS },
      );
      assertEquals(launched.which, "status");
      assertEquals(launched.status?.state, "running");
      const killed = await clientB.supervisor.kill("exec-wi", {
        timeoutMs: LAUNCH_TIMEOUT_MS,
      });
      assertEquals(killed.which, "ok");

      assertEquals(harness.server.stats.acceptedConnections, 2);
      assertEquals(harness.server.stats.failedConnections, 0);
    } finally {
      await clientB.close();
      await clientA.close().catch(() => {});
    }
  });
});

Deno.test("supervisor wire: ping round-trips a full-width UInt64 nonce exactly", async () => {
  await withWireHarness(async (harness) => {
    const client = await openSupervisor(harness);
    try {
      // The nonce is `UInt64` on the wire (supervisor.capnp ping @9); a
      // value above 2^53 would be corrupted if the domain plumbing ever
      // rounded it through a JS number. It must survive bit-for-bit.
      const nonce = 2n ** 63n + 5n;
      assertEquals(
        await client.supervisor.ping(nonce, { timeoutMs: TIMEOUT_MS }),
        nonce,
      );
      // And the extreme value (2^64 - 1) round-trips too.
      const max = 2n ** 64n - 1n;
      assertEquals(
        await client.supervisor.ping(max, { timeoutMs: TIMEOUT_MS }),
        max,
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test(
  "supervisor wire hygiene: rapid connect-then-close peers leave the accept loop healthy (accept DoS)",
  async () => {
    // Same DoS class as the guest agent: a peer that connects and immediately
    // closes must never tear the supervisor accept loop down. Hammer the
    // socket, then prove a fresh client still completes a full round-trip and
    // that nothing escaped as a global unhandled rejection.
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason);
      event.preventDefault();
    };
    globalThis.addEventListener("unhandledrejection", onRejection);
    try {
      await withWireHarness(async (harness) => {
        for (let i = 0; i < 60; i++) {
          const conn = await Deno.connect({
            transport: "unix",
            path: harness.socketPath,
          });
          conn.close();
        }
        await new Promise((resolve) => setTimeout(resolve, 250));

        const client = await openSupervisor(harness);
        try {
          const nonce = 2n ** 63n + 5n;
          assertEquals(
            await client.supervisor.ping(nonce, { timeoutMs: TIMEOUT_MS }),
            nonce,
          );
        } finally {
          await client.close();
        }
        assertEquals(
          rejections.length,
          0,
          `no out-of-band close should escape as a global unhandled rejection (saw ${rejections.length})`,
        );
      });
    } finally {
      globalThis.removeEventListener("unhandledrejection", onRejection);
    }
  },
);

Deno.test(
  "supervisor accept source survives a transient accept fault and keeps accepting",
  async () => {
    // rootd's per-connection setup cadence hides the socket-level connect-
    // then-close race on macOS, so drive the exact fault deterministically: a
    // listener whose accept() throws a transient EINVAL twice before handing
    // over a real conn, then reports EOF. A resilient accept loop reports each
    // transient fault, skips it, and STILL yields the good connection; the
    // pre-fix loop re-threw the first EINVAL and died (rejecting the largely-
    // unawaited accept-loop promise as a global unhandled rejection).
    const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-acc-" });
    const realPath = join(dir, "real.sock");
    const realListener = Deno.listen({ transport: "unix", path: realPath });
    const connectPromise = Deno.connect({
      transport: "unix",
      path: realPath,
    });
    const serverConn = await realListener.accept();
    const clientConn = await connectPromise;
    realListener.close();

    const acceptErrors: unknown[] = [];
    let call = 0;
    const fakeListener = {
      accept(): Promise<Deno.Conn> {
        call++;
        if (call <= 2) {
          // The macOS connect-then-close accept race surfaces as EINVAL.
          return Promise.reject(
            new TypeError("Invalid argument (os error 22)"),
          );
        }
        if (call === 3) return Promise.resolve(serverConn);
        // After the good conn, behave as a closed listener to end the loop.
        return Promise.reject(new Deno.errors.BadResource("listener closed"));
      },
      close(): void {},
      addr: { transport: "unix", path: realPath } as Deno.Addr,
      // deno-lint-ignore no-explicit-any
    } as any as Deno.Listener;

    const source = new UdsSupervisorAcceptSource(realPath, {
      listener: fakeListener,
      onAcceptError: (error) => acceptErrors.push(error),
    });

    const yielded: RpcAcceptedTransport[] = [];
    for await (const accepted of source.accept()) {
      yielded.push(accepted);
    }

    assertEquals(
      acceptErrors.length,
      2,
      "both transient accept faults were reported, neither was fatal",
    );
    assertEquals(
      yielded.length,
      1,
      "the loop survived the transient faults and still yielded the real conn",
    );

    for (const accepted of yielded) {
      await Promise.resolve(accepted.transport.close()).catch(() => {});
    }
    try {
      clientConn.close();
    } catch {
      // Already closed by the transport teardown.
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  },
);
