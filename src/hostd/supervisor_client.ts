/**
 * The studiobox-hostd -> studiobox-rootd supervisor CLIENT (PLAN.md §M6).
 *
 * hostd is an unprivileged daemon that drives the root-owned rootd over the
 * `schema/supervisor.capnp` plane. This module wraps a connected byte stream
 * (a UDS `Deno.Conn` to rootd's control socket) in the generated
 * `SupervisorBootstrap` client, runs the fail-closed
 * `negotiate -> authenticate -> supervisor()` handshake, and exposes the
 * {@linkcode RootdGateway} surface — the subset of the rootd
 * {@linkcode SupervisorApi} that the M6 control plane calls
 * (launch / status / usage / kill / reconcile / ping).
 *
 * ## Bounded ownership (mirrors `src/rootd/agent_dialer.ts`)
 *
 * The pinned M1 transport-close ownership contract bites the same way on this
 * outbound leg: a rootd that accepts the socket and then stalls, sends a
 * malformed/over-limit frame, or vanishes must never hang hostd. So, exactly
 * like the agent dialer:
 *
 *   - the transport `onClose` and `onError` both drive the wire client's
 *     `close()`, so a peer EOF/RST surfaces every in-flight call as a typed
 *     error instead of hanging or escaping as an unhandled rejection;
 *   - every step (bootstrap acquisition, `negotiate`, `authenticate`,
 *     `supervisor()`, and each domain call) is bounded by an explicit
 *     timeout; and
 *   - on any handshake failure the wire client + transport are closed before
 *     rethrowing, so a failed dial leaks nothing.
 *
 * Every result-union arm that is `error` is decoded back into a typed
 * {@linkcode SupervisorError} (recovering the exact `SupervisorErrorCode` from
 * the wire `SbxError.details` when rootd stamped it), so a hostd caller reasons
 * about the same domain errors whether rootd is in-process or across the wire.
 *
 * @module
 */

import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";
import {
  type BridgeGrant as WireBridgeGrant,
  type BridgeRequest as WireBridgeRequest,
  type MachineStatus as WireMachineStatus,
  type MachineUsage as WireMachineUsage,
  type ReconcileSummary as WireReconcileSummary,
  type Supervisor,
  SupervisorBootstrap,
} from "../wire/generated/supervisor_types.ts";
import type { SbxError as WireSbxError } from "../wire/generated/common_types.ts";
import { launchRequestToWire } from "../wire/supervisor.ts";
import {
  type ContractIdentity,
  DEFAULT_TRANSPORT_LIMITS,
  type TransportLimits,
} from "../wire/contract.ts";
import {
  protocolOfferToWire,
  SUPERVISOR_FEATURE_BITS,
} from "../rootd/service.ts";
import {
  type SupervisorBridgeGrant,
  type SupervisorBridgeRequest,
  SupervisorError,
  type SupervisorErrorCode,
  type SupervisorLaunchRequest,
  type SupervisorMachineState,
  type SupervisorMachineStatus,
  type SupervisorMachineUsage,
  type SupervisorReconcileSummary,
} from "../rootd/supervisor_core_api.ts";

/** Default bound for each handshake step and domain call. */
export const DEFAULT_SUPERVISOR_DIAL_TIMEOUT_MS = 15_000;
/** Build id the host peer presents to rootd's `negotiate`. */
export const DEFAULT_HOST_BUILD_ID = "studiobox-hostd";

/**
 * The subset of the rootd {@linkcode SupervisorApi} the M6 host control plane
 * drives. A live wire session ({@linkcode SupervisorSession}) implements it,
 * and the control core depends only on this interface so a fake in-process
 * gateway can stand in for a real rootd in tests.
 */
