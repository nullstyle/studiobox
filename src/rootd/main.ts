/**
 * studiobox-rootd — the root supervisor entrypoint (DESIGN.md §3).
 *
 * Serves `schema/supervisor.capnp` (`SupervisorBootstrap` → `Supervisor`)
 * over ONE Unix-domain socket via the wire adapter in `./service.ts`,
 * delegating every method to a {@linkcode SupervisorApi} domain core.
 *
 * ## Socket ownership (real host)
 *
 * On a production host the socket lives in a root-owned directory (e.g.
 * `/run/studiobox/`) with the socket file chmod'd `0660 root:studiobox` so
 * only studiobox-hostd's group can even dial it; the bootstrap gate's
 * negotiate/authenticate flow is the second, fail-closed layer. Tests and
 * dev hosts bind under `/tmp` instead (sun_path is ~104 bytes on macOS —
 * keep the path short) and rely on the gate alone.
 *
 * ## Transport ownership (pinned M1 contract)
 *
 * Every accepted transport is constructed with BOTH `onClose` and `onError`
 * wired (see `tests/unit/rpc_conformance/transport_close_ownership_test.ts`):
 * `onError` because an out-of-band conn destruction otherwise escapes as a
 * global unhandledrejection, `onClose` so the connection's bootstrap gate
 * fails closed and its runtime is torn down the moment its transport dies.
 *
 * ## Why the accept loop drives `RpcServerRuntime` directly
 *
 * Each accepted transport gets its own `RpcServerRuntime.createWithRoot`
 * registering the connection's generated `SupervisorBootstrap` root; the
 * gated `Supervisor` is exported fresh, wire-managed, per
 * `bootstrap.supervisor()` call (capnp 0.3.0 — see the handout note in
 * `./service.ts`). The single-token root shape is exactly what the
 * package-level `serve()` binds, and the accept source keeps the shape
 * `serve()` expects (`Parameters<typeof serve>[1]`) — the loop stays
 * hand-rolled anyway because it owns behavior `serve()` does not express
 * 1:1: closing each connection's bootstrap gate the moment its transport
 * dies, surviving transient accept faults, and the pinned
 * accepted/active/failed stats surface.
 *
 * ## Shutdown
 *
 * SIGTERM/SIGINT: stop accepting, close active sessions, then run one
 * destructive reconcile sweep with the core's refusal semantics AS-IS — if
 * operations are still in flight the sweep refuses (`SBX_SUP_UNAVAILABLE`)
 * and the journal converges on the next start's sweep instead.
 *
 * Flags: `--socket <path>` (required), `--state <path>` (required journal
 * file), `--token-file <path>` (required; 64 hex chars = the 32-byte
 * bootstrap credential), `--build-id <id>` (default `dev`), `--compat
 * <path>` (default: the repo's `compat/wire.json` next to this module).
 *
 * Launch planning (resolving artifact/allocation ids to jailer plans) is
 * the {@linkcode GoldenArtifactLaunchPlanner}, configured via
 * `--launch-config <path>` (the JSON mirrors its options: artifact cache
 * root, golden manifest hash, jailer/firecracker bins, uid/gid, chroot
 * base, overlay dir, guest resources, vsock port). Without the flag the
 * entrypoint keeps the pre-M5 behavior — `launch` refuses with
 * `SBX_SUP_UNAVAILABLE` while every other supervisor method
 * (status/usage/kill/reconcile/health/ping/openBridge) stays live.
 *
 * @module
 */

import { fromFileUrl } from "@std/path";
import { RpcServerRuntime, TcpTransport } from "@nullstyle/capnp";
import type { RpcAcceptedTransport, serve } from "@nullstyle/capnp";
import type { BootstrapGate } from "../wire/bootstrap_gate.ts";
import { WireValidationError } from "../wire/contract.ts";
import { SupervisorBootstrap as SupervisorBootstrapToken } from "../wire/generated/supervisor_types.ts";
import {
  buildSupervisorContractIdentity,
  createSupervisorWireConnection,
  type SupervisorCompatIdentitySource,
  type SupervisorWireOptions,
} from "./service.ts";
import {
  type ReclaimHook,
  SupervisorCore,
  type SupervisorLaunchPlanner,
} from "./supervisor_core.ts";
import { SupervisorError } from "./supervisor_core_api.ts";
import {
  GoldenArtifactLaunchPlanner,
  type GoldenArtifactLaunchPlannerOptions,
} from "./launch_planner.ts";
import { ArtifactCache } from "../../images/cache.ts";
import { JsonFileSandboxStore } from "../state/store.ts";

const BUILD_ID_DEFAULT = "dev";
const TRANSPORT_CLOSE_TIMEOUT_MS = 5_000;

