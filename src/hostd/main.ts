/**
 * studiobox-hostd — the unprivileged host control-plane entrypoint
 * (DESIGN.md §3; PLAN.md §M6).
 *
 * Serves `schema/host_control.capnp` (`HostBootstrap` -> `HostControl` ->
 * `HostSandbox` / `Lease`) over ONE Unix-domain socket (`--socket`) or one
 * loopback TCP listener (`--listen host:port`) via the wire adapter in
 * `./service.ts`, delegating every method to a {@linkcode HostControlCore}. The
 * core drives the root-owned studiobox-rootd through a bounded supervisor
 * client (`./supervisor_client.ts`).
 *
 * ## Transport ownership (pinned M1 contract)
 *
 * Every accepted transport is constructed with BOTH `onClose` and `onError`
 * wired. `onError` because an out-of-band conn destruction otherwise escapes as
 * a global unhandled rejection; `onClose` so the connection's bootstrap gate
 * fails closed, its runtime is torn down, AND its connection-liveness
 * controller aborts — which settles every `"session"` lease created over that
 * connection (DESIGN.md §5).
 *
 * ## Shutdown
 *
 * SIGTERM/SIGINT: stop accepting, then REVOKE all leases and tunnel tickets
 * (`HostControlCore.revokeAll`) — silently, firing no rootd kills, because
 * rootd's destructive reconcile reclaims the orphaned executions on the next
 * start (DESIGN.md §6). Then close active sessions and the rootd client.
 *
 * @module
 */

import { fromFileUrl } from "@std/path";
import { RpcServerRuntime, TcpTransport } from "@nullstyle/capnp";
import type { RpcAcceptedTransport, serve } from "@nullstyle/capnp";
import type { BootstrapGate } from "../wire/bootstrap_gate.ts";
import { WireValidationError } from "../wire/contract.ts";
import { HostBootstrap as HostBootstrapToken } from "../wire/generated/host_control_types.ts";
import {
  buildHostContractIdentity,
  createHostControlWireConnection,
  type HostCompatIdentitySource,
  type HostControlWireOptions,
} from "./service.ts";
import { buildSupervisorContractIdentity } from "../rootd/service.ts";
import { HostControlCore } from "./control_core.ts";
import type { TunnelListenSpec } from "./tunnel_server.ts";
import { WireBridgeFactory } from "./wire_bridge.ts";
import {
  connectSupervisorSession,
  DEFAULT_HOST_BUILD_ID,
  type SupervisorSession,
} from "./supervisor_client.ts";

const BUILD_ID_DEFAULT = DEFAULT_HOST_BUILD_ID;
const TRANSPORT_CLOSE_TIMEOUT_MS = 5_000;
/**
 * The statically-forwarded tunnel loopback port (DESIGN.md §11). The shared
 * tunnel router binds here; a client dials `127.0.0.1:40001` with its grant
 * ticket (the wire `TunnelGrant` carries no endpoint — the address is a fixed
 * convention, forwarded into the host VM alongside control 40000).
 */
export const DEFAULT_TUNNEL_LISTEN: TunnelListenSpec = {
  transport: "tcp",
  hostname: "127.0.0.1",
  port: 40001,
};

// `RpcTransportAcceptSource` is not exported by the package; the pinned M1
// pattern types custom acceptors structurally via serve()'s signature.
type HostAcceptSource = Parameters<typeof serve>[1];

/** Hooks the accept loop wires onto every accepted transport. */
export interface HostAcceptSourceOptions {
  /** Observes read-loop faults (REQUIRED per the pinned ownership contract). */
  readonly onTransportError?: (error: unknown, connectionId: string) => void;
  /** Fires once per transport when it closes (EOF or local close). */
  readonly onTransportClose?: (connectionId: string) => void;
  /** Reports a transient per-accept fault the loop SURVIVED (see rootd/main). */
  readonly onAcceptError?: (error: unknown) => void;
  readonly closeTimeoutMs?: number;
  /** The bound listener (UDS or loopback TCP) this source drains. */
  readonly listener: Deno.Listener;
  /** The local address stamped on each accepted transport. */
  readonly localAddress: Deno.Addr;
}

/**
 * Hand-rolled accept source for `serve()`: wraps every accepted `Deno.Conn` in
 * a `TcpTransport` with `onClose`/`onError` wired per the pinned M1 ownership
 * contract. Survives a transient accept fault (e.g. a connect-then-close race
 * surfacing as EINVAL on macOS) instead of tearing the loop down.
 */
export class HostControlAcceptSource implements HostAcceptSource {
  readonly #listener: Deno.Listener;
  readonly #localAddress: Deno.Addr;
  readonly #options: HostAcceptSourceOptions;
  #closed = false;
  #nextId = 0;

