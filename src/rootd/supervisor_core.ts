/**
 * SupervisorCore — the studiobox-rootd domain core behind
 * {@linkcode SupervisorApi}.
 *
 * It orchestrates the already-carried pieces: the Firecracker adapter
 * boundary (`src/rootd/firecracker/`, journal-before-spawn via
 * `CreateOnlyVmRegistry`), the durable sandbox journal (`src/state/`,
 * phases `allocating → staging → booting → ready → terminating →
 * terminated | reconciling | quarantined`), and — in tests — the fake
 * VMM/jailer shims from `@nullstyle/firecracker/testing`. The capnp
 * `supervisor.capnp` service becomes a thin adapter over this class once
 * codegen unblocks (see `supervisor_core_api.ts`).
 *
 * @module
 */

import type {
  VmConfig,
  VsockConn,
  VsockDialOptions,
} from "@nullstyle/firecracker";
import {
  type ArtifactReference,
  assertSandboxId,
  newSandboxRecord,
  type SandboxPhase,
  type SandboxRecord,
  type SandboxResources,
} from "../state/model.ts";
import { type SandboxStateStore, StateConflictError } from "../state/store.ts";
import {
  BRIDGE_SOCKET_ROOT,
  validateBridgeGrant,
  validateBridgeRequest,
  validateBridgeSocketPath,
  validateLaunchRequest,
} from "../wire/supervisor.ts";
import { WireValidationError } from "../wire/contract.ts";
import {
  assertExecutionId,
  CreateOnlyVmRegistry,
  FirecrackerAdapter,
  FirecrackerAdapterError,
  type FirecrackerMachine,
  type FirecrackerRuntime,
  type JailedLaunchRequest,
  SandboxStateJailRecordStore,
} from "./firecracker/mod.ts";
import {
  type SupervisorApi,
  type SupervisorBridgeGrant,
  type SupervisorBridgeRequest,
  SupervisorError,
  type SupervisorHealth,
  type SupervisorLaunchRequest,
  type SupervisorMachineStatus,
  type SupervisorMachineUsage,
  type SupervisorReconcileFailure,
  type SupervisorReconcileSummary,
} from "./supervisor_core_api.ts";

/**
 * Everything host-specific a launch needs, resolved from logical ids.
 * Producing it is rootd-internal policy (artifact staging is M4); the
 * supervisor surface itself never carries these fields.
 */
export interface SupervisorLaunchPlan {
  readonly jailer: JailedLaunchRequest["jailer"];
  readonly stage: JailedLaunchRequest["stage"];
  readonly config: VmConfig;
  readonly readinessTimeoutMs?: number;
  /**
   * Guest AF_VSOCK port studioboxd listens on. When present the launch is
   * not `ready` until the supervisor has DIALED it (real vsock, not just
   * journal + VMM liveness): the boot recipe's `studiobox.vsock_port`
   * cmdline and this port must agree. The port is remembered for
   * {@linkcode SupervisorApi.probeAgent} and the {@linkcode SupervisorCore}
   * agent-connection seam. Omitted for fake launches (no real vsock).
   */
  readonly agentVsockPort?: number;
  /**
   * Identity of the artifact set the plan stages from. When present it is
   * journaled onto the sandbox record BEFORE any spawn, so artifact GC
   * (`images/cache.ts` + `src/rootd/artifact_refs.ts`) keeps the set
   * alive for as long as the record has not reached `terminated` — even
   * across a supervisor crash.
   */
  readonly artifact?: ArtifactReference;
  /**
   * The per-launch guest-agent credential (the `studiobox.token` bytes the boot
   * recipe bakes onto the kernel cmdline; PLAN.md §M8). studioboxd expects
   * exactly these bytes at `AgentBootstrap.authenticate`. When present it is
   * remembered per execution and returned by every {@linkcode SupervisorApi.openBridge}
   * grant so the client can present it to the guest agent. Omitted for fake
   * launches (no baked token): {@linkcode SupervisorCore.openBridge} then falls
   * back to a fresh random credential (host-safe supervisor-core tests).
   */
  readonly agentCredential?: Uint8Array;
  /**
   * Studiobox-owned resources the planner provisioned for this launch (the M10
   * network dataplane: `tapName` / `hostIp` / `guestIp` / `subnet` /
   * `dnsmasqPidfile`). When present these are MERGED onto the record's
   * `resources` in the staging→booting commit — so they are durably journaled
   * BEFORE any process spawns, which a cold-reconcile reclaim depends on (§8,
   * §9). The default `exposedPorts: []` is preserved (a partial merge).
   */
  readonly resources?: Partial<SandboxResources>;
}