export interface RootdGateway {
  /** Journal-before-spawn launch of one execution. */
  launch(request: SupervisorLaunchRequest): Promise<SupervisorMachineStatus>;
  /** Journal + liveness view of one execution. */
  status(executionId: string): Promise<SupervisorMachineStatus>;
  /** Resource usage of a live execution (zeros until rootd cgroup accounting). */
  usage(executionId: string): Promise<SupervisorMachineUsage>;
  /** Immediate SIGKILL + full reclaim of one execution. */
  kill(executionId: string): Promise<void>;
  /**
   * Install a host→guest port forward for a ready execution (M10 §6): rootd
   * installs the per-sandbox loopback DNAT/SNAT from the hostd-leased `hostPort`
   * to `<guestIp>:<guestPort>` and journals it. hostd owns the host-port lease.
   */
  exposeHttp(
    executionId: string,
    guestPort: number,
    hostPort: number,
  ): Promise<void>;
  /**
   * Authorize one guest-agent bridge for a live execution: rootd mints a
   * one-shot grant naming a per-bridge loopback UDS + a 32-byte
   * `bridgeCredential`, and stands up the bridge splice server behind it (the
   * M8 assembly). hostd's bridge factory then dials that UDS, presents the
   * credential, and receives a verbatim byte pipe to the guest vsock.
   */
  openBridge(request: SupervisorBridgeRequest): Promise<SupervisorBridgeGrant>;
  /** Destructive reconciliation sweep. */
  reconcile(): Promise<SupervisorReconcileSummary>;
  /** Liveness echo (full-width UInt64 nonce). */
  ping(nonce: bigint): Promise<bigint>;
}

/** A live, authenticated supervisor session over one dialed connection. */
export interface SupervisorSession extends RootdGateway, AsyncDisposable {
  /** The authenticated low-level `Supervisor` stub (escape hatch). */
  readonly supervisor: RpcStub<Supervisor>;
  /** Close the wire client and transport (also closes the underlying conn). */
  close(): Promise<void>;
}

/** Everything a dial + handshake needs beyond the connected byte stream. */
export interface SupervisorDialOptions {
  /** The local identity offered to rootd's `negotiate`. */
  readonly identity: ContractIdentity;
  /** The 32-byte bootstrap credential presented to `authenticate`. */
  readonly credential: Uint8Array;
  /** Feature bits the peer must support (defaults to the supervisor plane's). */
  readonly requiredFeatureBits?: bigint;
  /** Local transport-limit offer (defaults to the shared defaults). */
  readonly limits?: TransportLimits;
  /** Bound (ms) for bootstrap + each handshake/domain call. */
  readonly timeoutMs?: number;
}

/** Options for a call whose RESULT retains a capability. */
function capCall(timeoutMs: number) {
  return { timeoutMs, finish: { releaseResultCaps: false } } as const;
}

/**
 * Dial an established rootd byte stream: wrap it, run the bounded fail-closed
 * bootstrap, and return the authenticated {@linkcode SupervisorSession}.
 * Rejects with a typed {@linkcode SupervisorError} (`SBX_SUP_UNAVAILABLE`) —
 * never hangs — if rootd stalls, sends a malformed/over-limit frame, rejects
 * the handshake, or disconnects, and tears the local session down first.
 *
 * On success the returned session's `Symbol.asyncDispose` / `close()` closes
 * the wire client and transport (which closes `conn`). On rejection this
 * closes them itself.
 */
