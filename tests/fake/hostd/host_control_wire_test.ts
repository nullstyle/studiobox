// M6: full capnp round-trips of schema/host_control.capnp over a real
// Unix-domain socket, against a HostControlCore backed by an in-process fake
// RootdGateway + a deterministic fake clock (macOS-safe; no VMM/rootd/KVM).
//
// Covered here:
//   - bootstrap flow: negotiate (host ContractIdentity from the REAL
//     compat/wire.json bundle) -> authenticate (32-byte token, constant time)
//     -> HostControl capability;
//   - create: capacity committed, lease issued, sandbox observable via
//     list/metadata/capacity; labels + deadline round-trip;
//   - a duration-timeout sandbox is killed at its deadline (fake clock) and its
//     capacity reclaimed;
//   - a session-timeout sandbox is killed when the creating connection closes;
//   - over-capacity create fails fast with the hostCapacity SbxError + the
//     exhausted-dimension detail;
//   - attach from a SECOND connection observes the first's sandbox WITHOUT a new
//     lease;
//   - a hostd restart (revokeAll) revokes leases + tickets silently (no rootd
//     kills);
//   - the gate: pre-auth host() refused + latched, wrong token rate-limited,
//     tampered negotiation identity rejected.

import { assert, assertEquals, assertRejects } from "@std/assert";
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
import {
  type HostControlServerHandle,
  startHostControlServer,
} from "../../../src/hostd/main.ts";
import { HostControlCore } from "../../../src/hostd/control_core.ts";
import {
  CapacityLedger,
  type HostBudget,
} from "../../../src/hostd/capacity.ts";
import type { Clock, ClockTimer } from "../../../src/hostd/leases.ts";
import { SingleUseTicketStore } from "../../../src/security/tickets.ts";
import type { RootdGateway } from "../../../src/hostd/supervisor_client.ts";
import type {
  SupervisorLaunchRequest,
  SupervisorMachineStatus,
  SupervisorMachineUsage,
  SupervisorReconcileSummary,
} from "../../../src/rootd/supervisor_core_api.ts";
import {
  type ContractIdentity,
  DEFAULT_TRANSPORT_LIMITS,
} from "../../../src/wire/contract.ts";