/** Resolves logical artifact/allocation ids to a concrete launch plan. */
export interface SupervisorLaunchPlanner {
  resolve(request: SupervisorLaunchRequest): Promise<SupervisorLaunchPlan>;
}

/**
 * Narrow seam for studiobox-owned resources the Firecracker package cannot
 * reclaim (M10 network/cgroup reclaimers plug in here). Hooks run during
 * composed reconciliation and after every terminate; a throwing hook parks
 * the record in `quarantined` with the failure detail.
 */
export interface ReclaimHook {
  readonly name: string;
  reclaim(record: SandboxRecord): Promise<void>;
}

/** The default studiobox-layer reclaimer set: nothing to reclaim yet. */
export const NOOP_RECLAIM_HOOKS: readonly ReclaimHook[] = Object.freeze([]);

export interface SupervisorCoreOptions {
  /** The one authoritative journal (shared with the nested jail registry). */
  readonly store: SandboxStateStore;
  /** Resolves logical launch requests to jailer/stage/config plans. */
  readonly planner: SupervisorLaunchPlanner;
  /** Injection seam; defaults to the real `@nullstyle/firecracker` runtime. */
  readonly runtime?: FirecrackerRuntime;
  readonly reclaimHooks?: readonly ReclaimHook[];
  readonly buildId?: string;
  /** Clock seam (unix milliseconds). */
  readonly now?: () => number;
}

interface BridgeGrantEntry {
  readonly grant: SupervisorBridgeGrant;
  readonly sandboxId: string;
  readonly executionId: string;
  consumed: boolean;
}

interface ObservedExit {
  readonly exitCode: number | null;
  readonly atUnixMs: number;
}

/** One journal-mutating operation currently executing in this process. */
interface InflightOperation {
  readonly operation: "launch" | "shutdown" | "kill";
  readonly executionId: string;
}

const TERMINAL_PHASES: readonly SandboxPhase[] = ["terminated", "quarantined"];
/**
 * Phases that mean "a reconciliation sweep (or its convergence) owns this
 * record now"; an in-flight writer that observes them has lost and must
 * abort with `SBX_SUP_STALE` instead of clobbering.
 */
const RECONCILED_PHASES: readonly SandboxPhase[] = [
  "reconciling",
  "terminated",
  "quarantined",
];
const MAX_REASON_LENGTH = 512;
const MAX_CAS_ATTEMPTS = 16;

/** See the module doc. One instance per rootd process. */
export class SupervisorCore implements SupervisorApi {
  readonly #store: SandboxStateStore;
  readonly #planner: SupervisorLaunchPlanner;
  readonly #adapter: FirecrackerAdapter;
  readonly #hooks: readonly ReclaimHook[];
  readonly #buildId: string;
  readonly #now: () => number;
  readonly #startedAtUnixMs: number;
  readonly #machines = new Map<string, FirecrackerMachine>();
  /** Guest vsock port per live execution, when the plan configured one. */
  readonly #agentPorts = new Map<string, number>();
  /**
   * Per-launch guest-agent credential per live execution (the baked
   * `studiobox.token` bytes), when the plan minted one. openBridge returns it so
   * the tunnel client can authenticate to studioboxd (PLAN.md §M8).
   */
  readonly #agentCredentials = new Map<string, Uint8Array>();
  readonly #exits = new Map<string, ObservedExit>();
  readonly #bridges = new Map<string, BridgeGrantEntry>();
  readonly #inflight = new Set<InflightOperation>();
  #reconciling = false;