export async function openSupervisorSession(
  conn: Deno.Conn,
  options: SupervisorDialOptions,
): Promise<SupervisorSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUPERVISOR_DIAL_TIMEOUT_MS;
  const limits = options.limits ?? DEFAULT_TRANSPORT_LIMITS;
  const requiredFeatureBits = options.requiredFeatureBits ??
    SUPERVISOR_FEATURE_BITS;

  let wireClient: RpcWireClient | null = null;
  // Close-ownership contract: bind teardown to BOTH lifecycle edges so a peer
  // EOF/RST or an out-of-band transport fault surfaces every pending call as a
  // typed error and releases the local session (see the module doc).
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: timeoutMs,
    frameLimits: { maxFrameBytes: limits.maxFrameBytes },
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => void wireClient?.close().catch(() => {}),
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: timeoutMs });
  const client = wireClient;

  try {
    const bootstrap = await SupervisorBootstrap.bootstrapClient(client, {
      timeoutMs,
    });
    const handshake = await bootstrap.negotiate(
      protocolOfferToWire({
        identity: options.identity,
        limits,
        requiredFeatureBits,
      }),
      { timeoutMs },
    );
    if (handshake.which !== "accepted") {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `rootd rejected negotiation: ${handshake.error?.message ?? "unknown"}`,
      );
    }
    const auth = await bootstrap.authenticate(options.credential.slice(), {
      timeoutMs,
    });
    if (auth.which !== "accepted") {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `rootd rejected authentication: ${auth.error?.message ?? "unknown"}`,
      );
    }
    const supervisor = await bootstrap.supervisor(capCall(timeoutMs));
    return buildSession(supervisor, client, transport, timeoutMs);
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    if (error instanceof SupervisorError) throw error;
    // A timeout, transport/session error, or peer disconnect: normalize to the
    // supervisor's typed "unavailable" surface so a caller never has to hang or
    // reason about capnp internals.
    throw new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      `rootd handshake failed or timed out: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/**
 * Connect a UDS at `socketPath` and open a bounded supervisor session. A
 * convenience wrapper around {@linkcode openSupervisorSession}; the connect
 * failure itself is normalized to `SBX_SUP_UNAVAILABLE`.
 */
export async function connectSupervisorSession(
  socketPath: string,
  options: SupervisorDialOptions,
): Promise<SupervisorSession> {
  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: socketPath });
  } catch (error) {
    throw new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      `rootd socket ${socketPath} is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
  return await openSupervisorSession(conn, options);
}

function buildSession(
  supervisor: RpcStub<Supervisor>,
  client: RpcWireClient,
  transport: TcpTransport,
  timeoutMs: number,
): SupervisorSession {
  const close = async (): Promise<void> => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  };
  return {
    supervisor,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
    launch: async (request) => {
      const result = await supervisor.launch(
        launchRequestToWire(request),
        { timeoutMs },
      );
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
      return machineStatusFromWire(requireField(result.status, "status"));
    },
    status: async (executionId) => {
      const result = await supervisor.status(executionId, { timeoutMs });
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
      return machineStatusFromWire(requireField(result.status, "status"));
    },
    usage: async (executionId) => {
      const result = await supervisor.usage(executionId, { timeoutMs });
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
      return machineUsageFromWire(requireField(result.usage, "usage"));
    },
    kill: async (executionId) => {
      const result = await supervisor.kill(executionId, { timeoutMs });
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
    },
    exposeHttp: async (executionId, guestPort, hostPort) => {
      const result = await supervisor.exposeHttp(
        { executionId, guestPort, hostPort },
        { timeoutMs },
      );
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
    },
    openBridge: async (request) => {
      const result = await supervisor.openBridge(
        bridgeRequestToWire(request),
        { timeoutMs },
      );
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
      return bridgeGrantFromWire(requireField(result.grant, "grant"));
    },
    reconcile: async () => {
      const result = await supervisor.reconcile({ timeoutMs });
      if (result.which === "error") throw wireErrorToSupervisor(result.error);
      return reconcileSummaryFromWire(requireField(result.summary, "summary"));
    },
    ping: (nonce) => supervisor.ping(nonce, { timeoutMs }),
  };
}

function requireField<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      `rootd returned a success arm with no ${field}`,
    );
  }
  return value;
}

function bridgeRequestToWire(
  request: SupervisorBridgeRequest,
): WireBridgeRequest {
  return {
    sandboxId: request.sandboxId,
    executionId: request.executionId,
    leaseId: request.leaseId,
    leaseGeneration: BigInt(request.leaseGeneration),
    tunnelNonce: request.tunnelNonce.slice(),
    expiresAtUnixMs: BigInt(request.expiresAtUnixMs),
  };
}

