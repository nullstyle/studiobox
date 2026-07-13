/**
 * Shared scaffolding for the M7 fake-tier tunnel tests (host-safe, UDS only).
 *
 * Provides:
 *   - `makeTunnelCore`: a {@linkcode HostControlCore} wired with a fake rootd
 *     gateway, an injected clock + ticket store, and a bridge factory — the
 *     unprivileged host side of the ticketed tunnel;
 *   - `EchoServer` + `echoBridgeFactory`: a trivial in-process UDS "guest" that
 *     echoes bytes, standing in for studioboxd when a test only needs to prove
 *     preface / ticket / splice mechanics (not the capnp agent plane);
 *   - `startFakeAgent` + `agentBridgeFactory`: the REAL studioboxd
 *     (`src/agent/main.ts`) over a UDS, standing in for the guest vsock, so a
 *     test can drive a capnp `SandboxAgent` end to end THROUGH the splice.
 */

import { fromFileUrl } from "@std/path";
import {
  type CreateSandboxInput,
  HostControlCore,
} from "../../../src/hostd/control_core.ts";
import { SingleUseTicketStore } from "../../../src/security/tickets.ts";
import type {
  BridgeReservation,
  PrivilegedBridgeRequest,
  PrivilegedBridgeReserver,
} from "../../../src/hostd/tunnel_authorizer.ts";
import type { Clock, ClockTimer } from "../../../src/hostd/leases.ts";
import type { RootdGateway } from "../../../src/hostd/supervisor_client.ts";
import {
  BridgeServer,
  type BridgeServerOptions,
} from "../../../src/rootd/bridge_server.ts";
import type {
  SupervisorBridgeGrant,
  SupervisorLaunchRequest,
  SupervisorMachineStatus,
  SupervisorMachineUsage,
  SupervisorReconcileSummary,
} from "../../../src/rootd/supervisor_core_api.ts";

const AGENT_MAIN = fromFileUrl(
  new URL("../../../src/agent/main.ts", import.meta.url),
);

// ---------------------------------------------------------------------------
// Deterministic clock (mirrors the control_core unit fakes)
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { fireAt: number; cb: () => void }>();

  constructor(startUnixMs = 1_000_000) {
    this.#now = startUnixMs;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fireAtUnixMs: number, callback: () => void): ClockTimer {
    const token = this.#seq++;
    this.#timers.set(token, { fireAt: fireAtUnixMs, cb: callback });
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
      timer.cb();
    }
    this.#now = target;
  }
}

// ---------------------------------------------------------------------------
// Fake rootd gateway (launch/kill are all this path exercises)
// ---------------------------------------------------------------------------

export class FakeGateway implements RootdGateway {
  readonly launched: SupervisorLaunchRequest[] = [];
  readonly killed: string[] = [];
  readonly exposed: Array<
    { executionId: string; guestPort: number; hostPort: number }
  > = [];

  launch(request: SupervisorLaunchRequest): Promise<SupervisorMachineStatus> {
    this.launched.push(request);
    return Promise.resolve({
      sandboxId: request.sandboxId,
      executionId: request.executionId,
      state: "running",
      pid: 4321,
    });
  }

  status(executionId: string): Promise<SupervisorMachineStatus> {
    return Promise.resolve({
      sandboxId: "sbx-loc-x",
      executionId,
      state: "running",
    });
  }

  usage(): Promise<SupervisorMachineUsage> {
    return Promise.resolve({
      cpuTimeMicros: 0,
      memoryCurrentBytes: 0,
      memoryPeakBytes: 0,
      diskBytes: 0,
      rxBytes: 0,
      txBytes: 0,
    });
  }

  kill(executionId: string): Promise<void> {
    this.killed.push(executionId);
    return Promise.resolve();
  }

  exposeHttp(
    executionId: string,
    guestPort: number,
    hostPort: number,
  ): Promise<void> {
    this.exposed.push({ executionId, guestPort, hostPort });
    return Promise.resolve();
  }