// `RpcTransportAcceptSource` is not exported by the package; the pinned
// M1 pattern types custom acceptors structurally via serve()'s signature.
type SupervisorAcceptSource = Parameters<typeof serve>[1];

/** Hooks the accept loop wires onto every accepted transport. */
export interface UdsAcceptSourceOptions {
  /**
   * Observes read-loop faults (conn destroyed out of band, resets). REQUIRED
   * wiring per the pinned ownership contract — without a handler these
   * escape as global unhandled rejections. Defaults to a swallow.
   */
  readonly onTransportError?: (error: unknown, connectionId: string) => void;
  /** Fires once per transport when it closes (EOF or local close). */
  readonly onTransportClose?: (connectionId: string) => void;
  /**
   * Reports a transient per-accept fault that the loop SURVIVED (logged the
   * error, skipped the peer, and kept accepting). `Deno.Listener.accept()`
   * can throw a transient fault that is NOT a listener close — on macOS a
   * peer that connects and immediately closes can race the accept into
   * `EINVAL` (`Invalid argument (os error 22)`). Such a fault must never tear
   * the accept loop down; only an intentional close ends it.
   */
  readonly onAcceptError?: (error: unknown) => void;
  readonly closeTimeoutMs?: number;
  /**
   * Test seam: use this listener instead of binding `path` via `Deno.listen`.
   * Production always omits it (the source binds the UDS itself).
   */
  readonly listener?: Deno.Listener;
}

/**
 * Hand-rolled UDS accept source for `serve()`: wraps every accepted
 * `Deno.Conn` in a `TcpTransport` with `onClose`/`onError` wired per the
 * pinned M1 transport-ownership contract.
 */
export class UdsSupervisorAcceptSource implements SupervisorAcceptSource {
  readonly #listener: Deno.Listener;
  readonly #path: string;
  readonly #options: UdsAcceptSourceOptions;
  #closed = false;
  #nextId = 0;