  constructor(options: SupervisorCoreOptions) {
    this.#store = options.store;
    this.#planner = options.planner;
    const registry = new CreateOnlyVmRegistry(
      new SandboxStateJailRecordStore(options.store),
    );
    this.#adapter = new FirecrackerAdapter({
      registry,
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    });
    this.#hooks = options.reclaimHooks ?? NOOP_RECLAIM_HOOKS;
    this.#buildId = options.buildId ?? "dev";
    this.#now = options.now ?? Date.now;
    this.#startedAtUnixMs = this.#now();
  }

  async launch(
    request: SupervisorLaunchRequest,
  ): Promise<SupervisorMachineStatus> {
    this.#rejectDuringReconcile("launch");
    const validated = this.#validate(() => validateLaunchRequest(request));
    assertSandboxId(validated.sandboxId);
    assertExecutionId(validated.executionId);

    // Registered before the first await so a reconcile sweep can never
    // start between validation and the launch settling (the guard is
    // in-process only; see reconcile()).
    const inflight: InflightOperation = {
      operation: "launch",
      executionId: validated.executionId,
    };
    this.#inflight.add(inflight);
    try {
      return await this.#launch(validated);
    } finally {
      this.#inflight.delete(inflight);
    }
  }

  async #launch(
    validated: SupervisorLaunchRequest,
  ): Promise<SupervisorMachineStatus> {
    try {
      await this.#store.create(newSandboxRecord({ id: validated.sandboxId }));
    } catch (error) {
      if (error instanceof StateConflictError) {
        throw new SupervisorError(
          "SBX_SUP_DUPLICATE",
          `sandbox ${validated.sandboxId} is already journaled`,
          error,
        );
      }
      throw error;
    }

    try {
      await this.#ownedTransition(
        validated.sandboxId,
        validated.executionId,
        ["allocating"],
        "staging",
      );
      const plan = await this.#planner.resolve(validated);
      // The artifact reference AND the network resources ride the staging ->
      // booting commit, so both are durable BEFORE any process spawns (the
      // resources are what a cold-reconcile reclaim keys off, §8/§9).
      await this.#ownedTransition(
        validated.sandboxId,
        validated.executionId,
        ["staging"],
        "booting",
        plan.artifact === undefined
          ? undefined
          : { artifact: structuredClone(plan.artifact) },
        plan.resources === undefined
          ? undefined
          : structuredClone(plan.resources),
      );
      const machine = await this.#adapter.launch({
        sandboxId: validated.sandboxId,
        executionId: validated.executionId,
        jailer: plan.jailer,
        stage: plan.stage,
        config: plan.config,
        ...(plan.readinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: plan.readinessTimeoutMs }),
      });
      try {
        // Readiness is real when configured: dial studioboxd over vsock so
        // "ready" means the guest agent answered, not just that the VMM is
        // journaled and live (M5). The dial retries across the guest's boot
        // + studioboxd startup window.
        if (plan.agentVsockPort !== undefined) {
          const probe = await machine.connectVsock(plan.agentVsockPort);
          probe.close();
        }
        await this.#ownedTransition(
          validated.sandboxId,
          validated.executionId,
          ["booting"],
          "ready",
        );
      } catch (error) {
        // The agent never answered, or the journal refused the move
        // (typically SBX_SUP_STALE: a sweep or a newer execution owns the
        // record now). Put the fresh VMM down instead of tracking a phantom
        // machine.
        await machine.kill().catch(() => {});
        await machine[Symbol.asyncDispose]().catch(() => {});
        throw error;
      }
      this.#track(machine);
      if (plan.agentVsockPort !== undefined) {
        this.#agentPorts.set(validated.executionId, plan.agentVsockPort);
      }
      if (plan.agentCredential !== undefined) {
        this.#agentCredentials.set(
          validated.executionId,
          plan.agentCredential.slice(),
        );
      }
      return {
        sandboxId: validated.sandboxId,
        executionId: validated.executionId,
        state: "running",
        pid: machine.pid,
      };
    } catch (error) {
      await this.#parkFailedLaunch(
        validated.sandboxId,
        validated.executionId,
        error,
      );
      throw error;
    }
  }

  async status(executionId: string): Promise<SupervisorMachineStatus> {
    const record = await this.#byExecution(executionId);
    return this.#statusOf(record, executionId);
  }

  async usage(executionId: string): Promise<SupervisorMachineUsage> {
    const record = await this.#byExecution(executionId);
    this.#requireReadyAndLive(record, executionId, "usage");
    // Real cgroup/disk/net accounting lands with M10/M11; the domain core
    // already commits to the shape.
    return {
      cpuTimeMicros: 0,
      memoryCurrentBytes: 0,
      memoryPeakBytes: 0,
      diskBytes: 0,
      rxBytes: 0,
      txBytes: 0,
    };
  }

  async probeAgent(executionId: string): Promise<void> {
    const record = await this.#byExecution(executionId);
    this.#requireReadyAndLive(record, executionId, "probeAgent");
    const port = this.#agentPorts.get(executionId);
    if (port === undefined) return;
    // Real reachability check (M5): dial studioboxd over vsock and hang up.
    // A refused/absent guest listener surfaces as the adapter's typed error.
    const machine = this.#machines.get(executionId)!;
    const conn = await machine.connectVsock(port, { retryTimeoutMs: 5_000 });
    conn.close();
  }

  /**
   * Host/test seam (not part of {@linkcode SupervisorApi}): dial the guest
   * agent's vsock for a ready, live execution and return the raw byte
   * stream. The M5 in-VM suite wraps it in the `sandbox_agent.capnp` client
   * to drive exec/fs/eval directly (the M7 tunnel supersedes this with the
   * bridge splice). Requires a plan that configured `agentVsockPort`.
   */
  async connectAgent(
    executionId: string,
    options?: VsockDialOptions,
  ): Promise<VsockConn> {
    const record = await this.#byExecution(executionId);
    this.#requireReadyAndLive(record, executionId, "connectAgent");
    const port = this.#agentPorts.get(executionId);
    if (port === undefined) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `execution ${executionId} has no agent vsock port; the plan configured none`,
      );
    }
    return await this.#machines.get(executionId)!.connectVsock(port, options);
  }

  async openBridge(
    request: SupervisorBridgeRequest,
  ): Promise<SupervisorBridgeGrant> {
    this.#rejectDuringReconcile("openBridge");
    const now = this.#now();
    const validated = this.#validate(() => validateBridgeRequest(request, now));
    const record = await this.#byExecution(validated.executionId);
    if (record.id !== validated.sandboxId) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        "openBridge sandbox id does not own the target execution",
      );
    }
    this.#requireReadyAndLive(record, validated.executionId, "openBridge");

    const bridgeId = `b-${crypto.randomUUID().replaceAll("-", "")}`;
    const socketPath = `${BRIDGE_SOCKET_ROOT}${bridgeId}`;
    validateBridgeSocketPath(socketPath);
    // The guest baked the launch-scoped credential at boot; return exactly
    // those bytes so the client can authenticate to studioboxd (PLAN.md §M8). A
    // launch with no baked token (fake launches) falls back to a fresh random
    // credential — the grant stays well-formed, but no real guest verifies it.
    const agentCredential =
      this.#agentCredentials.get(validated.executionId)?.slice() ??
        crypto.getRandomValues(new Uint8Array(32));
    const grant = validateBridgeGrant({
      bridgeId,
      socketPath,
      bridgeCredential: crypto.getRandomValues(new Uint8Array(32)),
      agentCredential,
      expiresAtUnixMs: validated.expiresAtUnixMs,
    }, now);
    this.#purgeExpiredBridges();
    this.#bridges.set(bridgeId, {
      grant,
      sandboxId: validated.sandboxId,
      executionId: validated.executionId,
      consumed: false,
    });
    return grant;
  }

  /**
   * Dial the guest agent's vsock for a ready, live execution and hand back the
   * raw duplex the tunnel splice pumps bytes across (PLAN.md §M7; DESIGN.md §4:
   * rootd `vm.vsock.connect(AGENT_PORT)`). This is the privileged half of the
   * bridge — the ticket has already been burned by unprivileged hostd before
   * rootd is reached (the {@linkcode TunnelAuthorizer} ordering).
   *
   * Bounded like {@linkcode SupervisorCore.connectAgent} / the agent dialer: a
   * refused or absent guest listener surfaces the adapter's typed error rather
   * than hanging, via the vsock dial's own `retryTimeoutMs` + `signal`.
   */
  async connectBridge(
    request: { readonly executionId: string; readonly guestPort: number },
    options?: VsockDialOptions,
  ): Promise<VsockConn> {
    this.#rejectDuringReconcile("connectBridge");
    const executionId = request.executionId;
    try {
      assertExecutionId(executionId);
    } catch (error) {
      throw new SupervisorError(
        "SBX_SUP_VALIDATION",
        "the execution id is not a valid logical identifier",
        error,
      );
    }
    const record = await this.#byExecution(executionId);
    this.#requireReadyAndLive(record, executionId, "connectBridge");
    return await this.#machines.get(executionId)!.connectVsock(
      request.guestPort,
      options,
    );
  }

  /**
   * Consume a one-shot bridge grant. The M7 vsock splice calls this exactly
   * once per grant; a second take, an unknown id, or an expired grant fails
   * closed. Not part of the capnp surface — hostd only ever sees the grant.
   */
  takeBridgeGrant(bridgeId: string): SupervisorBridgeGrant {
    this.#purgeExpiredBridges();
    const entry = this.#bridges.get(bridgeId);
    if (entry === undefined) {
      throw new SupervisorError(
        "SBX_SUP_NOT_FOUND",
        "the bridge grant does not exist or has expired",
      );
    }
    if (entry.consumed) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        "the bridge grant was already consumed",
      );
    }
    entry.consumed = true;
    return entry.grant;
  }

  shutdown(executionId: string): Promise<void> {
    return this.#terminate(executionId, "shutdown");
  }

  kill(executionId: string): Promise<void> {
    return this.#terminate(executionId, "kill");
  }

  async reconcile(): Promise<SupervisorReconcileSummary> {
    if (this.#reconciling) {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        "a reconciliation sweep is already running",
      );
    }
    // Bidirectional exclusion, in-process only: a SIGKILLed supervisor
    // cannot await anything, so a fresh process starts with an empty
    // in-flight set and reconcile-on-restart stays destructive.
    if (this.#inflight.size > 0) {
      const detail = [...this.#inflight]
        .map((entry) => `${entry.operation} ${entry.executionId}`)
        .sort()
        .join(", ");
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `reconcile cannot start while operations are in flight (${detail}); retry once they settle`,
      );
    }
    this.#reconciling = true;
    try {
      return await this.#reconcileSweep();
    } finally {
      this.#reconciling = false;
    }
  }

  health(): Promise<SupervisorHealth> {
    this.#purgeExpiredBridges();
    let activeMachines = 0;
    for (const executionId of this.#machines.keys()) {
      if (!this.#exits.has(executionId)) activeMachines++;
    }
    let activeBridges = 0;
    for (const entry of this.#bridges.values()) {
      if (!entry.consumed) activeBridges++;
    }
    return Promise.resolve({
      buildId: this.#buildId,
      startedAtUnixMs: this.#startedAtUnixMs,
      activeMachines,
      activeBridges,
      reconciling: this.#reconciling,
    });
  }

  ping(nonce: bigint): Promise<bigint> {
    if (nonce < 0n || nonce > 0xffff_ffff_ffff_ffffn) {
      return Promise.reject(
        new SupervisorError(
          "SBX_SUP_VALIDATION",
          "ping nonce must be an unsigned 64-bit integer",
        ),
      );
    }
    return Promise.resolve(nonce);
  }

  async #reconcileSweep(): Promise<SupervisorReconcileSummary> {
    const open = (await this.#store.list()).filter(
      (record) => !TERMINAL_PHASES.includes(record.phase),
    );
    if (open.length === 0) {
      return {
        examined: 0,
        killed: 0,
        reclaimed: 0,
        quarantined: 0,
        failures: [],
      };
    }

    for (const record of open) {
      if (record.phase !== "reconciling") {
        await this.#update(record.id, (current) => ({
          ...current,
          phase: "reconciling",
        }));
      }
    }

    // Destructive 1.0 restart policy: the package sweep SIGKILLs orphan
    // VMMs (after cmdline identity checks) and reclaims jail roots.
    const packageResult = await this.#adapter
      .reconcileAfterSupervisorRestart();
    const packageFailures = new Map<string, string>();
    for (const failure of packageResult.failures) {
      packageFailures.set(failure.vmId, boundedReason(failure.error));
    }

    let reclaimed = 0;
    let quarantined = 0;
    const failures: SupervisorReconcileFailure[] = [];
    for (const record of open) {
      const executionId = record.machine?.executionId;
      const packageFailure = executionId === undefined
        ? undefined
        : packageFailures.get(executionId);
      let detail = packageFailure === undefined
        ? undefined
        : `firecracker reclaim: ${packageFailure}`;
      if (detail === undefined) {
        detail = await this.#runReclaimHooks(record.id);
      }
      if (detail === undefined) {
        await this.#update(record.id, (current) => ({
          ...current,
          phase: "terminated",
          terminationReason: "host-restart",
        }));
        reclaimed++;
      } else {
        await this.#quarantine(record.id, detail);
        quarantined++;
        failures.push({
          sandboxId: record.id,
          ...(executionId === undefined ? {} : { executionId }),
          detail,
        });
      }
    }

    // Everything the crashed (or current) supervisor held is now stale.
    for (const machine of this.#machines.values()) {
      machine.closeOutboundConnections();
    }
    this.#machines.clear();
    this.#agentPorts.clear();
    this.#agentCredentials.clear();
    this.#exits.clear();
    this.#bridges.clear();

    return {
      examined: open.length,
      killed: packageResult.reclaimed.length,
      reclaimed,
      quarantined,
      failures,
    };
  }

  async #terminate(
    executionId: string,
    mode: "shutdown" | "kill",
  ): Promise<void> {
    this.#rejectDuringReconcile(mode);
    const inflight: InflightOperation = { operation: mode, executionId };
    this.#inflight.add(inflight);
    try {
      await this.#terminateInflight(executionId, mode);
    } finally {
      this.#inflight.delete(inflight);
    }
  }

  async #terminateInflight(
    executionId: string,
    mode: "shutdown" | "kill",
  ): Promise<void> {
    const record = await this.#byExecution(executionId);
    if (TERMINAL_PHASES.includes(record.phase)) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `${mode} is invalid for a ${record.phase} sandbox`,
      );
    }
    const machine = this.#machines.get(executionId);
    if (machine === undefined) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `${mode} has no live machine for the execution; run reconcile`,
      );
    }
    await this.#ownedTransition(
      record.id,
      executionId,
      ["booting", "ready", "terminating"],
      "terminating",
    );
    try {
      if (mode === "kill") {
        await machine.kill();
      } else {
        await machine.shutdown();
      }
      // Stop and reclaim are distinct package stages: files and the nested
      // jail journal are released at disposal.
      await machine[Symbol.asyncDispose]();
    } catch (error) {
      // The machine failure is the caller's signal; a stale journal (some
      // other writer converged the record meanwhile) is left alone.
      await this.#quarantine(record.id, boundedReason(error), executionId)
        .catch(rethrowUnlessStale);
      throw error;
    }
    const hookDetail = await this.#runReclaimHooks(record.id);
    if (hookDetail !== undefined) {
      await this.#quarantine(record.id, hookDetail, executionId);
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `${mode} reclaim quarantined sandbox ${record.id}: ${hookDetail}`,
      );
    }
    await this.#update(record.id, (current) => {
      this.#assertWriterOwns(current, executionId, `${mode} completion`);
      return {
        ...current,
        phase: "terminated",
        terminationReason: mode,
      };
    });
    this.#machines.delete(executionId);
    this.#agentPorts.delete(executionId);
    this.#agentCredentials.delete(executionId);
    this.#exits.delete(executionId);
    this.#revokeBridges(executionId);
  }

  /** Run every hook; the first failure becomes the quarantine detail. */
  async #runReclaimHooks(sandboxId: string): Promise<string | undefined> {
    if (this.#hooks.length === 0) return undefined;
    const record = await this.#store.get(sandboxId);
    if (record === null) return undefined;
    for (const hook of this.#hooks) {
      try {
        await hook.reclaim(structuredClone(record));
      } catch (error) {
        return `${hook.name}: ${boundedReason(error)}`;
      }
    }
    return undefined;
  }

  async #parkFailedLaunch(
    sandboxId: string,
    executionId: string,
    error: unknown,
  ): Promise<void> {
    if (error instanceof SupervisorError && error.code === "SBX_SUP_STALE") {
      // The launch already lost the record to a sweep or a newer execution; the
      // loser must not write anything over the winner — and must NOT reclaim,
      // since the journaled resources now belong to whoever won the record.
      return;
    }
    const cleanupIncomplete = error instanceof FirecrackerAdapterError &&
      error.code === "SBX_FC_CLEANUP";
    const detail = `launch failed: ${boundedReason(error)}`;
    try {
      // Reap any studiobox-owned resources the (post-resolve) failure may have
      // journaled BEFORE driving the record terminal. The network dataplane
      // (TAP / egress table / dnsmasq / allocator slot) rides the staging→booting
      // commit, and a TERMINAL record is excluded from #reconcileSweep — so
      // without this the whole dataplane leaks forever. The reclaim hooks are
      // idempotent (NetworkReclaimHook no-ops on an unset `resources.tapName`),
      // so this is a clean nothing-to-do when no network was ever provisioned.
      const hookDetail = await this.#runReclaimHooks(sandboxId);
      if (hookDetail !== undefined) {
        // A reclaim hook FAILED: the leak is real, so surface it — quarantine
        // (ownership-guarded) rather than silently terminating, mirroring the
        // terminate path's semantics.
        await this.#quarantine(sandboxId, hookDetail, executionId);
      } else if (cleanupIncomplete) {
        await this.#quarantine(sandboxId, detail, executionId);
      } else {
        await this.#update(sandboxId, (current) => {
          this.#assertWriterOwns(current, executionId, "park failed launch");
          return {
            ...current,
            phase: "terminated",
            terminationReason: truncateReason(detail),
          };
        });
      }
    } catch {
      // The original launch failure is the caller's signal; a stale or
      // conflicting journal here surfaces on the next reconcile sweep.
    }
  }

  /**
   * Quarantine a record. When `ownerExecutionId` is given the write is
   * ownership-guarded: a record converged by a sweep or claimed by a newer
   * execution stays untouched (`SBX_SUP_STALE`). Sweep-internal callers
   * pass no owner — the destructive restart policy clobbers on purpose.
   */
  #quarantine(
    sandboxId: string,
    detail: string,
    ownerExecutionId?: string,
  ): Promise<SandboxRecord> {
    return this.#update(sandboxId, (current) => {
      if (ownerExecutionId !== undefined) {
        this.#assertWriterOwns(current, ownerExecutionId, "quarantine");
      }
      return {
        ...current,
        phase: "quarantined",
        terminationReason: truncateReason(detail),
      };
    });
  }

  #track(machine: FirecrackerMachine): void {
    this.#machines.set(machine.executionId, machine);
    void machine.exited.then((exit) => {
      this.#exits.set(machine.executionId, {
        exitCode: exit.code,
        atUnixMs: this.#now(),
      });
    }).catch(() => {});
  }

  #statusOf(
    record: SandboxRecord,
    executionId: string,
  ): SupervisorMachineStatus {
    const machine = this.#machines.get(executionId);
    const exit = this.#exits.get(executionId);
    const pid = machine?.pid ?? record.machine?.jailRecord?.pid ?? undefined;
    const base = {
      sandboxId: record.id,
      executionId,
      ...(pid === undefined || pid === null ? {} : { pid }),
      ...(record.terminationReason === undefined
        ? {}
        : { reason: record.terminationReason }),
    };
    if (exit !== undefined) {
      return {
        ...base,
        state: "exited",
        ...(exit.exitCode === null ? {} : { exitCode: exit.exitCode }),
        exitedAtUnixMs: exit.atUnixMs,
      };
    }
    if (machine !== undefined) {
      return { ...base, state: liveState(machine.state) };
    }
    return { ...base, state: journaledState(record.phase) };
  }

  #requireReadyAndLive(
    record: SandboxRecord,
    executionId: string,
    operation: string,
  ): void {
    if (record.phase !== "ready") {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `${operation} requires a ready sandbox; ${record.id} is ${record.phase}`,
      );
    }
    if (
      this.#machines.get(executionId) === undefined ||
      this.#exits.has(executionId)
    ) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `${operation} requires a live machine for the execution`,
      );
    }
  }

  async #byExecution(executionId: string): Promise<SandboxRecord> {
    try {
      assertExecutionId(executionId);
    } catch (error) {
      throw new SupervisorError(
        "SBX_SUP_VALIDATION",
        "the execution id is not a valid logical identifier",
        error,
      );
    }
    const record = (await this.#store.list()).find(
      (candidate) => candidate.machine?.executionId === executionId,
    );
    if (record === undefined) {
      throw new SupervisorError(
        "SBX_SUP_NOT_FOUND",
        "no journal entry resolves the execution id",
      );
    }
    return record;
  }

  /**
   * Phase- and ownership-aware CAS transition for one execution's writer.
   * The mutate re-checks on every CAS attempt, so a record that a sweep
   * converged or a newer execution claimed aborts the writer with
   * `SBX_SUP_STALE` instead of being clobbered by a blind retry.
   */
  async #ownedTransition(
    sandboxId: string,
    executionId: string,
    allowedFrom: readonly SandboxPhase[],
    to: SandboxPhase,
    patch?: Partial<SandboxRecord>,
    resourcesPatch?: Partial<SandboxResources>,
  ): Promise<void> {
    await this.#update(sandboxId, (current) => {
      this.#assertWriterOwns(current, executionId, `move to ${to}`);
      if (!allowedFrom.includes(current.phase)) {
        throw new SupervisorError(
          "SBX_SUP_STATE",
          `sandbox ${sandboxId} cannot move ${current.phase} -> ${to}`,
        );
      }
      // `resources` is MERGED (not replaced) so the default `exposedPorts: []`
      // and any prior fields survive a partial network-resource patch.
      return {
        ...current,
        ...patch,
        ...(resourcesPatch === undefined
          ? {}
          : { resources: { ...current.resources, ...resourcesPatch } }),
        phase: to,
      };
    });
  }

  /**
   * A writer that observes a reconciled/terminal phase or a foreign
   * execution on its record has lost the race: abort with the typed
   * stale-execution error and leave the winner's record alone.
   */
  #assertWriterOwns(
    current: SandboxRecord,
    executionId: string,
    operation: string,
  ): void {
    const owner = current.machine?.executionId;
    if (owner !== undefined && owner !== executionId) {
      throw new SupervisorError(
        "SBX_SUP_STALE",
        `${operation} for execution ${executionId} lost sandbox ${current.id} to execution ${owner}; the record was left alone`,
      );
    }
    if (RECONCILED_PHASES.includes(current.phase)) {
      throw new SupervisorError(
        "SBX_SUP_STALE",
        `${operation} for execution ${executionId} lost sandbox ${current.id} to its ${current.phase} state; the record was left alone`,
      );
    }
  }

  /**
   * Revision-checked update with a bounded retry against the registry.
   * The retry only covers revision races: `mutate` runs against the fresh
   * record on every attempt and is expected to re-assert its own phase /
   * ownership preconditions (see {@linkcode SupervisorCore.#ownedTransition}
   * and `#assertWriterOwns`), throwing instead of clobbering a record that
   * moved on. Only the exclusive reconcile sweep may pass a blind mutate —
   * the destructive restart policy converges records on purpose.
   */
  async #update(
    sandboxId: string,
    mutate: (record: SandboxRecord) => SandboxRecord,
  ): Promise<SandboxRecord> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const current = await this.#store.get(sandboxId);
      if (current === null) {
        throw new SupervisorError(
          "SBX_SUP_NOT_FOUND",
          `sandbox ${sandboxId} is not journaled`,
        );
      }
      try {
        return await this.#store.compareAndSwap(
          sandboxId,
          current.revision,
          mutate,
        );
      } catch (error) {
        if (!(error instanceof StateConflictError)) throw error;
      }
    }
    throw new StateConflictError(
      `supervisor update of ${sandboxId} exceeded its CAS retry bound`,
    );
  }

  #revokeBridges(executionId: string): void {
    for (const [bridgeId, entry] of this.#bridges) {
      if (entry.executionId === executionId) this.#bridges.delete(bridgeId);
    }
  }

  #purgeExpiredBridges(): void {
    const now = this.#now();
    for (const [bridgeId, entry] of this.#bridges) {
      if (entry.grant.expiresAtUnixMs <= now) this.#bridges.delete(bridgeId);
    }
  }

  #rejectDuringReconcile(operation: string): void {
    if (this.#reconciling) {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `${operation} is unavailable while the supervisor reconciles`,
      );
    }
  }

  #validate<T>(validate: () => T): T {
    try {
      return validate();
    } catch (error) {
      if (error instanceof WireValidationError) {
        throw new SupervisorError("SBX_SUP_VALIDATION", error.message, error);
      }
      throw error;
    }
  }
}