  // The M7 fake tunnel tests inject the guest dial through the `bridgeFactory`
  // seam directly, not the wire `openBridge` grant path. The two-daemon M8 test
  // subclasses this and overrides `openBridge` to stand up a real BridgeServer,
  // so the return type is the real grant even though the base rejects.
  openBridge(): Promise<SupervisorBridgeGrant> {
    return Promise.reject(new Error("fake gateway does not open bridges"));
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
// Bridge factories (the guest-dial seam)
// ---------------------------------------------------------------------------

/**
 * Records every GUEST DIAL (`connect`) so a test can assert "no bridge opened"
 * for a rejected ticket. Reservations are recorded separately: `openTunnel`
 * reserves eagerly (surfacing `agentCredential`), but the guest is dialed only
 * after the ticket is burned.
 */
export class RecordingBridgeFactory
  implements PrivilegedBridgeReserver<Deno.Conn> {
  /** One entry per GUEST DIAL (a burned-ticket `connect`). */
  readonly requests: PrivilegedBridgeRequest[] = [];
  /** One entry per RESERVE (an `openTunnel`). */
  readonly reservations: PrivilegedBridgeRequest[] = [];
  readonly #dial: (request: PrivilegedBridgeRequest) => Promise<Deno.Conn>;
  readonly #agentCredential: Uint8Array;

  constructor(
    dial: (request: PrivilegedBridgeRequest) => Promise<Deno.Conn>,
    agentCredential: Uint8Array = new Uint8Array(32),
  ) {
    this.#dial = dial;
    this.#agentCredential = agentCredential;
  }

  reserveBridge(
    request: PrivilegedBridgeRequest,
  ): Promise<BridgeReservation<Deno.Conn>> {
    this.reservations.push({ ...request });
    const dial = this.#dial;
    const requests = this.requests;
    return Promise.resolve({
      agentCredential: this.#agentCredential.slice(),
      connect: (_signal?: AbortSignal): Promise<Deno.Conn> => {
        requests.push({ ...request });
        return dial(request);
      },
      close: (): Promise<void> => Promise.resolve(),
    });
  }
}

/** A trivial in-process UDS "guest" that echoes every byte it receives. */
export class EchoServer implements AsyncDisposable {
  readonly path: string;
  readonly #listener: Deno.Listener;
  readonly #conns = new Set<Deno.Conn>();
  #closed = false;

  private constructor(path: string, listener: Deno.Listener) {
    this.path = path;
    this.#listener = listener;
    void this.#accept();
  }

  static async start(): Promise<EchoServer> {
    const dir = await Deno.makeTempDir({ prefix: "sbx-echo-" });
    const path = `${dir}/e.sock`;
    const listener = Deno.listen({ transport: "unix", path });
    return new EchoServer(path, listener);
  }

  async #accept(): Promise<void> {
    while (!this.#closed) {
      let conn: Deno.Conn;
      try {
        conn = await this.#listener.accept();
      } catch {
        break;
      }
      this.#conns.add(conn);
      void this.#echo(conn).finally(() => this.#conns.delete(conn));
    }
  }

  async #echo(conn: Deno.Conn): Promise<void> {
    const buffer = new Uint8Array(64 * 1024);
    try {
      while (true) {
        const count = await conn.read(buffer);
        if (count === null) break;
        let offset = 0;
        while (offset < count) {
          offset += await conn.write(buffer.subarray(offset, count));
        }
      }
    } catch {
      // Peer reset / mid-stream close: drop the conn.
    }
    try {
      conn.close();
    } catch {
      // Already closed.
    }
  }

