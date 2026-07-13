/**
 * The studiobox-rootd supervisor DOMAIN interface.
 *
 * {@linkcode SupervisorApi} is a plain TypeScript mirror of the
 * `schema/supervisor.capnp` `Supervisor` interface semantics —
 * launch / status / usage / probeAgent / openBridge / shutdown / kill /
 * reconcile / health / ping — with **logical identifiers only** as inputs
 * (sandbox ids, execution ids, artifact ids, allocation ids, lease ids).
 * No argv, host paths, uids, cgroup names, or netns names cross this
 * boundary; the implementation resolves logical ids internally, exactly
 * like the root-owned UDS in DESIGN.md §3.
 *
 * **Wire adapter note (M2 wire, blocked upstream):** once capnp codegen for
 * the five-schema bundle is unblocked in capnp-deno, the `supervisor.capnp`
 * capnp service becomes a *thin adapter* over this interface — each RPC
 * method decodes its request struct, calls the same-named method here, and
 * encodes the result / `SbxError` union. Nothing in this module may import
 * generated bindings; the only `src/wire/` dependency is the plain
 * validators in `src/wire/supervisor.ts`, which were built for exactly this
 * boundary and are shared with the future adapter.
 *
 * @module
 */

import type {
  SupervisorBridgeGrant,
  SupervisorBridgeRequest,
  SupervisorLaunchRequest,
} from "../wire/supervisor.ts";

export type {
  SupervisorBridgeGrant,
  SupervisorBridgeRequest,
  SupervisorLaunchRequest,
} from "../wire/supervisor.ts";

/** Mirror of `supervisor.capnp` `MachineState`. */
export type SupervisorMachineState =
  | "launching"
  | "running"
  | "stopping"
  | "exited"
  | "cleanupPending";

/** Mirror of `supervisor.capnp` `MachineStatus`. */
export interface SupervisorMachineStatus {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly state: SupervisorMachineState;
  /** VMM pid when known (live or last journaled). */
  readonly pid?: number;
  /** Exit code when the exit was observed and carried one. */
  readonly exitCode?: number;
  readonly exitedAtUnixMs?: number;
  /** Bounded, redacted detail (termination reason, quarantine detail). */
  readonly reason?: string;
}

/**
 * Mirror of `supervisor.capnp` `MachineUsage`. Until the cgroup accounting
 * lands (M10/M11) implementations report zeros for a live machine rather
 * than failing, so callers can already depend on the shape.
 */
export interface SupervisorMachineUsage {
  readonly cpuTimeMicros: number;
  readonly memoryCurrentBytes: number;
  readonly memoryPeakBytes: number;
  readonly diskBytes: number;
  readonly rxBytes: number;
  readonly txBytes: number;
}

/** One reconciliation failure, redacted to logical identifiers. */
export interface SupervisorReconcileFailure {
  readonly sandboxId?: string;
  readonly executionId?: string;
  readonly detail: string;
}

/** Mirror of `supervisor.capnp` `ReconcileSummary`. */
export interface SupervisorReconcileSummary {
  /** Non-terminal records examined by this sweep. */
  readonly examined: number;
  /** Executions reaped by the package-level `reconcile({ killLive: true })`. */
  readonly killed: number;
  /** Records driven to `terminated` by this sweep. */
  readonly reclaimed: number;
  /** Records parked in `quarantined` with a failure detail. */
  readonly quarantined: number;
  readonly failures: ReadonlyArray<SupervisorReconcileFailure>;
}

/** Mirror of `supervisor.capnp` `Health`. */
export interface SupervisorHealth {
  readonly buildId: string;
  readonly startedAtUnixMs: number;
  readonly activeMachines: number;
  readonly activeBridges: number;
  readonly reconciling: boolean;
}

