/**
 * studioboxd — the guest-agent entrypoint (`deno compile` target).
 *
 * Serves the `schema/sandbox_agent.capnp` plane (`src/agent/service.ts`
 * — generated `AgentBootstrap` → negotiate/authenticate →
 * `SandboxAgent`) over a transport seam:
 *
 * - `--socket <path>`: a Unix domain socket (dev/fake-host transport;
 *   also what the M5 rootd bridge splices tunnels onto).
 * - `--vsock-port <port>`: in-guest AF_VSOCK
 *   (`Deno.listen({ transport: "vsock", cid: 3, port })`). Linux-only
 *   and gated behind `--unstable-vsock` on Deno 2.9 (recorded in
 *   `compat/wire.json`); on any other OS this flag is a loud startup
 *   error. This code path is NOT testable on macOS — it is proven in
 *   M5's in-VM integration (fc-smoke).
 *
 * Exactly one of the two transports must be given.
 *
 * Every connection is its own capnp session: a fresh
 * {@linkcode serveAgentWireTransport} (per-connection bootstrap gate,
 * `RpcServerRuntime.createWithRoot` over the WASM session core) on a
 * `TcpTransport` wrapping the accepted
 * conn. Ownership contract (see
 * `tests/unit/rpc_conformance/transport_close_ownership_test.ts`):
 * `onClose` is wired to tear the runtime + connection resources down,
 * and `onError` is always set so out-of-band conn destruction never
 * escapes as a global unhandled rejection.
 *
 * Flags: `--socket <path>` XOR `--vsock-port <port>`;
 * `--token-file <path>` (REQUIRED — hex-encoded shared credential the
 * peer must present to `authenticate`; the guest image's overlay-init
 * materializes it from the launch config); `--root <hostdir>` (default
 * `/`); `--home <in-sandbox dir>` (default `/home/app`); `--deno
 * <host path>` (the pinned deno binary driving `DenoRuntime`; REQUIRED
 * in compiled builds, where the default — `Deno.execPath()` — resolves
 * to the studioboxd binary itself, not a deno CLI).
 *
 * On boot the agent prints one `{"studioboxd": {...}}` ready line to
 * stdout (consumed by smoke tooling and process supervisors).
 *
 * @module
 */

import { TcpTransport } from "@nullstyle/capnp";

import type { AgentApi, AgentInfo, AgentRootConfig } from "./api.ts";
import { AgentError } from "./api.ts";
import { AgentDeno } from "./deno_runtime.ts";
import { AgentEnv, guestBaseEnvironment } from "./env.ts";
import { AgentFs } from "./fs.ts";
import { AgentProcesses, sandboxHome } from "./processes.ts";
import {
  type AgentWireOptions,
  type AgentWireServer,
  m3AgentContractIdentity,
  serveAgentWireTransport,
} from "./service.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../wire/contract.ts";

const BUILD_ID = "studioboxd/m3-wire";
const TRANSPORT_CLOSE_TIMEOUT_MS = 2_000;
/**
 * DEFECT A (guest availability): a connection that never completes the
 * fail-closed `negotiate -> authenticate -> agent()` bootstrap must not
 * pin a per-connection session forever. A peer that connects and stalls
 * (silent, or after a garbage / truncated frame) is dropped once this
 * deadline elapses without the bootstrap gate reaching `authenticated`.
 * Overridable (tests) via `SBX_AGENT_HANDSHAKE_DEADLINE_MS`.
 */
const DEFAULT_HANDSHAKE_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------
// Agent assembly (domain plane)
// ---------------------------------------------------------------------------

interface AgentAssembly {
  readonly api: AgentApi;
  readonly processes: AgentProcesses;
}