  constructor(path: string, options: UdsAcceptSourceOptions = {}) {
    this.#path = path;
    this.#options = options;
    this.#listener = options.listener ??
      Deno.listen({ transport: "unix", path });
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
          // The listener was closed out from under us; end the loop.
          return;
        }
        // Transient per-accept fault (e.g. a connect-then-close race
        // surfacing as EINVAL, or fd pressure): report it and keep
        // accepting. One broken peer must never tear down the supervisor
        // accept loop — re-throwing here would reject the (largely
        // unawaited) accept-loop promise as a global unhandled rejection
        // AND stop the supervisor from serving.
        this.#options.onAcceptError?.(error);
        continue;
      }
      const id = `rootd-uds-${this.#nextId++}`;
      const transport = new TcpTransport(conn, {
        closeTimeoutMs: this.#options.closeTimeoutMs ??
          TRANSPORT_CLOSE_TIMEOUT_MS,
        onClose: () => this.#options.onTransportClose?.(id),
        onError: (error) => this.#options.onTransportError?.(error, id),
      });
      yield {
        transport,
        localAddress: { transport: "unix", path: this.#path },
        remoteAddress: { transport: "unix" },
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

/** Options for {@linkcode startSupervisorServer}. */
export interface SupervisorServerOptions extends SupervisorWireOptions {
  /** Absolute UDS path (keep short; sun_path is ~104 bytes on macOS). */
  readonly socketPath: string;
  /** Per-connection init/serve failures (default: swallowed). */
  readonly onConnectionError?: (error: unknown) => void;
  /** See {@linkcode UdsAcceptSourceOptions.onTransportError}. */
  readonly onTransportError?: (error: unknown, connectionId: string) => void;
  readonly closeTimeoutMs?: number;
}

/** Accept-loop lifecycle counters. */
export interface SupervisorServerStats {
  readonly acceptedConnections: number;
  readonly activeConnections: number;
  readonly failedConnections: number;
}

/** A running supervisor wire server. */
export interface SupervisorServerHandle {
  readonly socketPath: string;
  readonly stats: SupervisorServerStats;
  /** Stop accepting, close every active session, remove the socket file. */
  close(): Promise<void>;
}

interface ActiveConnection {
  readonly runtime: RpcServerRuntime;
  readonly gate: BootstrapGate;
}

/**
 * Bind the supervisor wire service to a UDS path. Each accepted connection
 * gets a FRESH bootstrap gate + service pair (root `SupervisorBootstrap`;
 * the gated `Supervisor` is exported per `supervisor()` handout); a
 * transport that dies closes its gate and tears its runtime down
 * (fail-closed hygiene).
 */
export async function startSupervisorServer(
  options: SupervisorServerOptions,
): Promise<SupervisorServerHandle> {
  // Replace a stale socket file from a previous run; refuse to clobber
  // anything that is not a socket.
  const existing = await Deno.lstat(options.socketPath).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
  if (existing !== null) {
    if (!existing.isSocket) {
      throw new WireValidationError(
        `refusing to replace non-socket path ${options.socketPath}`,
      );
    }
    await Deno.remove(options.socketPath);
  }

  const connections = new Map<string, ActiveConnection>();
  const counters = { accepted: 0, failed: 0 };
  const reportConnectionError = (error: unknown): void => {
    options.onConnectionError?.(error);
  };

  const acceptor = new UdsSupervisorAcceptSource(options.socketPath, {
    ...(options.onTransportError === undefined
      ? { onTransportError: () => {} }
      : { onTransportError: options.onTransportError }),
    // A transient accept fault (e.g. a connect-then-close race → EINVAL) is
    // survived by the loop; surface it on the same channel as per-connection
    // faults instead of letting it escape.
    onAcceptError: reportConnectionError,
    onTransportClose: (connectionId) => {
      const connection = connections.get(connectionId);
      if (connection === undefined) return;
      connections.delete(connectionId);
      connection.gate.close();
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
    // The UDS accept source always stamps an id; the fallback only guards
    // the structural type.
    const connectionId = accepted.id ?? `rootd-conn-${counters.accepted}`;
    try {
      const connection = createSupervisorWireConnection(options);
      const runtime = await RpcServerRuntime.createWithRoot(
        accepted.transport,
        SupervisorBootstrapToken.registerServer,
        connection.bootstrap,
        {
          bridgeOptions: {
            // Without this hook, an async dispatch-response failure is
            // swallowed and the caller hangs invisibly. Surface it.
            onUnhandledError: reportConnectionError,
          },
        },
      );
      connections.set(connectionId, { runtime, gate: connection.gate });
    } catch (error) {
      counters.failed++;
      reportConnectionError(error);
      await Promise.resolve(accepted.transport.close()).catch(() => {});
    }
  };

  const acceptLoop = (async () => {
    try {
      for await (const accepted of acceptor.accept()) {
        // Sequential setup: runtime construction is fast (no I/O beyond the
        // WASM peer), and rootd expects exactly one long-lived hostd peer.
        // `serveAccepted` isolates every per-connection fault internally, so
        // one bad peer can never crash the supervisor.
        await serveAccepted(accepted);
      }
    } catch (error) {
      // The resilient accept source only ends by returning (never throws),
      // and `serveAccepted` swallows its own faults — so this is belt-and-
      // braces: an unexpected loop fault is reported, never escaping as a
      // global unhandled rejection on this largely-unawaited promise.
      reportConnectionError(error);
    }
  })();

  let closed = false;
  return {
    socketPath: options.socketPath,
    get stats(): SupervisorServerStats {
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
        await connection.runtime.close().catch(reportConnectionError);
      }
      await Deno.remove(options.socketPath).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface RootdFlags {
  socket: string;
  state: string;
  tokenFile: string;
  buildId: string;
  compat: string;
  /** Optional path to the JSON launch-planner config (see below). */
  launchConfig?: string;
}

/**
 * JSON shape of `--launch-config`: everything the real
 * {@linkcode GoldenArtifactLaunchPlanner} needs to stage + boot the golden
 * artifact set. `artifactCache` is the cache root; the rest mirror
 * {@linkcode GoldenArtifactLaunchPlannerOptions} minus the `cache` handle.
 */
interface LaunchPlannerConfig extends
  Omit<
    GoldenArtifactLaunchPlannerOptions,
    "cache" | "resolveManifestHash" | "mintCredential"
  > {
  readonly artifactCache: string;
}

/** Parse studiobox-rootd CLI flags (exported for unit coverage). */
export function parseRootdFlags(args: readonly string[]): RootdFlags {
  const flags: Partial<RootdFlags> = {};
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
      flags.socket = take("socket");
    } else if (arg === "--state" || arg.startsWith("--state=")) {
      flags.state = take("state");
    } else if (arg === "--token-file" || arg.startsWith("--token-file=")) {
      flags.tokenFile = take("token-file");
    } else if (arg === "--build-id" || arg.startsWith("--build-id=")) {
      flags.buildId = take("build-id");
    } else if (arg === "--compat" || arg.startsWith("--compat=")) {
      flags.compat = take("compat");
    } else if (
      arg === "--launch-config" || arg.startsWith("--launch-config=")
    ) {
      flags.launchConfig = take("launch-config");
    } else {
      throw new WireValidationError(`unknown flag: ${arg}`);
    }
  }
  if (flags.socket === undefined) {
    throw new WireValidationError("--socket <path> is required");
  }
  if (flags.state === undefined) {
    throw new WireValidationError("--state <path> is required");
  }
  if (flags.tokenFile === undefined) {
    throw new WireValidationError("--token-file <path> is required");
  }
  return {
    socket: flags.socket,
    state: flags.state,
    tokenFile: flags.tokenFile,
    buildId: flags.buildId ?? BUILD_ID_DEFAULT,
    compat: flags.compat ??
      fromFileUrl(import.meta.resolve("../../compat/wire.json")),
    ...(flags.launchConfig === undefined
      ? {}
      : { launchConfig: flags.launchConfig }),
  };
}

/** Decode the 64-hex-char bootstrap credential (exported for tests). */
export function parseSupervisorToken(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    throw new WireValidationError(
      "the token file must hold exactly 64 hexadecimal characters",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(
      trimmed.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

/**
 * Fallback planner when `--launch-config` is omitted: `launch` fails fast
 * (as before M5) while every other supervisor method — status / usage /
 * kill / reconcile / health / ping / openBridge — stays live. Configure a
 * launch config to enable real jailed launches.
 */
const LAUNCH_PLANNING_UNCONFIGURED: SupervisorLaunchPlanner = {
  resolve: () =>
    Promise.reject(
      new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        "launch planning is not configured; pass --launch-config <path>",
      ),
    ),
};

/**
 * Build the real launch planner + its reclaim hook from the JSON config.
 * The reclaim hook releases the artifact refcount and deletes the per-boot
 * overlay when a record reaches a terminal phase.
 */
async function loadLaunchPlanner(
  path: string,
): Promise<{ planner: GoldenArtifactLaunchPlanner; reclaimHook: ReclaimHook }> {
  const config = JSON.parse(
    await Deno.readTextFile(path),
  ) as LaunchPlannerConfig;
  const { artifactCache, ...rest } = config;
  const planner = new GoldenArtifactLaunchPlanner({
    ...rest,
    cache: new ArtifactCache({ root: artifactCache }),
  });
  return { planner, reclaimHook: planner.reclaimHook };
}

async function main(): Promise<void> {
  let flags: RootdFlags;
  try {
    flags = parseRootdFlags(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
      "\nusage: studiobox-rootd --socket <path> --state <path> --token-file <path> [--build-id <id>] [--compat <path>]",
    );
    Deno.exit(2);
  }

  const compat = JSON.parse(
    await Deno.readTextFile(flags.compat),
  ) as SupervisorCompatIdentitySource;
  const identity = await buildSupervisorContractIdentity(compat, {
    buildId: flags.buildId,
  });
  const credential = parseSupervisorToken(
    await Deno.readTextFile(flags.tokenFile),
  );

  const launch: {
    planner: SupervisorLaunchPlanner;
    reclaimHook?: ReclaimHook;
  } = flags.launchConfig === undefined
    ? { planner: LAUNCH_PLANNING_UNCONFIGURED }
    : await loadLaunchPlanner(flags.launchConfig);
  const core = new SupervisorCore({
    store: new JsonFileSandboxStore(flags.state),
    planner: launch.planner,
    ...(launch.reclaimHook === undefined
      ? {}
      : { reclaimHooks: [launch.reclaimHook] }),
    buildId: flags.buildId,
  });

  const server = await startSupervisorServer({
    socketPath: flags.socket,
    api: core,
    identity,
    credential,
    onConnectionError: (error) => {
      console.error(
        `rootd connection error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop accepting and close sessions first so no new operation can
    // start, then sweep. The core's refusal semantics run AS-IS: with
    // operations still in flight the sweep refuses and the next start's
    // destructive reconcile converges the journal instead.
    await server.close();
    try {
      const summary = await core.reconcile();
      console.error(
        `rootd shutdown sweep: examined=${summary.examined} killed=${summary.killed} reclaimed=${summary.reclaimed} quarantined=${summary.quarantined}`,
      );
    } catch (error) {
      if (
        error instanceof SupervisorError &&
        error.code === "SBX_SUP_UNAVAILABLE"
      ) {
        console.error(
          "rootd shutdown sweep refused (operations in flight); the journal converges on the next start",
        );
      } else {
        console.error(
          `rootd shutdown sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        Deno.exit(1);
      }
    }
    Deno.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => void shutdown());
  }

  // Ready line (consumed by smoke tooling and process supervisors).
  console.log(JSON.stringify({
    "studiobox-rootd": {
      buildId: flags.buildId,
      socket: flags.socket,
      state: flags.state,
      pid: Deno.pid,
    },
  }));
}

if (import.meta.main) {
  await main();
}