export type SupervisorErrorCode =
  /** A request failed logical-id / wire validation. */
  | "SBX_SUP_VALIDATION"
  /** The sandbox id is already journaled. */
  | "SBX_SUP_DUPLICATE"
  /** No journal entry resolves the given logical id. */
  | "SBX_SUP_NOT_FOUND"
  /** The operation is invalid for the record's current phase. */
  | "SBX_SUP_STATE"
  /**
   * A writer lost its record to a newer execution or to a converged
   * (reconciled/terminal) journal state. Nothing was written: the stale
   * writer aborts and leaves the winner's record alone.
   */
  | "SBX_SUP_STALE"
  /** The supervisor is reconciling and cannot accept the call yet. */
  | "SBX_SUP_UNAVAILABLE";

/** Typed domain error; becomes `SbxError` on the wire adapter. */
export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;

  constructor(code: SupervisorErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SupervisorError";
    this.code = code;
  }
}

/**
 * The supervisor domain surface (see the module doc for the capnp mapping).
 *
 * Result unions on the wire (`LaunchResult`, `StatusResult`, ...) map to
 * plain returns here; the `error` arms map to thrown
 * {@linkcode SupervisorError} / `FirecrackerAdapterError` values.
 */
export interface SupervisorApi {
  /**
   * Journal-before-spawn launch of one execution. The record is committed
   * (phase `allocating`) before any process is spawned, then walks
   * `staging → booting → ready`. Rejects a duplicate sandbox id with
   * `SBX_SUP_DUPLICATE`.
   */
  launch(request: SupervisorLaunchRequest): Promise<SupervisorMachineStatus>;

  /** Journal + liveness view of one execution. */
  status(executionId: string): Promise<SupervisorMachineStatus>;

  /** Resource usage of a ready, live execution (zeros until M10/M11). */
  usage(executionId: string): Promise<SupervisorMachineUsage>;

  /**
   * Assert the guest agent is reachable. The domain core checks journal
   * phase + VMM liveness; the actual vsock probe rides in with the wire
   * layer (M5/M7).
   */
  probeAgent(executionId: string): Promise<void>;

  /**
   * Authorize one bridge: the request is validated, the target sandbox
   * must be `ready` with a live VMM, and the returned grant names a
   * validated socket path under the bridge root. The grant is a one-shot
   * record — the vsock splice that consumes it lands with M7; this method
   * never dials.
   */
  openBridge(request: SupervisorBridgeRequest): Promise<SupervisorBridgeGrant>;

  /**
   * Install a host→guest port forward for a ready, network-provisioned
   * execution (M10 §6): rootd installs the per-sandbox loopback DNAT/SNAT
   * (`sbx_pf_<id>`) that maps the hostd-leased `hostPort` to `<guestIp>:<guestPort>`
   * and journals `resources.exposedPorts`. hostd owns the host-port lease and
   * passes the allocated `hostPort`. Rejects a netless / not-ready sandbox with
   * `SBX_SUP_STATE`, and surfaces a failed nftables install as a typed error.
   */
  exposeHttp(
    executionId: string,
    guestPort: number,
    hostPort: number,
  ): Promise<void>;

  /** Graceful stop (escalating inside the adapter), then full reclaim. */
  shutdown(executionId: string): Promise<void>;

  /** Immediate SIGKILL via the adapter, then full reclaim. */
  kill(executionId: string): Promise<void>;

  /**
   * Composed destructive reconciliation (DESIGN.md §6): the package-level
   * `reconcile({ killLive: true })` first, then the studiobox-layer
   * reclaim hooks, converging every non-terminal record to
   * `terminated("host-restart")` or `quarantined`.
   *
   * Mutual exclusion is bidirectional and in-process only: while a
   * launch/shutdown/kill is in flight the sweep fails fast with
   * `SBX_SUP_UNAVAILABLE` (retry once they settle), and while a sweep runs
   * those operations are rejected the same way. A SIGKILLed supervisor
   * holds no in-flight operations, so reconcile on a fresh process stays
   * destructive.
   */
  reconcile(): Promise<SupervisorReconcileSummary>;

  health(): Promise<SupervisorHealth>;

  /**
   * Liveness echo. The wire nonce is a `UInt64` (`supervisor.capnp` ping @9),
   * so it is carried as `bigint` end-to-end — a JS `number` would silently
   * corrupt nonces above 2^53.
   */
  ping(nonce: bigint): Promise<bigint>;
}