function bridgeGrantFromWire(grant: WireBridgeGrant): SupervisorBridgeGrant {
  return {
    bridgeId: grant.bridgeId,
    socketPath: grant.socketPath,
    bridgeCredential: grant.bridgeCredential.slice(),
    agentCredential: grant.agentCredential.slice(),
    expiresAtUnixMs: Number(grant.expiresAtUnixMs),
  };
}

function machineStatusFromWire(
  status: WireMachineStatus,
): SupervisorMachineStatus {
  return {
    sandboxId: status.sandboxId,
    executionId: status.executionId,
    state: status.state as SupervisorMachineState,
    ...(status.pid > 0 ? { pid: status.pid } : {}),
    ...(status.exitedAtUnixMs > 0n
      ? {
        exitCode: status.exitCode,
        exitedAtUnixMs: Number(status.exitedAtUnixMs),
      }
      : {}),
    ...(status.reason.length > 0 ? { reason: status.reason } : {}),
  };
}

function machineUsageFromWire(usage: WireMachineUsage): SupervisorMachineUsage {
  return {
    cpuTimeMicros: Number(usage.cpuTimeMicros),
    memoryCurrentBytes: Number(usage.memoryCurrentBytes),
    memoryPeakBytes: Number(usage.memoryPeakBytes),
    diskBytes: Number(usage.diskBytes),
    rxBytes: Number(usage.rxBytes),
    txBytes: Number(usage.txBytes),
  };
}

function reconcileSummaryFromWire(
  summary: WireReconcileSummary,
): SupervisorReconcileSummary {
  return {
    examined: summary.examined,
    killed: summary.killed,
    reclaimed: summary.reclaimed,
    quarantined: summary.quarantined,
    failures: summary.failures.map((failure) => ({
      detail: failure.message,
      ...(failure.sandboxId.length > 0 ? { sandboxId: failure.sandboxId } : {}),
      ...(failure.operationId.length > 0
        ? { executionId: failure.operationId }
        : {}),
    })),
  };
}

const SUPERVISOR_CODES: ReadonlySet<string> = new Set<SupervisorErrorCode>([
  "SBX_SUP_VALIDATION",
  "SBX_SUP_DUPLICATE",
  "SBX_SUP_NOT_FOUND",
  "SBX_SUP_STATE",
  "SBX_SUP_STALE",
  "SBX_SUP_UNAVAILABLE",
]);

const WIRE_TO_SUPERVISOR: Readonly<Record<string, SupervisorErrorCode>> = {
  invalidArgument: "SBX_SUP_VALIDATION",
  alreadyExists: "SBX_SUP_DUPLICATE",
  notFound: "SBX_SUP_NOT_FOUND",
  failedPrecondition: "SBX_SUP_STATE",
  conflict: "SBX_SUP_STALE",
  unavailable: "SBX_SUP_UNAVAILABLE",
};

/**
 * Decode a wire `SbxError` back into a typed {@linkcode SupervisorError},
 * recovering the exact `SupervisorErrorCode` from `details.supervisorCode` when
 * rootd stamped it (the adapter always does), else mapping by wire code.
 */
export function wireErrorToSupervisor(
  error: WireSbxError | undefined,
): SupervisorError {
  if (error === undefined) {
    return new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      "rootd returned no error",
    );
  }
  const stamped = error.details.find((d) => d.key === "supervisorCode")?.value;
  if (stamped !== undefined && SUPERVISOR_CODES.has(stamped)) {
    return new SupervisorError(stamped as SupervisorErrorCode, error.message);
  }
  const code = WIRE_TO_SUPERVISOR[error.code] ?? "SBX_SUP_UNAVAILABLE";
  return new SupervisorError(code, error.message);
}