  constructor(options: HostAcceptSourceOptions) {
    this.#listener = options.listener;
    this.#localAddress = options.localAddress;
    this.#options = options;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *accept(): AsyncIterable<RpcAcceptedTransport> {
    while (!this.#closed) {
      let conn: Deno.Conn;
      try {
        conn = await this.#listener.accept();
      } catch (error) {
        if (this.#closed) return;
        if (
          error instanceof Deno.errors.BadResource ||
          error instanceof Deno.errors.Interrupted
        ) {
          return;
        }
        // Transient per-accept fault: report it and keep accepting. One broken
        // peer must never tear the host accept loop down.
        this.#options.onAcceptError?.(error);
        continue;
      }
      const id = `hostd-${this.#nextId++}`;
      const transport = new TcpTransport(conn, {
        closeTimeoutMs: this.#options.closeTimeoutMs ??
          TRANSPORT_CLOSE_TIMEOUT_MS,
        onClose: () => this.#options.onTransportClose?.(id),
        onError: (error) => this.#options.onTransportError?.(error, id),
      });
      yield {
        transport,
        localAddress: this.#localAddress,
        remoteAddress: { transport: this.#localAddress.transport },
        id,
      };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#listener.close();
    } catch {
      // Already closed.
    }
  }
}

/** Where the host control plane listens. */
export type HostListen =
  | { readonly kind: "unix"; readonly socketPath: string }
  | { readonly kind: "tcp"; readonly hostname: string; readonly port: number };

/** Options for {@linkcode startHostControlServer}. */
export interface HostControlServerOptions
  extends Omit<HostControlWireOptions, "core"> {
  /** The domain core every connection's adapter shares. */
  readonly core: HostControlCore;
  /** UDS path or loopback TCP address to serve. */
  readonly listen: HostListen;
  /** Per-connection init/serve failures (default: swallowed). */
  readonly onConnectionError?: (error: unknown) => void;
  /** See {@linkcode HostAcceptSourceOptions.onTransportError}. */
  readonly onTransportError?: (error: unknown, connectionId: string) => void;
  readonly closeTimeoutMs?: number;
  /** Test seam: use this listener instead of binding `listen`. */
  readonly listener?: Deno.Listener;
}

/** Accept-loop lifecycle counters. */
export interface HostControlServerStats {
  readonly acceptedConnections: number;
  readonly activeConnections: number;
  readonly failedConnections: number;
}

/** A running host control wire server. */
export interface HostControlServerHandle {
  readonly listen: HostListen;
  readonly stats: HostControlServerStats;
  /** Stop accepting, abort + close every active session, remove the socket. */
  close(): Promise<void>;
}

interface ActiveConnection {
  readonly runtime: RpcServerRuntime;
  readonly gate: BootstrapGate;
  readonly connectionAbort: AbortController;
}

async function bindListener(
  listen: HostListen,
): Promise<{ listener: Deno.Listener; localAddress: Deno.Addr }> {
  if (listen.kind === "unix") {
    // Replace a stale socket file; refuse to clobber a non-socket path.
    const existing = await Deno.lstat(listen.socketPath).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    });
    if (existing !== null) {
      if (!existing.isSocket) {
        throw new WireValidationError(
          `refusing to replace non-socket path ${listen.socketPath}`,
        );
      }
      await Deno.remove(listen.socketPath);
    }
    const listener = Deno.listen({
      transport: "unix",
      path: listen.socketPath,
    });
    return {
      listener,
      localAddress: { transport: "unix", path: listen.socketPath },
    };
  }
  const listener = Deno.listen({
    transport: "tcp",
    hostname: listen.hostname,
    port: listen.port,
  });
  return { listener, localAddress: listener.addr };
}

/**
 * Bind the host control wire service. Each accepted connection gets a FRESH
 * bootstrap gate + adapter + connection-liveness controller; a transport that
 * dies closes its gate, aborts its controller (settling session leases), and
 * tears its runtime down.
 */
