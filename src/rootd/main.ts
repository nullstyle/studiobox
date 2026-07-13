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

import { fromFileUrl, join } from "@std/path";
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
  DEFAULT_AGENT_VSOCK_PORT,
  GoldenArtifactLaunchPlanner,
  type GoldenArtifactLaunchPlannerOptions,
} from "./launch_planner.ts";
import {
  BitmapSubnetAllocator,
  DenoCommandEnumerator,
  DenoPidfileLister,
  DnsmasqController,
  EgressController,
  NetworkController,
  type NetworkOrphanSweepResult,
  PortForwardController,
  reserveLiveSlots,
  type SubnetAllocator,
  sweepNetworkOrphans,
} from "./network/mod.ts";
import type { PortForwardInstaller } from "./supervisor_core.ts";
import { TemplateStore } from "./template/mod.ts";
import {
  firecrackerSupportsSnapshotRestore,
  probeFirecrackerVersion,
} from "./firecracker_version.ts";
import type { SandboxRecord } from "../state/model.ts";
import { BridgeServer } from "./bridge_server.ts";
import { DEFAULT_BRIDGE_DIAL_TIMEOUT_MS } from "./bridge.ts";
import { BRIDGE_SOCKET_ROOT } from "../wire/supervisor.ts";
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

  /** Bind (or adopt) the UDS at `path` and prepare the accept loop. */
  constructor(path: string, options: UdsAcceptSourceOptions = {}) {
    this.#path = path;
    this.#options = options;
    this.#listener = options.listener ??
      Deno.listen({ transport: "unix", path });
  }

  /** Whether {@link close} has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Yield each accepted connection wrapped as a transport, until closed. */
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

  /** Stop accepting and close the listener (idempotent). */
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
  /** Per-transport graceful-close budget (ms). */
  readonly closeTimeoutMs?: number;
}

/** Accept-loop lifecycle counters. */
export interface SupervisorServerStats {
  /** Connections accepted since start. */
  readonly acceptedConnections: number;
  /** Connections currently open. */
  readonly activeConnections: number;
  /** Connections that failed init or serve. */
  readonly failedConnections: number;
}

