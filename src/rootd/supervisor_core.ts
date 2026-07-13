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
  SnapshotLoadParams,
  VmConfig,
  VsockConn,
  VsockDialOptions,
} from "@nullstyle/firecracker";
import type { GuestNetworkConfig } from "../agent/personalize.ts";
import { openPersonalizeSession } from "./agent_dialer.ts";
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
import { type SubnetAllocation, subnetForSlot } from "./network/allocator.ts";
import { slotOfTapName } from "./network/reclaim_hook.ts";
import { PortForwardError } from "./network/port_forward.ts";

/** Fields shared by every launch plan (cold or snapshot-restore). */
interface SupervisorLaunchPlanBase {
  readonly jailer: JailedLaunchRequest["jailer"];
  readonly stage: JailedLaunchRequest["stage"];
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

/**
 * A cold-boot launch plan (the default). `kind` is optional so a plan that
 * omits the discriminant — every pre-snapshot-restore planner and test — is a
 * cold plan, and the cold path stays BYTE-IDENTICAL to before this union
 * existed (snapshot-restore hard rule 2).
 */
export interface ColdSupervisorLaunchPlan extends SupervisorLaunchPlanBase {
  readonly kind?: "cold";
  /** The `VmConfig` a cold `Machine.launch` boots from. */
  readonly config: VmConfig;
}

/**
 * In-band guest network a restore's `personalize` reconfigures `eth0` from
 * (snapshot-restore §2.3, §4 step 4), plus the bindings a later `authenticate`
 * checks. Derived by the planner from the SAME {@linkcode SubnetAllocation}
 * that provisioned the TAP.
 */
export interface RestorePersonalizePlan {
  /** In-band NIC config (empty `guestCidr` ⇒ netless). */
  readonly network: GuestNetworkConfig;
  /** Boot nonce the guest binds; the tunnel client presents the same at `authenticate`. */
  readonly bootNonce: Uint8Array;
  /** Sandbox id the guest binds; checked at `authenticate`. */
  readonly sandboxId: string;
  /** Bound (ms) for the dial + personalize. Defaults to the plan readiness budget. */
  readonly timeoutMs?: number;
}

/**
 * A snapshot-restore launch plan (snapshot-restore §4, §5.2): the twin of
 * {@linkcode ColdSupervisorLaunchPlan} that loads a warm-template snapshot
 * instead of cold-booting. `stage` copies snapshot/mem/rootfs(ro)/overlay-copy
 * into the fresh jail; `snapshot` is the wire-verbatim `PUT /snapshot/load`
 * body (in-jail paths + per-restore `network_overrides`/`vsock_override`);
 * `personalize` carries the in-band identity injected after resume; and
 * `fallback` is a complete cold recipe REUSING the already-provisioned network
 * (§5.3) so a template problem never fails a create. `agentVsockPort` and
 * `agentCredential` are REQUIRED (the restore dials the guest and injects the
 * credential over `personalize`, unlike a cold boot which bakes it at boot).
 */
export interface RestoreSupervisorLaunchPlan extends SupervisorLaunchPlanBase {
  readonly kind: "restore";
  /** Wire-verbatim `PUT /snapshot/load` params (in-jail snapshot/mem paths + overrides). */
  readonly snapshot: SnapshotLoadParams;
  /** Dial+personalize target; the restored studioboxd already listens here. */
  readonly agentVsockPort: number;
  /** Freshly minted per restore; injected over `personalize`, returned by openBridge. */
  readonly agentCredential: Uint8Array;
  /** In-band identity `personalize` applies after resume. */
  readonly personalize: RestorePersonalizePlan;
  /**
   * The cold recipe the core boots if restore OR personalize fails (§5.3),
   * REUSING the same (already-provisioned, already-journaled) network — so the
   * fallback must NOT re-journal resources and must carry a fresh unformatted
   * overlay + a `studiobox.token`-baked cmdline for cold readiness.
   */
  readonly fallback: ColdSupervisorLaunchPlan;
}

/**
 * Everything host-specific a launch needs, resolved from logical ids.
 * Producing it is rootd-internal policy; the supervisor surface itself never
 * carries these fields, nor which strategy resolved (hard rule 1: the SDK,
 * hostd, and the wire never see `launchStrategy`).
 */
export type SupervisorLaunchPlan =
  | ColdSupervisorLaunchPlan
  | RestoreSupervisorLaunchPlan;

/** Resolves logical artifact/allocation ids to a concrete launch plan. */
export interface SupervisorLaunchPlanner {
  /** Resolve a logical launch request to a concrete jailer/stage/config plan. */
  resolve(request: SupervisorLaunchRequest): Promise<SupervisorLaunchPlan>;
}

/**
 * Narrow seam for studiobox-owned resources the Firecracker package cannot
 * reclaim (M10 network/cgroup reclaimers plug in here). Hooks run during
 * composed reconciliation and after every terminate; a throwing hook parks
 * the record in `quarantined` with the failure detail.
 */
export interface ReclaimHook {
  /** Hook name, surfaced in quarantine failure detail. */
  readonly name: string;
  /** Reclaim this hook's studiobox-owned resources for a record. */
  reclaim(record: SandboxRecord): Promise<void>;
}

/** The default studiobox-layer reclaimer set: nothing to reclaim yet. */
export const NOOP_RECLAIM_HOOKS: readonly ReclaimHook[] = Object.freeze([]);

/**
 * The port-forward installer seam {@linkcode SupervisorCore.exposeHttp} drives
 * (the M10 `PortForwardController`, or a fake). Structurally satisfied by the
 * real controller (`src/rootd/network/port_forward.ts`). Absent from the core
 * options ⇒ no dataplane is configured ⇒ `exposeHttp` is unsupported (§6).
 */
export interface PortForwardInstaller {
  /**
   * Install the sandbox's `sbx_pf_<id>` loopback DNAT/SNAT table holding the
   * COMPLETE set of `forwards` (one DNAT + one SNAT rule per forward); returns
   * the installed table name. The table is a full replace (`add;delete;add`), so
   * the caller must pass every current forward — a subset would wipe the omitted
   * ones' DNAT. Atomic, so a throw leaves nothing installed.
   */
  expose(
    alloc: SubnetAllocation,
    request: {
      readonly sandboxId: string;
      readonly forwards: readonly {
        readonly hostPort: number;
        readonly guestPort: number;
      }[];
    },
  ): Promise<string>;
  /** Remove the sandbox's forward table by exact name (idempotent). */
  reclaim(sandboxId: string): Promise<void>;
}

/** What the core hands the {@linkcode RestorePersonalizer} for one restore. */
export interface RestorePersonalizeInput {
  /** The dialed guest vsock byte stream; the personalizer OWNS closing it. */
  readonly conn: VsockConn;
  /** Per-restore credential a later `authenticate` must present. */
  readonly credential: Uint8Array;
  /** Boot nonce bound on the guest. */
  readonly bootNonce: Uint8Array;
  /** Sandbox id bound on the guest. */
  readonly sandboxId: string;
  /** In-band NIC config (empty `guestCidr` ⇒ netless). */
  readonly network: GuestNetworkConfig;
  /** Bound (ms) for the negotiate + personalize round trip. */
  readonly timeoutMs?: number;
}

/**
 * Injection seam for the restore `personalize` step (snapshot-restore §2.3):
 * dial-side identity injection over an already-dialed guest vsock. The real
 * implementation is {@linkcode openPersonalizeSession}; host-safe tests inject
 * a fake that records the input and succeeds/fails on demand, so the restore
 * control flow is exercised with no vsock/capnp. Any throw is treated by the
 * core as a restore-specific failure and drives the cold fallback (§5.3).
 */
export interface RestorePersonalizer {
  personalize(input: RestorePersonalizeInput): Promise<void>;
}

/** Real personalizer: run the bounded `negotiate → personalize` over the vsock. */
const DEFAULT_RESTORE_PERSONALIZER: RestorePersonalizer = {
  async personalize(input: RestorePersonalizeInput): Promise<void> {
    // `openPersonalizeSession` closes the transport (and thus `conn`) on both
    // success and failure — the one-shot personalize retains no session.
    await openPersonalizeSession(input.conn, {
      credential: input.credential,
      bootNonce: input.bootNonce,
      sandboxId: input.sandboxId,
      network: input.network,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  },
};

/** Construction options for {@linkcode SupervisorCore}. */
export interface SupervisorCoreOptions {
  /** The one authoritative journal (shared with the nested jail registry). */
  readonly store: SandboxStateStore;
  /** Resolves logical launch requests to jailer/stage/config plans. */
  readonly planner: SupervisorLaunchPlanner;
  /** Injection seam; defaults to the real `@nullstyle/firecracker` runtime. */
  readonly runtime?: FirecrackerRuntime;
  /**
   * Restore-path `personalize` seam (snapshot-restore §2.3). Defaults to the
   * real {@linkcode openPersonalizeSession} dialer; only the snapshot strategy
   * ever uses it, so cold-only deploys need not configure one.
   */
  readonly personalizer?: RestorePersonalizer;
  /** Studiobox-layer reclaimers; defaults to {@linkcode NOOP_RECLAIM_HOOKS}. */
  readonly reclaimHooks?: readonly ReclaimHook[];
  /**
   * Installs the per-sandbox host→guest port forward for
   * {@linkcode SupervisorApi.exposeHttp} (M10 §6). Absent ⇒ no network
   * dataplane is configured, and `exposeHttp` fails typed-unavailable.
   */
  readonly portForward?: PortForwardInstaller;
  /** Build identifier surfaced in {@linkcode SupervisorApi.health}. */
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
  readonly #personalizer: RestorePersonalizer;
  readonly #hooks: readonly ReclaimHook[];
  readonly #portForward: PortForwardInstaller | undefined;
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
  /**
   * Per-execution serialization chain for {@linkcode SupervisorCore.exposeHttp}.
   * exposeHttp is a read-modify-write over the sandbox's forward set (read the
   * journaled `exposedPorts`, install the full table, journal the new port), so
   * two concurrent calls on the SAME sandbox must not both read a stale snapshot
   * and race the atomic `add;delete;add` install (the later would replace the
   * earlier's DNAT). Chaining per execution makes them strictly sequential.
   */
  readonly #exposeChain = new Map<string, Promise<void>>();
  #reconciling = false;

  /** Assemble the core from its journal, planner, and injection seams. */
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
    this.#personalizer = options.personalizer ?? DEFAULT_RESTORE_PERSONALIZER;
    this.#hooks = options.reclaimHooks ?? NOOP_RECLAIM_HOOKS;
    this.#portForward = options.portForward;
    this.#buildId = options.buildId ?? "dev";
    this.#now = options.now ?? Date.now;
    this.#startedAtUnixMs = this.#now();
  }

  /** Journal-before-spawn launch of one execution (see {@link SupervisorApi}). */
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
      // The artifact reference, the durable template-pin marker, AND the network
      // resources ride the staging -> booting commit, so all are durable BEFORE
      // any process spawns (the resources are what a cold-reconcile reclaim keys
      // off, §8/§9). A restore records `templatePinned` here so that after a
      // crash + destructive reconcile the TemplateReclaimHook can release the
      // template refcount from the SURVIVING record — the in-process pin map is
      // empty then (snapshot-restore §1.2, §7; FINDING 1). A cold plan pins no
      // template, so the marker stays absent.
      const bootingPatch: Partial<SandboxRecord> = {};
      if (plan.artifact !== undefined) {
        bootingPatch.artifact = structuredClone(plan.artifact);
      }
      if (plan.kind === "restore") {
        bootingPatch.templatePinned = true;
      }
      await this.#ownedTransition(
        validated.sandboxId,
        validated.executionId,
        ["staging"],
        "booting",
        Object.keys(bootingPatch).length === 0 ? undefined : bootingPatch,
        plan.resources === undefined
          ? undefined
          : structuredClone(plan.resources),
      );
      // The artifact reference AND the network resources are now journaled
      // (BEFORE any spawn) for BOTH strategies. Branch below the supervisor
      // surface: the SDK/hostd/wire never learn which strategy resolved
      // (snapshot-restore hard rule 1). A restore that fails falls back to a
      // cold boot reusing this same journaled network (§5.3), so the failure
      // handling is IDENTICAL to cold — #parkFailedLaunch reclaims either way.
      if (plan.kind === "restore") {
        return await this.#launchRestore(validated, plan);
      }
      return await this.#bootColdPlan(validated, plan);
    } catch (error) {
      await this.#parkFailedLaunch(
        validated.sandboxId,
        validated.executionId,
        error,
      );
      throw error;
    }
  }

  /**
   * Boot a cold plan from `booting`: `Machine.launch`, prove readiness by
   * DIALING studioboxd over vsock (M5), transition `booting → ready`, and track
   * the live machine + credential. This is the byte-identical cold path — it is
   * ALSO the snapshot fallback target (§5.3), so a template problem resolves to
   * exactly today's cold create with no divergence. Caller owns the
   * staging→booting commit and the `#parkFailedLaunch` on throw.
   */
  async #bootColdPlan(
    validated: SupervisorLaunchRequest,
    plan: ColdSupervisorLaunchPlan,
  ): Promise<SupervisorMachineStatus> {
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
  }

  /**
   * Restore a warm-template snapshot from `booting` (snapshot-restore §4):
   * `Machine.restore` → dial the restored vsock → `personalize(credential,
   * bootNonce, sandboxId, network)` → `booting → ready`. The credential/bootNonce
   * are freshly minted per restore exactly as cold. On a restore-specific
   * failure — the `Machine.restore` API errored, or the dial/personalize failed
   * or timed out — the restored VMM (if any) is put down CLEANLY and the create
   * FALLS BACK to a cold boot reusing the already-provisioned network (§5.3),
   * so a template problem never fails a create. A journal race at the
   * `booting → ready` flip (a sweep / newer execution took the record) is NOT a
   * template problem: kill and rethrow exactly like cold, never fall back.
   */
  async #launchRestore(
    validated: SupervisorLaunchRequest,
    plan: RestoreSupervisorLaunchPlan,
  ): Promise<SupervisorMachineStatus> {
    let machine: FirecrackerMachine;
    try {
      machine = await this.#adapter.restore({
        sandboxId: validated.sandboxId,
        executionId: validated.executionId,
        jailer: plan.jailer,
        stage: plan.stage,
        snapshot: plan.snapshot,
        ...(plan.readinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: plan.readinessTimeoutMs }),
      });
    } catch (error) {
      // Restore itself failed. The adapter scoped-reconciled ONLY this
      // execution's jail — but if that reconcile reported cleanup-incomplete
      // (SBX_FC_CLEANUP), an orphan VMM survives. Falling back to cold would
      // double-boot beside the orphan and strip the jail binding a later
      // reconcile needs, so RETHROW: #parkFailedLaunch then QUARANTINES the
      // record with its machine/jailRecord binding intact, exactly as the cold
      // path quarantines an adapter cleanup-incomplete (§5.3). Only fall back
      // when the restore's jail is CONFIRMED reclaimed (no orphan).
      console.error(
        `[rootd] ${validated.executionId}: snapshot restore failed (Machine.restore), falling back to cold: ${
          restoreFaultDetail(error)
        }`,
      );
      if (isCleanupIncomplete(error)) throw error;
      return await this.#fallbackToCold(validated, plan);
    }

    try {
      await this.#personalizeRestored(machine, plan);
    } catch (personalizeError) {
      console.error(
        `[rootd] ${validated.executionId}: snapshot restore failed (dial/personalize), falling back to cold: ${
          restoreFaultDetail(personalizeError)
        }`,
      );
      // A restore-specific failure (dial refused, personalize rejected or timed
      // out): put the restored VMM DOWN before falling back. If kill/dispose
      // signals cleanup-incomplete (SBX_FC_CLEANUP), the VMM could NOT be
      // confirmed down — an orphan the scoped reconcile can no longer reach if
      // we clear the binding. So RETHROW to QUARANTINE (preserving the
      // machine/jailRecord binding for a later reconcile) instead of orphaning
      // it in a cold fallback (FINDING 2). Only fall back when the restored VMM
      // is CONFIRMED down. Kill+dispose reclaims this jail and closes the dialed
      // vsock; the network stays journaled for the fallback.
      const cleanupError = await this.#putRestoredVmmDown(machine);
      if (cleanupError !== undefined) throw cleanupError;
      return await this.#fallbackToCold(validated, plan);
    }

    try {
      await this.#ownedTransition(
        validated.sandboxId,
        validated.executionId,
        ["booting"],
        "ready",
      );
    } catch (error) {
      // A journal race (SBX_SUP_STALE) — a sweep or newer execution owns the
      // record now. Re-launching cold would double-boot against a record being
      // reclaimed, so do NOT fall back: put the VMM down and rethrow like cold.
      await machine.kill().catch(() => {});
      await machine[Symbol.asyncDispose]().catch(() => {});
      throw error;
    }

    this.#track(machine);
    this.#agentPorts.set(validated.executionId, plan.agentVsockPort);
    this.#agentCredentials.set(
      validated.executionId,
      plan.agentCredential.slice(),
    );
    console.error(
      `[rootd] ${validated.executionId} created via snapshot restore`,
    );
    return {
      sandboxId: validated.sandboxId,
      executionId: validated.executionId,
      state: "running",
      pid: machine.pid,
    };
  }

  /**
   * Cold-boot fallback for a failed restore (§5.3): a template problem never
   * fails a create. The restore VMM (if any) is already down and the network is
   * still provisioned + journaled. The create-only jail registry keeps this
   * record's `machine` binding after a restore VMM's jail was reclaimed (it is
   * left `reclaiming`, not cleared), so the fallback's journal-before-spawn would
   * conflict — RESET the binding to unbound first, then cold-boot on the SAME
   * record + executionId reusing the provisioned network (no re-provision).
   */
  async #fallbackToCold(
    validated: SupervisorLaunchRequest,
    plan: RestoreSupervisorLaunchPlan,
  ): Promise<SupervisorMachineStatus> {
    await this.#update(validated.sandboxId, (current) => {
      // Ownership guard: a sweep / newer execution that took the record makes
      // this throw SBX_SUP_STALE, which aborts the fallback (parkFailedLaunch
      // then leaves the winner's record alone) rather than double-booting.
      this.#assertWriterOwns(
        current,
        validated.executionId,
        "restore fallback",
      );
      return { ...current, machine: undefined };
    });
    return await this.#bootColdPlan(validated, plan.fallback);
  }

  /**
   * Dial the restored guest vsock and inject its per-restore identity over the
   * one-shot `personalize` (snapshot-restore §2.3). The personalizer OWNS
   * closing the dialed conn; a failure here is caught by {@linkcode
   * SupervisorCore.#launchRestore} and drives the cold fallback.
   */
  async #personalizeRestored(
    machine: FirecrackerMachine,
    plan: RestoreSupervisorLaunchPlan,
  ): Promise<void> {
    const conn = await machine.connectVsock(plan.agentVsockPort, {
      ...(plan.readinessTimeoutMs === undefined
        ? {}
        : { retryTimeoutMs: plan.readinessTimeoutMs }),
    });
    await this.#personalizer.personalize({
      conn,
      credential: plan.agentCredential,
      bootNonce: plan.personalize.bootNonce,
      sandboxId: plan.personalize.sandboxId,
      network: plan.personalize.network,
      ...(plan.personalize.timeoutMs === undefined
        ? {}
        : { timeoutMs: plan.personalize.timeoutMs }),
    });
  }

  /**
   * Put a restored VMM down before a cold fallback (FINDING 2). Returns the
   * cleanup-incomplete error when kill OR dispose signals `SBX_FC_CLEANUP` (the
   * scoped reconcile could not confirm the VMM dead) — the caller then throws it
   * so the record is QUARANTINED with its jail binding intact rather than
   * orphaning the VMM in a fallback. Returns `undefined` when the VMM is
   * CONFIRMED down (kill + dispose clean), so the fallback is safe. Both steps
   * always run — a kill fault must not skip the disposal that reclaims the jail.
   */
  async #putRestoredVmmDown(
    machine: FirecrackerMachine,
  ): Promise<FirecrackerAdapterError | undefined> {
    let cleanupError: FirecrackerAdapterError | undefined;
    try {
      await machine.kill();
    } catch (error) {
      if (isCleanupIncomplete(error)) cleanupError = error;
    }
    try {
      await machine[Symbol.asyncDispose]();
    } catch (error) {
      if (isCleanupIncomplete(error)) cleanupError = error;
    }
    return cleanupError;
  }

  /** Journal + liveness view of one execution. */
  async status(executionId: string): Promise<SupervisorMachineStatus> {
    const record = await this.#byExecution(executionId);
    return this.#statusOf(record, executionId);
  }

  /** Resource usage of a ready, live execution (zeros until M10/M11). */
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

  /** Assert the guest agent is reachable (phase + VMM liveness + vsock probe). */
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

  /** Install the per-sandbox host→guest port forward (M10 §6). */
  async exposeHttp(
    executionId: string,
    guestPort: number,
    hostPort: number,
  ): Promise<void> {
    this.#rejectDuringReconcile("exposeHttp");
    const portForward = this.#portForward;
    if (portForward === undefined) {
      // No dataplane configured (vsock-only deploy): there is no host on which
      // to install a forward. Typed-unavailable so hostd surfaces it cleanly.
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        "exposeHttp is unavailable: no network dataplane is configured",
      );
    }
    // Serialize per execution: the read (journaled exposedPorts) → install →
    // journal sequence below must be atomic w.r.t. another exposeHttp on the
    // same sandbox, or two concurrent calls both read a stale set and the later
    // atomic install replaces the earlier's DNAT (§6). The record is fetched
    // INSIDE the lock so each call sees the prior call's journaled ports.
    return await this.#withExposeLock(
      executionId,
      () => this.#doExposeHttp(portForward, executionId, guestPort, hostPort),
    );
  }

  /** Run `fn` after any in-flight exposeHttp for `executionId` settles. */
  async #withExposeLock<T>(
    executionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#exposeChain.get(executionId) ?? Promise.resolve();
    const run = prior.then(() => fn());
    const tail = run.then(() => {}, () => {});
    this.#exposeChain.set(executionId, tail);
    try {
      return await run;
    } finally {
      // Drop the entry only if no newer exposeHttp chained after us, so the map
      // does not grow unboundedly across executions.
      if (this.#exposeChain.get(executionId) === tail) {
        this.#exposeChain.delete(executionId);
      }
    }
  }

  async #doExposeHttp(
    portForward: PortForwardInstaller,
    executionId: string,
    guestPort: number,
    hostPort: number,
  ): Promise<void> {
    const record = await this.#byExecution(executionId);
    this.#requireReadyAndLive(record, executionId, "exposeHttp");
    // A netless / not-network-provisioned sandbox journaled no TAP or
    // gateway/guest addresses, so it cannot expose a port (§7). Require all
    // three: the alloc is reconstructed from the TAP slot, and guestIp/hostIp
    // are the anti-spoof addresses the DNAT/SNAT target (§12).
    const { tapName, guestIp, hostIp } = record.resources;
    if (
      tapName === undefined || guestIp === undefined || hostIp === undefined
    ) {
      throw new SupervisorError(
        "SBX_SUP_STATE",
        `exposeHttp requires a network-provisioned sandbox; ${record.id} journaled no TAP/addresses`,
      );
    }
    // Reconstruct the SubnetAllocation from the journaled slot. subnetForSlot is
    // deterministic, so the alloc's guestIp/hostIp equal the journaled ones (the
    // allocator is the single source of truth for all three, §12).
    const alloc = subnetForSlot(slotOfTapName(tapName));

    // Re-materialize the sandbox's COMPLETE forward table: the sbx_pf_<id> table
    // is a full replace (add;delete;add), so it must carry ALL of this sandbox's
    // forwards — the ones already journaled PLUS the new one — or this install
    // would wipe the prior forwards' DNAT while hostd still leases them (§6).
    // Dedupe by hostPort so a retry of the same lease re-installs the same set.
    const existing = record.resources.exposedPorts;
    const forwards = existing.some((port) => port.hostPort === hostPort)
      ? existing
      : [...existing, { hostPort, guestPort }];

    // Install the DNAT/SNAT. The install is atomic (add;delete;add), so a throw
    // leaves nothing behind — no half-installed table to unwind here.
    try {
      await portForward.expose(alloc, {
        sandboxId: record.id,
        forwards,
      });
    } catch (error) {
      if (error instanceof PortForwardError) {
        throw new SupervisorError(
          "SBX_SUP_STATE",
          `exposeHttp could not install the forward for ${record.id}: ${error.message}`,
          error,
        );
      }
      throw error;
    }

    // Journal the forward (ownership-guarded CAS, deduped by hostPort) so a cold
    // reconcile reaps `sbx_pf_<id>` from the journal alone (§6, §9). The table is
    // already installed, so a journal failure here would strand it: reclaim by
    // exact name before rethrowing (the install is atomic; the reclaim is
    // idempotent) so exposeHttp never leaves a forward the journal does not
    // record.
    try {
      await this.#update(record.id, (current) => {
        this.#assertWriterOwns(current, executionId, "exposeHttp journal");
        const existing = current.resources.exposedPorts;
        if (existing.some((port) => port.hostPort === hostPort)) {
          // A retry of the same lease: the atomic re-install above is a no-op
          // replace, and the journal already records it — leave it unchanged.
          return current;
        }
        return {
          ...current,
          resources: {
            ...current.resources,
            exposedPorts: [...existing, { hostPort, guestPort }],
          },
        };
      });
    } catch (error) {
      // The install is live but the journal doesn't record the new forward.
      // Reclaim the whole `sbx_pf_<id>` table by exact name so the dataplane
      // never carries a forward the journal doesn't own. This deletes any
      // prior journaled forwards too, but with exposeHttp serialized per
      // execution (#withExposeLock) a journal failure here can only come from a
      // concurrent TERMINATE / reconcile taking writer ownership (SBX_SUP_STALE)
      // — i.e. the sandbox is going away and NetworkReclaimHook reaps the table
      // regardless — so the over-broad delete is harmless.
      await portForward.reclaim(record.id).catch(() => {});
      throw error;
    }
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

  /** Authorize a one-shot guest bridge for a ready, live sandbox (never dials). */
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

  /** Graceful stop (escalating inside the adapter), then full reclaim. */
  shutdown(executionId: string): Promise<void> {
    return this.#terminate(executionId, "shutdown");
  }

  /** Immediate SIGKILL via the adapter, then full reclaim. */
  kill(executionId: string): Promise<void> {
    return this.#terminate(executionId, "kill");
  }

  /** Composed destructive reconciliation sweep (DESIGN.md §6). */
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

  /** Snapshot of supervisor liveness/health. */
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

  /** Liveness echo of an unsigned 64-bit `nonce`. */
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
    const cleanupIncomplete = isCleanupIncomplete(error);
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

/**
 * Does a Firecracker boundary error signal cleanup-incomplete — the scoped
 * reconcile / disposal could NOT confirm the VMM dead (an orphan requiring a
 * later reconcile)? This is exactly how the cold path detects+quarantines it
 * (`#parkFailedLaunch`: `error.code === "SBX_FC_CLEANUP"`), reused so the restore
 * fallback quarantines an orphan instead of leaking it (FINDING 2).
 */
function isCleanupIncomplete(
  error: unknown,
): error is FirecrackerAdapterError {
  return error instanceof FirecrackerAdapterError &&
    error.code === "SBX_FC_CLEANUP";
}

/**
 * The most specific message for a failed restore, for the cold-fallback log
 * line: the underlying Firecracker `faultMessage` (e.g. an incompatible
 * snapshot) when present, else the cause/error message.
 */
function restoreFaultDetail(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause;
  const fault = (cause as { faultMessage?: unknown })?.faultMessage;
  if (typeof fault === "string" && fault.length > 0) return fault;
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return error instanceof Error ? error.message : String(error);
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