export async function startHostControlServer(
  options: HostControlServerOptions,
): Promise<HostControlServerHandle> {
  const bound = options.listener !== undefined
    ? {
      listener: options.listener,
      localAddress: options.listen.kind === "unix"
        ? { transport: "unix" as const, path: options.listen.socketPath }
        : options.listener.addr,
    }
    : await bindListener(options.listen);

  const connections = new Map<string, ActiveConnection>();
  const counters = { accepted: 0, failed: 0 };
  const reportConnectionError = (error: unknown): void => {
    options.onConnectionError?.(error);
  };

  const acceptor = new HostControlAcceptSource({
    listener: bound.listener,
    localAddress: bound.localAddress,
    ...(options.onTransportError === undefined
      ? { onTransportError: () => {} }
      : { onTransportError: options.onTransportError }),
    onAcceptError: reportConnectionError,
    onTransportClose: (connectionId) => {
      const connection = connections.get(connectionId);
      if (connection === undefined) return;
      connections.delete(connectionId);
      connection.gate.close();
      // Abort settles every "session" lease bound to this connection.
      connection.connectionAbort.abort();
      void connection.runtime.close().catch(reportConnectionError);
    },
    ...(options.closeTimeoutMs === undefined
      ? {}
      : { closeTimeoutMs: options.closeTimeoutMs }),
  });

  const serveAccepted = async (
    accepted: RpcAcceptedTransport,
  ): Promise<void> => {
    counters.accepted++;
    const connectionId = accepted.id ?? `hostd-conn-${counters.accepted}`;
    try {
      const connection = createHostControlWireConnection(options);
      const runtime = await RpcServerRuntime.createWithRoot(
        accepted.transport,
        HostBootstrapToken.registerServer,
        connection.bootstrap,
        {
          bridgeOptions: { onUnhandledError: reportConnectionError },
        },
      );
      connections.set(connectionId, {
        runtime,
        gate: connection.gate,
        connectionAbort: connection.connectionAbort,
      });
    } catch (error) {
      counters.failed++;
      reportConnectionError(error);
      await Promise.resolve(accepted.transport.close()).catch(() => {});
    }
  };

  const acceptLoop = (async () => {
    try {
      for await (const accepted of acceptor.accept()) {
        await serveAccepted(accepted);
      }
    } catch (error) {
      reportConnectionError(error);
    }
  })();

  let closed = false;
  return {
    listen: options.listen,
    get stats(): HostControlServerStats {
      return {
        acceptedConnections: counters.accepted,
        activeConnections: connections.size,
        failedConnections: counters.failed,
      };
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      acceptor.close();
      await acceptLoop.catch(reportConnectionError);
      const active = [...connections.values()];
      connections.clear();
      for (const connection of active) {
        connection.gate.close();
        connection.connectionAbort.abort();
        await connection.runtime.close().catch(reportConnectionError);
      }
      if (options.listen.kind === "unix") {
        await Deno.remove(options.listen.socketPath).catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface HostdFlags {
  listen: HostListen;
  tunnelListen: TunnelListenSpec;
  rootdSocket: string;
  tokenFile: string;
  rootdTokenFile: string;
  buildId: string;
  compat: string;
}

/** Parse studiobox-hostd CLI flags (exported for unit coverage). */
export function parseHostdFlags(args: readonly string[]): HostdFlags {
  let socket: string | undefined;
  let listenAddr: string | undefined;
  let rootdSocket: string | undefined;
  let tokenFile: string | undefined;
  let rootdTokenFile: string | undefined;
  let buildId: string | undefined;
  let compat: string | undefined;
  let tunnelListen: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const take = (name: string): string => {
      const inline = `--${name}=`;
      if (arg.startsWith(inline)) return arg.slice(inline.length);
      const next = args[++i];
      if (next === undefined) {
        throw new WireValidationError(`--${name} needs a value`);
      }
      return next;
    };
    if (arg === "--socket" || arg.startsWith("--socket=")) {
      socket = take("socket");
    } else if (arg === "--listen" || arg.startsWith("--listen=")) {
      listenAddr = take("listen");
    } else if (arg === "--rootd-socket" || arg.startsWith("--rootd-socket=")) {
      rootdSocket = take("rootd-socket");
    } else if (arg === "--token-file" || arg.startsWith("--token-file=")) {
      tokenFile = take("token-file");
    } else if (
      arg === "--rootd-token-file" || arg.startsWith("--rootd-token-file=")
    ) {
      rootdTokenFile = take("rootd-token-file");
    } else if (arg === "--build-id" || arg.startsWith("--build-id=")) {
      buildId = take("build-id");
    } else if (arg === "--compat" || arg.startsWith("--compat=")) {
      compat = take("compat");
    } else if (
      arg === "--tunnel-listen" || arg.startsWith("--tunnel-listen=")
    ) {
      tunnelListen = take("tunnel-listen");
    } else {
      throw new WireValidationError(`unknown flag: ${arg}`);
    }
  }

  if (socket === undefined && listenAddr === undefined) {
    throw new WireValidationError("one of --socket or --listen is required");
  }
  if (socket !== undefined && listenAddr !== undefined) {
    throw new WireValidationError(
      "--socket and --listen are mutually exclusive",
    );
  }
  if (rootdSocket === undefined) {
    throw new WireValidationError("--rootd-socket <path> is required");
  }
  if (tokenFile === undefined) {
    throw new WireValidationError("--token-file <path> is required");
  }
  if (rootdTokenFile === undefined) {
    throw new WireValidationError("--rootd-token-file <path> is required");
  }
  return {
    listen: socket !== undefined
      ? { kind: "unix", socketPath: socket }
      : parseTcpListen(listenAddr!),
    tunnelListen: tunnelListen === undefined
      ? DEFAULT_TUNNEL_LISTEN
      : parseTunnelListen(tunnelListen),
    rootdSocket,
    tokenFile,
    rootdTokenFile,
    buildId: buildId ?? BUILD_ID_DEFAULT,
    compat: compat ??
      fromFileUrl(import.meta.resolve("../../compat/wire.json")),
  };
}

/** Parse `--tunnel-listen host:port` into a {@link TunnelListenSpec}. */
function parseTunnelListen(value: string): TunnelListenSpec {
  const at = value.lastIndexOf(":");
  if (at <= 0) {
    throw new WireValidationError("--tunnel-listen must be host:port");
  }
  const hostname = value.slice(0, at);
  const port = Number.parseInt(value.slice(at + 1), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WireValidationError("--tunnel-listen port must be 1..65535");
  }
  return { transport: "tcp", hostname, port };
}

function parseTcpListen(value: string): HostListen {
  const at = value.lastIndexOf(":");
  if (at <= 0) {
    throw new WireValidationError("--listen must be host:port");
  }
  const hostname = value.slice(0, at);
  const port = Number.parseInt(value.slice(at + 1), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WireValidationError("--listen port must be 1..65535");
  }
  return { kind: "tcp", hostname, port };
}

/** Decode the 64-hex-char bootstrap credential (exported for tests). */
export function parseHostToken(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    throw new WireValidationError(
      "the token file must hold exactly 64 hexadecimal characters",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function main(): Promise<void> {
  let flags: HostdFlags;
  try {
    flags = parseHostdFlags(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
      "\nusage: studiobox-hostd (--socket <path> | --listen <host:port>) --rootd-socket <path> --token-file <path> --rootd-token-file <path> [--build-id <id>] [--compat <path>]",
    );
    Deno.exit(2);
    return;
  }

  const compat = JSON.parse(
    await Deno.readTextFile(flags.compat),
  ) as HostCompatIdentitySource;
  const identity = await buildHostContractIdentity(compat, {
    buildId: flags.buildId,
  });
  // The rootd-facing peer identity is a SUPERVISOR identity: the supervisor
  // client's `negotiate` requires SUPERVISOR_FEATURE_BITS, and rootd advertises
  // the supervisor plane — offering a HOST identity (HOST_FEATURE_BITS) makes
  // rootd reject the handshake with "required peer features are unavailable".
  const rootdIdentity = await buildSupervisorContractIdentity(compat, {
    buildId: flags.buildId,
  });
  const credential = parseHostToken(await Deno.readTextFile(flags.tokenFile));
  const rootdCredential = parseHostToken(
    await Deno.readTextFile(flags.rootdTokenFile),
  );

  // Open the bounded rootd supervisor client (fails typed if rootd is down).
  let session: SupervisorSession;
  try {
    session = await connectSupervisorSession(flags.rootdSocket, {
      identity: rootdIdentity,
      credential: rootdCredential,
    });
  } catch (error) {
    console.error(
      `studiobox-hostd could not reach rootd at ${flags.rootdSocket}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
    return;
  }

  // The tunnel bridge factory (PLAN.md §M8): every burned ticket asks rootd to
  // `openBridge` over this same session and dials the credential-authenticated
  // bridge UDS, so `HostSandbox.openTunnel` now reaches the guest agent instead
  // of failing typed-unimplemented.
  const core = new HostControlCore({
    gateway: session,
    bridgeFactory: new WireBridgeFactory(session),
    tunnelListen: flags.tunnelListen,
  });
  const server = await startHostControlServer({
    listen: flags.listen,
    core,
    identity,
    credential,
    onConnectionError: (error) => {
      console.error(
        `hostd connection error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Revoke leases + tickets SILENTLY before closing sessions: rootd's
    // destructive reconcile reclaims the orphaned executions on the next start.
    core.revokeAll();
    await server.close();
    // Tear down the shared tunnel router (frees the static listener + socket).
    await core.closeAllTunnels().catch(() => {});
    await session.close().catch(() => {});
    Deno.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => void shutdown());
  }

  const listenLabel = flags.listen.kind === "unix"
    ? flags.listen.socketPath
    : `${flags.listen.hostname}:${flags.listen.port}`;
  console.log(JSON.stringify({
    "studiobox-hostd": {
      buildId: flags.buildId,
      listen: listenLabel,
      rootdSocket: flags.rootdSocket,
      pid: Deno.pid,
    },
  }));
}

if (import.meta.main) {
  await main();
}