  bridgeFactory(): RecordingBridgeFactory {
    return new RecordingBridgeFactory(() =>
      Deno.connect({ transport: "unix", path: this.path })
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#closed = true;
    try {
      this.#listener.close();
    } catch {
      // Already closed.
    }
    for (const conn of this.#conns) {
      try {
        conn.close();
      } catch {
        // Already closed.
      }
    }
    this.#conns.clear();
    await Deno.remove(this.path).catch(() => {});
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The real studioboxd over a UDS (the fake guest vsock)
// ---------------------------------------------------------------------------

export interface FakeAgent extends AsyncDisposable {
  readonly socket: string;
  readonly credential: Uint8Array;
  bridgeFactory(): RecordingBridgeFactory;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Boot `src/agent/main.ts` on a UDS and wait for its ready line. */
export async function startFakeAgent(): Promise<FakeAgent> {
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
      AGENT_MAIN,
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

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let readyText = "";
  while (!readyText.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("studioboxd exited before its ready line");
    readyText += decoder.decode(value, { stream: true });
  }
  const drained = (async () => {
    while (!(await reader.read()).done) {
      // discard remaining stdout so the child never blocks on a full pipe
    }
  })().catch(() => {});

  return {
    socket,
    credential,
    bridgeFactory: () =>
      new RecordingBridgeFactory(
        () => Deno.connect({ transport: "unix", path: socket }),
        credential,
      ),
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

// ---------------------------------------------------------------------------
// The rootd half: a gateway whose openBridge stands up a REAL BridgeServer
// ---------------------------------------------------------------------------

/**
 * Stands in for the two-daemon split: `openBridge` mints a grant + binds a
 * per-bridge UDS whose guest dial reaches the fake agent, exactly as rootd's
 * `onBridgeGranted` does in production (there the guest dial is a real vsock).
 * The hostd side dials that UDS with the grant's `bridgeCredential` in the fixed
 * `SBXBRG1` preface before the guest is reached (the assembled bridge leg).
 */
export class BridgeWireGateway extends FakeGateway implements AsyncDisposable {
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

  /** The most recent bridge server socket (for adversarial endpoint probing). */
  get lastSocketPath(): string {
    return `${this.#dir}/b-${(this.#seq - 1).toString().padStart(4, "0")}.sock`;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.allSettled([...this.#servers].map((s) => s.close()));
    await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The host control core under test
// ---------------------------------------------------------------------------

export interface TunnelCoreOptions {
  readonly bridgeFactory: PrivilegedBridgeReserver<Deno.Conn>;
  readonly clock?: Clock;
  readonly tickets?: SingleUseTicketStore;
  readonly tunnelDialBudgetMs?: number;
}

export interface TunnelCore extends AsyncDisposable {
  readonly core: HostControlCore;
  readonly gateway: FakeGateway;
  readonly clock: Clock;
  readonly tickets: SingleUseTicketStore;
  /** Create one running sandbox with a duration lease and return its id. */
  createSandbox(durationMs?: number): Promise<string>;
}

export function makeTunnelCore(options: TunnelCoreOptions): TunnelCore {
  const gateway = new FakeGateway();
  const clock = options.clock ?? new FakeClock();
  const tickets = options.tickets ??
    new SingleUseTicketStore({ now: () => clock.now() });
  const core = new HostControlCore({
    gateway,
    clock,
    tickets,
    bridgeFactory: options.bridgeFactory,
    ...(options.tunnelDialBudgetMs === undefined
      ? {}
      : { tunnelDialBudgetMs: options.tunnelDialBudgetMs }),
  });

  return {
    core,
    gateway,
    clock,
    tickets,
    async createSandbox(durationMs = 300_000): Promise<string> {
      const input: CreateSandboxInput = {
        timeout: { kind: "duration", durationMs },
        memoryMiB: 0,
        region: "loc",
        labels: [],
        idempotencyKey: new Uint8Array(0),
      };
      const result = await core.create(input);
      return result.sandbox.id;
    },
    async [Symbol.asyncDispose]() {
      await core.closeAllTunnels();
      await core.drain();
    },
  };
}