/** A running supervisor wire server. */
export interface SupervisorServerHandle {
  /** The UDS path the server is listening on. */
  readonly socketPath: string;
  /** Live accept-loop counters. */
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
 * {@linkcode GoldenArtifactLaunchPlannerOptions} minus the `cache` handle and
 * the live `dataplane` (which is built here from the network fields below).
 *
 * The Tier-B network dataplane (M10 §W4) is enabled when `upstreamDns` is set
 * (JSON here or the `STUDIOBOX_UPSTREAM_DNS` env var) AND the deploy is not
 * `netlessOnly`; otherwise the planner keeps the pre-M10 vsock-only behavior.
 */
interface LaunchPlannerConfig extends
  Omit<
    GoldenArtifactLaunchPlannerOptions,
    | "cache"
    | "resolveManifestHash"
    | "mintCredential"
    | "dataplane"
    | "templateStore"
    | "schemaSha256"
    | "firecrackerVersion"
  > {
  readonly artifactCache: string;
  /** Enables the dataplane; the per-sandbox dnsmasq upstream resolver. */
  readonly upstreamDns?: string;
  /** Pool CIDR carved into `/30`s (default `10.201.0.0/16`); must not overlap host bridges. */
  readonly poolCidr?: string;
  /** Force the pre-M10 vsock-only path even when `upstreamDns` is configured. */
  readonly netlessOnly?: boolean;
  /**
   * Snapshot-restore strategy (snapshot-restore §5.1). `"cold"` (default)
   * always cold-boots — byte-identical to pre-snapshot rootd. `"snapshot"` opts
   * in to warm-template restore, gated below by BOTH the Firecracker ≥ v1.16
   * version check (§5.5) AND a per-request template-valid + networked check in
   * the planner (§5.3, §5.4); a template problem always falls SAFE to cold.
   * @default "cold"
   */
  readonly launchStrategy?: "cold" | "snapshot";
  /**
   * Where warm-template dirs (`<hash>/`) live (snapshot-restore §1.2). Defaults
   * to `<artifactCache>/templates`. Only consulted for the `"snapshot"` strategy.
   */
  readonly templateCacheDir?: string;
  /**
   * OPTIONAL operator override for the installed Firecracker version used by the
   * ≥ v1.16 `vsock_override` gate (§5.5, FINDING 3). When ABSENT (the norm)
   * {@linkcode loadLaunchPlanner} PROBES the real `firecracker --version` binary
   * for ground truth rather than trusting a default — so a real v1.15 host can
   * never wrongly select snapshot. Set this only to pin a known-verified version
   * (or as a deterministic test seam); any uncertainty still falls safe to cold.
   */
  readonly firecrackerVersion?: string;
}

// The Firecracker version helpers (comparison + the ≥ v1.16 snapshot gate) live
// in `./firecracker_version.ts` so the planner can share them without a circular
// import; re-export them here for callers (and the existing gate tests) that
// reach them through the entrypoint.
export {
  compareFirecrackerVersions,
  firecrackerSupportsSnapshotRestore,
  MIN_SNAPSHOT_FIRECRACKER_VERSION,
  parseFirecrackerVersionOutput,
  probeFirecrackerVersion,
} from "./firecracker_version.ts";

/** What {@linkcode loadLaunchPlanner} hands back to {@linkcode main}. */
interface LoadedLaunchPlanner {
  readonly planner: SupervisorLaunchPlanner;
  /**
   * Reclaim hooks in registration order — network FIRST (§8) when the dataplane
   * is configured, then the artifact/overlay hook. Empty when launch planning
   * is unconfigured.
   */
  readonly reclaimHooks: readonly ReclaimHook[];
  /**
   * The subnet allocator to rebuild from the journal on cold start (§8), or
   * `undefined` when no dataplane is configured.
   */
  readonly allocator?: SubnetAllocator;
  /**
   * Installs the per-sandbox exposeHttp DNAT/SNAT for
   * {@linkcode import("./supervisor_core.ts").SupervisorCore.exposeHttp} (§6),
   * or `undefined` when no dataplane is configured (exposeHttp then fails
   * typed-unavailable). The SAME instance backs the {@linkcode NetworkReclaimHook}
   * so a forward is reclaimed by the exact name it was installed under.
   */
  readonly portForward?: PortForwardInstaller;
  /**
   * Installs the shared NAT / isolation / host-guard seal once before launches
   * are accepted (§3, §12), or `undefined` when no dataplane is configured.
   */
  readonly ensureGlobal?: () => Promise<void>;
  /**
   * Reap host dataplane state (TAP / egress table / dnsmasq) orphaned by a crash
   * between provisioning and the resource-journal CAS (§6, §8), or `undefined`
   * when no dataplane is configured. Given the full cold-start journal so it can
   * tell an orphan from a resource a surviving record still owns.
   */
  readonly sweepNetworkOrphans?: (
    records: readonly SandboxRecord[],
  ) => Promise<NetworkOrphanSweepResult>;
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
 * Build the real launch planner + its reclaim hooks from the JSON config. When
 * the Tier-B dataplane is configured (see {@linkcode LaunchPlannerConfig}) the
 * planner is given the W1 controllers (real `Deno`-backed seams), the network
 * reclaim hook is registered BEFORE the artifact hook (§8), and the allocator +
 * `ensureGlobal` are surfaced for cold-start rebuild + the one-time seal. When
 * it is not, the pre-M10 vsock-only planner is returned unchanged.
 */
async function loadLaunchPlanner(
  path: string,
  options: {
    readonly schemaSha256: string;
    /**
     * Ground-truth Firecracker version probe (§5.5, FINDING 3). Defaults to the
     * real {@linkcode probeFirecrackerVersion} (`firecracker --version`); a test
     * injects a deterministic result. Only invoked when the `"snapshot"`
     * strategy is selected AND the config supplies no explicit override.
     */
    readonly probeFirecrackerVersion?: (bin: string) => Promise<string>;
  },
): Promise<LoadedLaunchPlanner> {
  const config = JSON.parse(
    await Deno.readTextFile(path),
  ) as LaunchPlannerConfig;
  const {
    artifactCache,
    upstreamDns,
    poolCidr,
    netlessOnly,
    launchStrategy,
    templateCacheDir,
    firecrackerVersion,
    ...rest
  } = config;
  const cache = new ArtifactCache({ root: artifactCache });

  // Snapshot-restore version gate (§5.5, FINDING 3): the gate must depend on
  // GROUND TRUTH, not a config field that defaults to the pinned version — else
  // a real v1.15 host wastefully selects snapshot (self-healing only via the
  // cold fallback). So when the "snapshot" strategy is requested we PROBE the
  // actual `firecracker --version` binary; an explicit config `firecrackerVersion`
  // is honored as a deliberate operator override. Any uncertainty (probe fails /
  // unparseable / < v1.16) falls SAFE to cold, keeping the byte-identical cold
  // path. The probed version is ALSO handed to the planner so it can reject a
  // template captured under an incompatible fc version (§5.5, FINDING 5). The
  // per-request template-valid + networked check happens in the planner (§5.3,
  // §5.4).
  const probe = options.probeFirecrackerVersion ?? probeFirecrackerVersion;
  let effectiveFcVersion: string | undefined = firecrackerVersion;
  if (launchStrategy === "snapshot" && effectiveFcVersion === undefined) {
    effectiveFcVersion = await probe(rest.firecrackerBin).catch(() =>
      undefined
    );
  }
  const snapshotSelected = launchStrategy === "snapshot" &&
    effectiveFcVersion !== undefined &&
    firecrackerSupportsSnapshotRestore(effectiveFcVersion);
  const templateRoot = templateCacheDir ?? join(artifactCache, "templates");
  // A restore re-points eth0 via network_overrides, so it needs a dataplane; the
  // store is wired ONLY on the dataplane branch below (else it stays cold).
  const snapshotPlannerOptions = snapshotSelected
    ? {
      launchStrategy: "snapshot" as const,
      templateStore: new TemplateStore({ root: templateRoot }),
      schemaSha256: options.schemaSha256,
      // Ground-truth host version for the planner's template fc-compat gate
      // (§5.5, FINDING 5). `snapshotSelected` guarantees it is defined.
      firecrackerVersion: effectiveFcVersion!,
    }
    : {};

  const resolvedUpstream = upstreamDns ??
    Deno.env.get("STUDIOBOX_UPSTREAM_DNS");
  const resolvedPool = poolCidr ?? Deno.env.get("STUDIOBOX_POOL_CIDR");
  // Netless-only, or no upstream resolver configured ⇒ dataplane off: today's
  // behavior (vsock-only launches, artifact hook only). Snapshot needs a TAP to
  // re-point, so a dataplane-less deploy stays cold regardless of strategy.
  if (netlessOnly === true || resolvedUpstream === undefined) {
    const planner = new GoldenArtifactLaunchPlanner({ ...rest, cache });
    return { planner, reclaimHooks: [planner.reclaimHook] };
  }

  const poolOptions = resolvedPool === undefined
    ? {}
    : { poolCidr: resolvedPool };
  const allocator = new BitmapSubnetAllocator(poolOptions);
  const network = new NetworkController(poolOptions);
  const dnsmasq = new DnsmasqController();
  const egress = new EgressController();
  // ONE port-forward controller: it INSTALLS exposeHttp forwards for the
  // SupervisorCore and RECLAIMS them from the NetworkReclaimHook, so an
  // exposed port is torn down by the exact `sbx_pf_<id>` name it was installed
  // under (§6, §8).
  const portForward = new PortForwardController();
  const planner = new GoldenArtifactLaunchPlanner({
    ...rest,
    cache,
    dataplane: {
      allocator,
      network,
      dnsmasq,
      egress,
      portForward,
      upstreamDns: resolvedUpstream,
    },
    ...snapshotPlannerOptions,
  });
  // Network hook FIRST (§8): reclaim the TAP / egress table / dnsmasq before the
  // overlay + artifact refcount. The template-refcount hook (snapshot-restore
  // §1.2) is appended when the snapshot strategy is enabled; it is a no-op for a
  // cold launch (which pinned no template).
  const networkReclaimHook = planner.networkReclaimHook;
  const templateReclaimHook = planner.templateReclaimHook;
  const reclaimHooks = [
    ...(networkReclaimHook === undefined ? [] : [networkReclaimHook]),
    planner.reclaimHook,
    ...(templateReclaimHook === undefined ? [] : [templateReclaimHook]),
  ];
  return {
    planner,
    reclaimHooks,
    allocator,
    portForward,
    ensureGlobal: () => network.ensureGlobal(),
    sweepNetworkOrphans: (records) =>
      sweepNetworkOrphans({
        records,
        enumerator: new DenoCommandEnumerator(),
        pidfiles: new DenoPidfileLister(),
        network,
        dnsmasq,
      }),
  };
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

  const store = new JsonFileSandboxStore(flags.state);
  const launch: LoadedLaunchPlanner = flags.launchConfig === undefined
    ? { planner: LAUNCH_PLANNING_UNCONFIGURED, reclaimHooks: [] }
    // The running studioboxd's schema hash gates warm-template validity: a
    // template captured under a different schema is stale (§1.2, §5.5).
    : await loadLaunchPlanner(flags.launchConfig, {
      schemaSha256: compat.schemaSha256,
    });

  // Cold-start allocator rebuild (§8): reserve every slot a SURVIVING record
  // still owns — BEFORE the shared seal, before the core accepts any launch, and
  // before any (destructive) reconcile — so the sweep's teardown and a fresh
  // launch can never collide on the same slot. A QUARANTINED record's reclaim
  // FAILED, so its TAP / dnsmasq are still live: reserveLiveSlots keeps its slot
  // too (only `terminated` records — reclaimed — free their slot).
  const journaledRecords = await store.list();
  if (launch.allocator !== undefined) {
    reserveLiveSlots(launch.allocator, journaledRecords);
  }

  // Install the shared NAT masquerade + inter-sandbox isolation + guest→host
  // input guard + IPv4 forwarding once BEFORE the supervisor accepts launches
  // (§3, §12).
  if (launch.ensureGlobal !== undefined) {
    await launch.ensureGlobal();
  }

  // Network ORPHAN SWEEP (§6, §8), part of the destructive restart reconcile:
  // reap any live `sbxtap*` / `sbx_eg_*` / `sbx_pf_*` / dnsmasq state that no
  // surviving record owns — a crash between provisioning and the resource-journal
  // CAS leaves such state with nothing to reclaim it. Runs before the core
  // accepts launches so a fresh launch never reuses a half-provisioned slot.
  if (launch.sweepNetworkOrphans !== undefined) {
    const swept = await launch.sweepNetworkOrphans(journaledRecords);
    if (swept.taps.length + swept.tables.length + swept.pidfiles.length > 0) {
      console.error(
        `rootd network orphan sweep: taps=${swept.taps.length} tables=${swept.tables.length} dnsmasq=${swept.pidfiles.length}`,
      );
    }
  }

  const core = new SupervisorCore({
    store,
    planner: launch.planner,
    ...(launch.reclaimHooks.length === 0
      ? {}
      : { reclaimHooks: launch.reclaimHooks }),
    // exposeHttp installs the per-sandbox DNAT through this controller; absent
    // when no dataplane is configured (exposeHttp then fails typed-unavailable).
    ...(launch.portForward === undefined
      ? {}
      : { portForward: launch.portForward }),
    buildId: flags.buildId,
  });

  // The bridge splice tier (PLAN.md §M8): rootd binds each minted grant's
  // loopback UDS under the root-owned bridge root and splices it to the guest
  // agent vsock. hostd dials that UDS (credential-authenticated) to reach the
  // guest. Ensure the root exists (0700: only root + the bridge peer reach it).
  await Deno.mkdir(BRIDGE_SOCKET_ROOT, { recursive: true, mode: 0o700 }).catch(
    (error) => {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    },
  );
  const bridgeServers = new Set<BridgeServer>();
  const onBridgeGranted = (
    grant: { socketPath: string; bridgeCredential: Uint8Array },
    request: { executionId: string },
  ): void => {
    const server = BridgeServer.open({
      socketPath: grant.socketPath,
      credential: grant.bridgeCredential,
      dialGuest: (signal) =>
        core.connectBridge(
          {
            executionId: request.executionId,
            guestPort: DEFAULT_AGENT_VSOCK_PORT,
          },
          {
            retryTimeoutMs: DEFAULT_BRIDGE_DIAL_TIMEOUT_MS,
            ...(signal === undefined ? {} : { signal }),
          },
        ),
    });
    bridgeServers.add(server);
    void server.finished.then(() => bridgeServers.delete(server));
  };

  const server = await startSupervisorServer({
    socketPath: flags.socket,
    api: core,
    identity,
    credential,
    onBridgeGranted,
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
    // Tear down every live bridge splice (frees its UDS + cuts the guest dial).
    await Promise.allSettled([...bridgeServers].map((b) => b.close()));
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