function assembleAgent(
  config: AgentRootConfig,
  denoPath: string | undefined,
): AgentAssembly {
  // The real guest seeds the agent environment from its boot environment,
  // under a guaranteed default PATH + HOME (overlay-init execs studioboxd with
  // the kernel's bare init env, so a bare-name spawn would otherwise fail with
  // "no path to search"); the fake host seeds explicitly instead (see
  // `testing/mod.ts`).
  const env = new AgentEnv(
    guestBaseEnvironment(sandboxHome(config), Deno.env.toObject()),
  );
  const processes = new AgentProcesses({ config, env });
  const fs = new AgentFs(config);
  const deno = new AgentDeno({ config, spawner: processes, denoPath });
  const startedAtUnixMs = Date.now();
  const api: AgentApi = {
    processes,
    fs,
    env,
    deno,
    info(): Promise<AgentInfo> {
      return Promise.resolve({
        buildId: BUILD_ID,
        denoVersion: Deno.version.deno,
        arch: Deno.build.arch,
        home: sandboxHome(config),
        startedAtUnixMs,
      });
    },
    ping(nonce: bigint): Promise<bigint> {
      return Promise.resolve(nonce);
    },
  };
  return { api, processes };
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface AgentFlags {
  socket?: string;
  vsockPort?: number;
  tokenFile: string;
  root: string;
  home?: string;
  deno?: string;
}

export function parseAgentFlags(args: readonly string[]): AgentFlags {
  const flags: Partial<AgentFlags> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const take = (name: string): string => {
      const inline = `--${name}=`;
      if (arg.startsWith(inline)) return arg.slice(inline.length);
      const next = args[++i];
      if (next === undefined) {
        throw new AgentError("SBX_AGENT_VALIDATION", `--${name} needs a value`);
      }
      return next;
    };
    if (arg === "--socket" || arg.startsWith("--socket=")) {
      flags.socket = take("socket");
    } else if (arg === "--vsock-port" || arg.startsWith("--vsock-port=")) {
      const value = Number(take("vsock-port"));
      if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
        throw new AgentError(
          "SBX_AGENT_VALIDATION",
          "--vsock-port must be a positive integer port",
        );
      }
      flags.vsockPort = value;
    } else if (arg === "--token-file" || arg.startsWith("--token-file=")) {
      flags.tokenFile = take("token-file");
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      flags.root = take("root");
    } else if (arg === "--home" || arg.startsWith("--home=")) {
      flags.home = take("home");
    } else if (arg === "--deno" || arg.startsWith("--deno=")) {
      flags.deno = take("deno");
    } else {
      throw new AgentError("SBX_AGENT_VALIDATION", `unknown flag: ${arg}`);
    }
  }
  if ((flags.socket === undefined) === (flags.vsockPort === undefined)) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "exactly one of --socket <path> or --vsock-port <port> is required",
    );
  }
  if (flags.tokenFile === undefined) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "--token-file <path> is required",
    );
  }
  return {
    socket: flags.socket,
    vsockPort: flags.vsockPort,
    tokenFile: flags.tokenFile,
    root: flags.root ?? "/",
    home: flags.home,
    deno: flags.deno,
  };
}

/**
 * Read the shared credential: a hex string (whitespace-trimmed) that
 * decodes to 16..512 bytes.
 */
export async function readCredentialFile(path: string): Promise<Uint8Array> {
  const text = (await Deno.readTextFile(path)).trim();
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `token file ${path} must contain a hex-encoded credential`,
    );
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  if (bytes.byteLength < 16 || bytes.byteLength > 512) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `token file ${path} must decode to 16..512 bytes`,
    );
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

async function listenUnix(path: string): Promise<Deno.Listener> {
  // Replace a stale socket file from a previous run.
  try {
    await Deno.remove(path);
  } catch {
    // Absent is the normal case.
  }
  return Deno.listen({ transport: "unix", path });
}

function listenVsock(port: number): Deno.Listener {
  if (Deno.build.os !== "linux") {
    throw new AgentError(
      "SBX_AGENT_UNSUPPORTED",
      `--vsock-port requires AF_VSOCK, which is Linux-only (running on ${Deno.build.os}). ` +
        "Use --socket <path> on this platform.",
    );
  }
  // AF_VSOCK is behind --unstable-vsock on Deno 2.9 (compat/wire.json),
  // so the option shape is not in the stable Deno.listen overloads.
  type VsockListen = (options: {
    transport: "vsock";
    cid: number;
    port: number;
  }) => Deno.Listener;
  try {
    // cid 3 = the guest's own context id (DESIGN.md §10).
    return (Deno.listen as unknown as VsockListen)({
      transport: "vsock",
      cid: 3,
      port,
    });
  } catch (error) {
    throw new AgentError(
      "SBX_AGENT_UNSUPPORTED",
      `AF_VSOCK listen failed — is studioboxd running with --unstable-vsock? (${
        error instanceof Error ? error.message : String(error)
      })`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Serve loop
// ---------------------------------------------------------------------------

export interface ActiveConnection {
  teardown(): Promise<void>;
}

/**
 * Resolve the per-connection handshake deadline, honouring the
 * `SBX_AGENT_HANDSHAKE_DEADLINE_MS` override (tests drive a short one).
 */
export function handshakeDeadlineMsFromEnv(): number {
  const raw = Deno.env.get("SBX_AGENT_HANDSHAKE_DEADLINE_MS");
  if (raw === undefined || raw === "") return DEFAULT_HANDSHAKE_DEADLINE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_HANDSHAKE_DEADLINE_MS;
  }
  return value;
}

export function serveWireConnection(
  conn: Deno.Conn,
  wireOptions: AgentWireOptions,
  active: Set<ActiveConnection>,
  handshakeDeadlineMs: number,
): void {
  let server: AgentWireServer | null = null;
  let closed = false;
  const entry: ActiveConnection = {
    async teardown(): Promise<void> {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      active.delete(entry);
      try {
        await server?.close();
      } catch {
        // Session already torn down.
      }
      try {
        await transport.close();
      } catch {
        // Transport already closed.
      }
    },
  };
  // Ownership contract: the transport observes EOF; the owner (this
  // entry) closes the session. onError is wired to teardown (DEFECT A):
  // a frame that can't be parsed, an over-limit frame, or an out-of-band
  // conn destruction closes THIS connection (and tears down its session)
  // without escaping as a global unhandled rejection or affecting the
  // accept loop or any other connection. `frameLimits` caps a single
  // inbound frame at the plane's ceiling so a garbage/oversized
  // length-prefix is rejected with bounded buffering rather than read
  // until memory is exhausted.
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: TRANSPORT_CLOSE_TIMEOUT_MS,
    frameLimits: { maxFrameBytes: DEFAULT_TRANSPORT_LIMITS.maxFrameBytes },
    onClose: () => void entry.teardown(),
    onError: () => void entry.teardown(),
  });
  active.add(entry);
  // DEFECT A: bound the handshake. A peer that stalls (silently, or after
  // a garbage/truncated frame the framer keeps waiting to complete) never
  // trips onClose/onError, so without this deadline its session would leak
  // for the life of the agent. When the deadline elapses and the gate has
  // not reached `authenticated`, drop the connection. A completed
  // handshake leaves the (single-shot) timer to expire harmlessly, so an
  // authenticated session may then sit idle indefinitely.
  const handshakeTimer = setTimeout(() => {
    if (closed) return;
    if (server?.connection.phase !== "authenticated") void entry.teardown();
  }, handshakeDeadlineMs);
  void (async () => {
    try {
      server = await serveAgentWireTransport(transport, wireOptions);
      if (closed) await server.close();
    } catch {
      await entry.teardown();
    }
  })();
}

