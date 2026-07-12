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
  PrivilegedBridgeFactory,
  PrivilegedBridgeRequest,
} from "../../../src/hostd/tunnel_authorizer.ts";
import type { Clock, ClockTimer } from "../../../src/hostd/leases.ts";
import type { RootdGateway } from "../../../src/hostd/supervisor_client.ts";
import type {
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

/** Records every bridge request so a test can assert "no bridge opened". */
export class RecordingBridgeFactory
  implements PrivilegedBridgeFactory<Deno.Conn> {
  readonly requests: PrivilegedBridgeRequest[] = [];
  readonly #dial: (request: PrivilegedBridgeRequest) => Promise<Deno.Conn>;

  constructor(dial: (request: PrivilegedBridgeRequest) => Promise<Deno.Conn>) {
    this.#dial = dial;
  }

  openBridge(request: PrivilegedBridgeRequest): Promise<Deno.Conn> {
    this.requests.push({ ...request });
    return this.#dial(request);
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
      new RecordingBridgeFactory(() =>
        Deno.connect({ transport: "unix", path: socket })
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
// The host control core under test
// ---------------------------------------------------------------------------

export interface TunnelCoreOptions {
  readonly bridgeFactory: PrivilegedBridgeFactory<Deno.Conn>;
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