const TIMEOUT_MS = 5_000;
const CAP_CALL = {
  timeoutMs: TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A deterministic clock whose timers fire only when a test advances it. */
class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<
    number,
    { fireAt: number; callback: () => void }
  >();

  constructor(startUnixMs = 1_000_000) {
    this.#now = startUnixMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fireAtUnixMs: number, callback: () => void): ClockTimer {
    const token = this.#seq++;
    this.#timers.set(token, { fireAt: fireAtUnixMs, callback });
    return { cancel: () => void this.#timers.delete(token) };
  }

  advance(deltaMs: number): void {
    const target = this.#now + deltaMs;
    for (;;) {
      let nextToken: number | undefined;
      let nextFireAt = Infinity;
      for (const [token, timer] of this.#timers) {
        if (timer.fireAt <= target && timer.fireAt < nextFireAt) {
          nextFireAt = timer.fireAt;
          nextToken = token;
        }
      }
      if (nextToken === undefined) break;
      const timer = this.#timers.get(nextToken)!;
      this.#timers.delete(nextToken);
      this.#now = Math.max(this.#now, timer.fireAt);
      timer.callback();
    }
    this.#now = target;
  }
}

/** An in-process RootdGateway that records launches + kills. */
class FakeGateway implements RootdGateway {
  readonly launched: SupervisorLaunchRequest[] = [];
  readonly killed: string[] = [];

  launch(request: SupervisorLaunchRequest): Promise<SupervisorMachineStatus> {
    this.launched.push(request);
    return Promise.resolve({
      sandboxId: request.sandboxId,
      executionId: request.executionId,
      state: "running",
      pid: 1234,
    });
  }

  status(executionId: string): Promise<SupervisorMachineStatus> {
    return Promise.resolve({
      sandboxId: "sbx-loc-x",
      executionId,
      state: "running",
    });
  }

  usage(_executionId: string): Promise<SupervisorMachineUsage> {
    return Promise.resolve({
      cpuTimeMicros: 11,
      memoryCurrentBytes: 22,
      memoryPeakBytes: 33,
      diskBytes: 44,
      rxBytes: 55,
      txBytes: 66,
    });
  }

  kill(executionId: string): Promise<void> {
    this.killed.push(executionId);
    return Promise.resolve();
  }

  reconcile(): Promise<SupervisorReconcileSummary> {
    return Promise.resolve({
      examined: 0,
      killed: 0,
      reclaimed: 0,
      quarantined: 0,
      failures: [],
    });
  }

  ping(nonce: bigint): Promise<bigint> {
    return Promise.resolve(nonce);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly core: HostControlCore;
  readonly gateway: FakeGateway;
  readonly clock: FakeClock;
  readonly capacity: CapacityLedger;
  readonly tickets: SingleUseTicketStore;
  readonly identity: ContractIdentity;
  readonly credential: Uint8Array;
  readonly server: HostControlServerHandle;
  readonly socketPath: string;
}

async function loadCompat(): Promise<HostCompatIdentitySource> {
  const text = await Deno.readTextFile(
    new URL("../../../compat/wire.json", import.meta.url),
  );
  return JSON.parse(text) as HostCompatIdentitySource;
}

async function withHarness(
  run: (h: Harness) => Promise<void>,
  options: { budget?: Partial<HostBudget> } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-hc-" });
  let server: HostControlServerHandle | undefined;
  try {
    const gateway = new FakeGateway();
    const clock = new FakeClock();
    const capacity = new CapacityLedger(
      options.budget === undefined ? {} : { budget: options.budget },
    );
    const tickets = new SingleUseTicketStore({ now: () => clock.now() });
    const core = new HostControlCore({ gateway, clock, capacity, tickets });
    const identity = await buildHostContractIdentity(await loadCompat(), {
      buildId: "hostd-wire-test",
    });
    const credential = crypto.getRandomValues(new Uint8Array(32));
    const socketPath = join(dir, "h.sock");
    server = await startHostControlServer({
      listen: { kind: "unix", socketPath },
      core,
      identity,
      credential,
    });
    await run({
      core,
      gateway,
      clock,
      capacity,
      tickets,
      identity,
      credential,
      server,
      socketPath,
    });
  } finally {
    await server?.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

interface Client {
  readonly bootstrap: HostBootstrap;
  readonly wireClient: RpcWireClient;
  readonly transport: TcpTransport;
  close(): Promise<void>;
}

async function dial(socketPath: string): Promise<Client> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  let wireClient: RpcWireClient | null = null;
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: TIMEOUT_MS,
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => {},
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: TIMEOUT_MS });
  const owner = wireClient;
  const bootstrap = await HostBootstrap.bootstrapClient(owner, {
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

interface AuthedClient extends Client {
  readonly control: RpcStub<HostControl>;
}

async function connect(h: Harness): Promise<AuthedClient> {
  const client = await dial(h.socketPath);
  const negotiated = await client.bootstrap.negotiate(
    protocolOfferToWire({
      identity: h.identity,
      limits: DEFAULT_TRANSPORT_LIMITS,
      requiredFeatureBits: HOST_FEATURE_BITS,
    }),
    { timeoutMs: TIMEOUT_MS },
  );
  assertEquals(negotiated.which, "accepted", "handshake must negotiate");
  const authenticated = await client.bootstrap.authenticate(
    h.credential.slice(),
    { timeoutMs: TIMEOUT_MS },
  );
  assertEquals(authenticated.which, "accepted", "handshake must authenticate");
  const control = await client.bootstrap.host(CAP_CALL);
  return { ...client, control };
}

function createParams(
  timeout: CreateParams["options"]["timeout"],
  overrides: Partial<CreateParams["options"]> = {},
): CreateParams {
  return {
    options: {
      timeout,
      memoryMiB: 1024,
      vcpus: 2,
      allowNet: [],
      labels: [],
      region: "ord",
      netless: false,
      kernelArgs: [],
      ...overrides,
    },
    idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("host wire: create commits capacity, issues a lease, and the sandbox is observable", async () => {
  await withHarness(async (h) => {
    const client = await connect(h);
    try {
      assertEquals(
        await client.control.ping(9n, { timeoutMs: TIMEOUT_MS }),
        9n,
      );

      const created = await client.control.create(
        createParams({ which: "durationMs", durationMs: 60_000n }, {
          labels: [{ key: "env", value: "test" }],
          memoryMiB: 1024,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(created.which, "success");
      const success = created.success!;
      assert(success.sandbox.id.startsWith("sbx_loc_"), "SDK-facing local id");
      assertEquals(success.sandbox.state, "running");
      assertEquals(success.sandbox.liveLeases, 1);
      assertEquals(success.sandbox.labels, [{ key: "env", value: "test" }]);
      assertEquals(success.ownerSecret.byteLength, 32);
      assertEquals(success.lease.timeout.which, "durationMs");
      assertEquals(
        success.sandbox.deadlineUnixMs,
        success.lease.expiresAtUnixMs,
        "the sandbox deadline matches its lease expiry",
      );
      assertEquals(h.gateway.launched.length, 1);

      // list() surfaces it.
      const list = await client.control.list({ timeoutMs: TIMEOUT_MS });
      assertEquals(list.which, "success");
      assertEquals(list.success!.sandboxes.length, 1);
      assertEquals(list.success!.sandboxes[0].id, success.sandbox.id);

      // capacity() reflects the committed reservation.
      const capacity = await client.control.capacity({ timeoutMs: TIMEOUT_MS });
      assertEquals(capacity.which, "capacity");
      assertEquals(capacity.capacity!.memoryCommittedMiB, 1024n);
      assertEquals(capacity.capacity!.vcpusCommitted, 2);
      assertEquals(capacity.capacity!.sandboxCount, 1);

      // The HostSandbox capability observes metadata + usage.
      const sandbox = await client.control.sandbox(
        success.sandbox.id,
        CAP_CALL,
      );
      const metadata = await sandbox.metadata({ timeoutMs: TIMEOUT_MS });
      assertEquals(metadata.which, "metadata");
      assertEquals(metadata.metadata!.id, success.sandbox.id);
      const usage = await sandbox.usage({ timeoutMs: TIMEOUT_MS });
      assertEquals(usage.which, "usage");
      assertEquals(usage.usage!.cpuTimeMicros, 11n);
      await sandbox.close();
    } finally {
      await client.close();
    }
  });
});

Deno.test("host wire: a duration-timeout sandbox is killed at its deadline and its capacity reclaimed", async () => {
  await withHarness(async (h) => {
    const client = await connect(h);
    try {
      const created = await client.control.create(
        createParams({ which: "durationMs", durationMs: 60_000n }),
        { timeoutMs: TIMEOUT_MS },
      );
      const id = created.success!.sandbox.id;
      const executionId = h.gateway.launched[0].executionId;
      assertEquals(h.core.leaseCount, 1);

      // Before the deadline: nothing dies.
      h.clock.advance(59_999);
      assertEquals(h.gateway.killed, []);

      // At the deadline: the lease settles, rootd is asked to kill, and the
      // reservation is reclaimed.
      h.clock.advance(1);
      await h.core.drain();
      assertEquals(h.gateway.killed, [executionId]);
      assertEquals(h.core.leaseCount, 0);
      assertEquals(h.capacity.capacity().sandboxCount, 0);

      const sandbox = await client.control.sandbox(id, CAP_CALL);
      const metadata = await sandbox.metadata({ timeoutMs: TIMEOUT_MS });
      assertEquals(metadata.metadata!.state, "terminated");
      assertEquals(metadata.metadata!.terminationReason, "lease-expired");
      await sandbox.close();
    } finally {
      await client.close();
    }
  });
});

Deno.test("host wire: a session-timeout sandbox is killed when its creating connection closes", async () => {
  await withHarness(async (h) => {
    const client = await connect(h);
    const created = await client.control.create(
      createParams({ which: "session", session: undefined }),
      { timeoutMs: TIMEOUT_MS },
    );
    assertEquals(created.which, "success");
    assertEquals(created.success!.lease.timeout.which, "session");
    const executionId = h.gateway.launched[0].executionId;
    assertEquals(h.core.leaseCount, 1);

    // The creating connection vanishes: the server aborts its liveness
    // controller, settling the session lease and killing the sandbox.
    await client.transport.close();
    await waitFor(() => h.gateway.killed.length > 0, "session-close kill");
    await h.core.drain();
    assertEquals(h.gateway.killed, [executionId]);
    assertEquals(h.core.leaseCount, 0);

    await client.close().catch(() => {});
  });
});

Deno.test("host wire: over-capacity create fails fast with the hostCapacity error + exhausted dimension", async () => {
  await withHarness(async (h) => {
    const client = await connect(h);
    try {
      // budget is 2 vCPU -> exactly one 2-vCPU sandbox fits.
      const first = await client.control.create(
        createParams({ which: "session", session: undefined }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(first.which, "success");

      const overflow = await client.control.create(
        createParams({ which: "session", session: undefined }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(overflow.which, "error");
      assertEquals(overflow.error!.code, "hostCapacity");
      assertEquals(
        overflow.error!.details,
        [{ key: "capacityDimension", value: "vcpu" }],
      );
      // The failed create left no launch behind.
      assertEquals(h.gateway.launched.length, 1);
    } finally {
      await client.close();
    }
  }, { budget: { vcpus: 2 } });
});

Deno.test("host wire: attach from a second connection observes the first's sandbox without a new lease", async () => {
  await withHarness(async (h) => {
    const owner = await connect(h);
    let observer: AuthedClient | undefined;
    try {
      const created = await owner.control.create(
        createParams({ which: "durationMs", durationMs: 60_000n }),
        { timeoutMs: TIMEOUT_MS },
      );
      const id = created.success!.sandbox.id;
      const ownerSecret = created.success!.ownerSecret;
      assertEquals(h.core.leaseCount, 1);

      // A second connection attaches with the owner secret.
      observer = await connect(h);
      const attached = await observer.control.attach({
        id,
        ownerSecret: ownerSecret.slice(),
        idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
      }, { timeoutMs: TIMEOUT_MS });
      assertEquals(attached.which, "success");
      assertEquals(attached.success!.sandbox.id, id);
      // No new lease was minted: still exactly one live lease, and the attach
      // lease carries no resume secret (the attacher is not the owner).
      assertEquals(h.core.leaseCount, 1);
      assertEquals(attached.success!.sandbox.liveLeases, 1);
      assertEquals(attached.success!.lease.resumeSecret.byteLength, 0);

      // A wrong secret is refused.
      const wrong = await observer.control.attach({
        id,
        ownerSecret: crypto.getRandomValues(new Uint8Array(32)),
        idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
      }, { timeoutMs: TIMEOUT_MS });
      assertEquals(wrong.which, "error");
      assertEquals(wrong.error!.code, "permissionDenied");
    } finally {
      await observer?.close();
      await owner.close();
    }
  });
});

Deno.test("host wire: hostd restart revokes leases and tickets silently (no rootd kills)", async () => {
  await withHarness(async (h) => {
    const client = await connect(h);
    try {
      const created = await client.control.create(
        createParams({ which: "durationMs", durationMs: 60_000n }),
        { timeoutMs: TIMEOUT_MS },
      );
      const id = created.success!.sandbox.id;
      // Seed a tunnel ticket bound to the sandbox (the openTunnel body is M7;
      // the store the core owns is exercised directly).
      await h.tickets.issue({
        sessionId: "sess-1",
        sandboxId: id,
        bootNonce: "nonce",
        leaseGeneration: 1,
      });
      assertEquals(h.core.leaseCount, 1);
      assertEquals(h.core.ticketCount, 1);

      // Restart: revoke everything SILENTLY.
      h.core.revokeAll();
      assertEquals(h.core.leaseCount, 0);
      assertEquals(h.core.ticketCount, 0);
      await h.core.drain();
      assertEquals(
        h.gateway.killed,
        [],
        "revokeAll fires no rootd kills; reconcile reclaims on next start",
      );
    } finally {
      await client.close();
    }
  });
});

Deno.test("host wire gate: pre-auth host() is refused and latches the gate closed", async () => {
  await withHarness(async (h) => {
    const client = await dial(h.socketPath);
    try {
      const negotiated = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: h.identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: HOST_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(negotiated.which, "accepted");

      // host() before authenticate: typed rejection + gate latch.
      await assertRejects(() => client.bootstrap.host(CAP_CALL));

      const late = await client.bootstrap.authenticate(h.credential.slice(), {
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(late.which, "error");
      assertEquals(late.error!.code, "failedPrecondition");
    } finally {
      await client.close();
    }
  });
});

Deno.test("host wire gate: a wrong token is rate-limited to the gate's failure budget", async () => {
  await withHarness(async (h) => {
    const client = await dial(h.socketPath);
    try {
      const negotiated = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: h.identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: HOST_FEATURE_BITS,
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
        assertEquals(result.error!.code, "unauthenticated");
        assertEquals(result.error!.retryable, true, `attempt ${attempt}`);
      }
      const third = await client.bootstrap.authenticate(wrong.slice(), {
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(third.error!.code, "unauthenticated");
      assertEquals(third.error!.retryable, false);

      // Post-close, even the real token is refused and no capability exists.
      const late = await client.bootstrap.authenticate(h.credential.slice(), {
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(late.error!.code, "failedPrecondition");
      await assertRejects(() => client.bootstrap.host(CAP_CALL));
    } finally {
      await client.close();
    }
  });
});

Deno.test("host wire hygiene: rapid connect-then-close peers leave the accept loop healthy (accept DoS)", async () => {
  // The pinned M1 DoS class: a peer that connects and immediately closes must
  // never tear the host accept loop down. Hammer the socket, then prove a fresh
  // client still completes a full create + nothing escaped as a global
  // unhandled rejection.
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    await withHarness(async (h) => {
      for (let i = 0; i < 60; i++) {
        const conn = await Deno.connect({
          transport: "unix",
          path: h.socketPath,
        });
        conn.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));

      const client = await connect(h);
      try {
        const created = await client.control.create(
          createParams({ which: "durationMs", durationMs: 60_000n }),
          { timeoutMs: TIMEOUT_MS },
        );
        assertEquals(created.which, "success");
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
});

Deno.test("host wire gate: a tampered schema bundle hash rejects at negotiation", async () => {
  await withHarness(async (h) => {
    const client = await dial(h.socketPath);
    try {
      const tamperedHash = h.identity.schemaHash.slice();
      tamperedHash[0] ^= 0xff;
      const rejected = await client.bootstrap.negotiate(
        protocolOfferToWire({
          identity: { ...h.identity, schemaHash: tamperedHash },
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: HOST_FEATURE_BITS,
        }),
        { timeoutMs: TIMEOUT_MS },
      );
      assertEquals(rejected.which, "error");
      assertEquals(rejected.error!.code, "incompatibleSchema");

      // The rejection latched the gate closed.
      await assertRejects(() => client.bootstrap.host(CAP_CALL));
    } finally {
      await client.close();
    }
  });
});