async function main(): Promise<void> {
  let flags: AgentFlags;
  let credential: Uint8Array;
  try {
    flags = parseAgentFlags(Deno.args);
    credential = await readCredentialFile(flags.tokenFile);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
      "\nusage: studioboxd (--socket <path> | --vsock-port <port>) --token-file <path> [--root <dir>] [--home <dir>] [--deno <path>]",
    );
    Deno.exit(2);
  }
  const config: AgentRootConfig = { root: flags.root, home: flags.home };
  const { api, processes } = assembleAgent(config, flags.deno);
  const wireOptions: AgentWireOptions = {
    api,
    identity: m3AgentContractIdentity(BUILD_ID),
    credential,
    releaseProcess: (process) => void processes.release(process),
  };

  let listener: Deno.Listener;
  try {
    listener = flags.socket !== undefined
      ? await listenUnix(flags.socket)
      : listenVsock(flags.vsockPort as number);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }

  const active = new Set<ActiveConnection>();
  const handshakeDeadlineMs = handshakeDeadlineMsFromEnv();
  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      listener.close();
    } catch {
      // Already closed.
    }
    for (const entry of [...active]) {
      await entry.teardown();
    }
    await processes.shutdown();
    if (flags.socket !== undefined) {
      try {
        await Deno.remove(flags.socket);
      } catch {
        // Best-effort.
      }
    }
    Deno.exit(code);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => void shutdown(0));
  }

  // Ready line (consumed by smoke tooling and process supervisors).
  console.log(JSON.stringify({
    studioboxd: {
      buildId: BUILD_ID,
      plane: "capnp",
      ...(flags.socket !== undefined
        ? { socket: flags.socket }
        : { vsockPort: flags.vsockPort }),
      root: flags.root,
      pid: Deno.pid,
    },
  }));

  // Resilient accept loop. A single broken peer must never stop the agent
  // from serving: `Deno.Listener.accept()` can throw a transient per-accept
  // fault (on macOS a peer that connects and immediately closes races the
  // accept into `EINVAL`/`Invalid argument (os error 22)`), and the async
  // iterator would propagate that straight out of the loop and kill the
  // agent. Only an intentional shutdown (the listener being closed) ends the
  // loop; every other accept fault is logged and skipped. Per-connection
  // serving is isolated inside `serveWireConnection` (its errors, including
  // transport `onError`, never reach here).
  while (!shuttingDown) {
    let conn: Deno.Conn;
    try {
      conn = await listener.accept();
    } catch (error) {
      if (shuttingDown) break;
      if (
        error instanceof Deno.errors.BadResource ||
        error instanceof Deno.errors.Interrupted
      ) {
        // The listener was closed out from under us; stop accepting.
        break;
      }
      console.error(
        `studioboxd accept error (continuing): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    try {
      serveWireConnection(conn, wireOptions, active, handshakeDeadlineMs);
    } catch (error) {
      // serveWireConnection never throws (it hands serving to a background
      // task), but guard so a future refactor cannot take the loop down.
      console.error(
        `studioboxd connection setup error (continuing): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        conn.close();
      } catch {
        // Already closed.
      }
    }
  }
  await shutdown(0);
}

if (import.meta.main) {
  await main();
}