function liveState(
  state: FirecrackerMachine["state"],
): SupervisorMachineStatus["state"] {
  switch (state) {
    case "configured":
    case "starting":
      return "launching";
    case "running":
    case "paused":
      return "running";
    case "shutting_down":
      return "stopping";
    case "exited":
    case "cleaned":
      return "exited";
  }
}

function journaledState(
  phase: SandboxPhase,
): SupervisorMachineStatus["state"] {
  switch (phase) {
    case "allocating":
    case "staging":
    case "booting":
      return "launching";
    case "terminating":
      return "stopping";
    case "terminated":
    case "quarantined":
      return "exited";
    case "ready":
    case "reconciling":
      // A journaled-live execution with no supervisor-held machine is an
      // orphan awaiting the destructive restart sweep.
      return "cleanupPending";
  }
}

/** Swallow only the typed stale-writer signal; anything else propagates. */
function rethrowUnlessStale(error: unknown): void {
  if (error instanceof SupervisorError && error.code === "SBX_SUP_STALE") {
    return;
  }
  throw error;
}

function boundedReason(error: unknown): string {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return truncateReason(text);
}

function truncateReason(text: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= MAX_REASON_LENGTH) return text;
  let sliced = text;
  while (encoder.encode(sliced).byteLength > MAX_REASON_LENGTH - 3) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}...`;
}
