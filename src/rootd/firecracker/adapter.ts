import type {
  JailedRestoreOptions,
  JailerOptions,
  ReconcileResult,
  ShutdownOptions,
  SnapshotLoadParams,
  StageEntry,
  VmConfig,
  VmmExit,
  VsockConn,
  VsockDialOptions,
} from "@nullstyle/firecracker";
import {
  FirecrackerAdapterError,
  normalizeFirecrackerError,
} from "./errors.ts";
import { assertExecutionId } from "./execution_id.ts";
import {
  type CreateOnlyVmRegistry,
  EXECUTION_ID_METADATA,
  SANDBOX_ID_METADATA,
  scopeRegistry,
} from "./registry.ts";
import {
  type FirecrackerCompatibility,
  type FirecrackerRuntime,
  nullstyleFirecrackerRuntime,
  type RuntimeMachine,
} from "./runtime.ts";

/** A stage entry with `mode` elided — the adapter always forces copy mode. */
export type CopyStageEntry = Omit<StageEntry, "mode">;

/** A jailed cold-boot request (snapshot-restore §4 twin: {@link JailedRestoreRequest}). */
export interface JailedLaunchRequest {
  /** The owning sandbox id (`sbx_loc_…`). */
  readonly sandboxId: string;
  /** Fresh per boot attempt; never the public stable sandbox id. */
  readonly executionId: string;
  /** Jailer options minus `id`/`stage` (the adapter supplies those). */
  readonly jailer: Omit<JailerOptions, "id" | "stage">;
  /** Caller cannot select hardlinks; the adapter always emits copy mode. */
  readonly stage: ReadonlyArray<CopyStageEntry>;
  /** The cold-boot machine configuration. */
  readonly config: VmConfig;
  /** Deadline (ms) for the guest agent to become reachable. */
  readonly readinessTimeoutMs?: number;
  /** External cancellation. */
  readonly signal?: AbortSignal;
  /** Jailer metadata (sandbox/execution id keys). */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A jailed snapshot-restore request (snapshot-restore §4): the twin of
 * {@linkcode JailedLaunchRequest} that carries a snapshot to load instead of a
 * cold {@linkcode VmConfig}. The `stage` copies the snapshot/mem/rootfs/overlay
 * into the fresh jail exactly as the launch path stages the golden set (copy
 * mode is forced); the `snapshot` names the IN-JAIL paths plus the per-restore
 * `network_overrides` (re-point the NIC to this sandbox's TAP) and
 * `vsock_override` (rebind the host-side UDS in this jail). No {@linkcode
 * VmConfig} applies — the snapshot carries the machine configuration.
 */
export interface JailedRestoreRequest {
  readonly sandboxId: string;
  /** Fresh per restore attempt; never the public stable sandbox id. */
  readonly executionId: string;
  readonly jailer: Omit<JailerOptions, "id" | "stage">;
  /** Caller cannot select hardlinks; the adapter always emits copy mode. */
  readonly stage: ReadonlyArray<CopyStageEntry>;
  /** Wire-verbatim `PUT /snapshot/load` params (in-jail snapshot/mem paths). */
  readonly snapshot: SnapshotLoadParams;
  readonly readinessTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Shutdown controls layering a supervisor deadline over the package stages. */
export interface AdapterShutdownOptions {
  /** Per-stage shutdown timers passed through to the package. */
  readonly stages?: ShutdownOptions;
  /** Outer supervisor wall clock, independent of package stage timers. */
  readonly timeoutMs?: number;
}

export interface FirecrackerAdapterOptions {
  readonly registry: CreateOnlyVmRegistry;
  readonly runtime?: FirecrackerRuntime;
}

/** Narrow root-side integration boundary around @nullstyle/firecracker. */
export class FirecrackerAdapter {
  readonly #registry: CreateOnlyVmRegistry;
  readonly #runtime: FirecrackerRuntime;

  /** Wire the registry and (optionally) an injected runtime for tests. */
  constructor(options: FirecrackerAdapterOptions) {
    this.#registry = options.registry;
    this.#runtime = options.runtime ?? nullstyleFirecrackerRuntime;
  }

  /** The runtime's Firecracker compatibility window. */
  get compatibility(): FirecrackerCompatibility {
    return this.#runtime.compatibility;
  }

  /** Cold-boot a jailed microVM and journal it; resolves the live machine. */
  async launch(request: JailedLaunchRequest): Promise<FirecrackerMachine> {
    assertExecutionId(request.executionId);
    const options = {
      jailer: {
        ...request.jailer,
        id: request.executionId,
        stage: request.stage.map(copyStageEntry),
      },
      config: request.config,
      registry: this.#registry,
      ...(request.readinessTimeoutMs === undefined
        ? {}
        : { readinessTimeoutMs: request.readinessTimeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      metadata: {
        ...request.metadata,
        [SANDBOX_ID_METADATA]: request.sandboxId,
        [EXECUTION_ID_METADATA]: request.executionId,
      },
    };

    try {
      const machine = await this.#runtime.launch(options);
      return new FirecrackerMachine(request.sandboxId, machine);
    } catch (error) {
      let cleanupIncomplete = false;
      try {
        const result = await this.#runtime.reconcile(
          scopeRegistry(this.#registry, request.executionId),
          // The caller's create signal may already be aborted. Cleanup is a
          // separate supervisor obligation and must still run.
          { killLive: true },
        );
        cleanupIncomplete = result.failures.length > 0 ||
          result.stillRunning.length > 0;
      } catch {
        cleanupIncomplete = true;
      }
      throw normalizeFirecrackerError(error, {
        operation: "launch Firecracker",
        signal: request.signal,
        cleanupIncomplete,
      });
    }
  }

  /**
   * Restore a sandbox from a warm-template snapshot (snapshot-restore §4): the
   * twin of {@linkcode FirecrackerAdapter.launch}. Stages the
   * snapshot/mem/rootfs/overlay into a fresh jail (copy mode), calls the
   * package `Machine.restore` with the same jailer/registry/metadata wiring as
   * a cold launch, and returns a {@linkcode FirecrackerMachine} the supervisor
   * drives identically to a launched one (pid authority, vsock accessor,
   * dispose/reclaim). A failed restore reconciles ONLY its own execution id,
   * exactly like a failed launch, and never touches the cold launch path.
   */
  async restore(request: JailedRestoreRequest): Promise<FirecrackerMachine> {
    assertExecutionId(request.executionId);
    const options: JailedRestoreOptions = {
      jailer: {
        ...request.jailer,
        id: request.executionId,
        stage: request.stage.map(copyStageEntry),
      },
      snapshot: request.snapshot,
      registry: this.#registry,
      ...(request.readinessTimeoutMs === undefined
        ? {}
        : { readinessTimeoutMs: request.readinessTimeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      metadata: {
        ...request.metadata,
        [SANDBOX_ID_METADATA]: request.sandboxId,
        [EXECUTION_ID_METADATA]: request.executionId,
      },
    };

    try {
      const machine = await this.#runtime.restore(options);
      return new FirecrackerMachine(request.sandboxId, machine);
    } catch (error) {
      let cleanupIncomplete = false;
      try {
        const result = await this.#runtime.reconcile(
          scopeRegistry(this.#registry, request.executionId),
          // The caller's restore signal may already be aborted. Cleanup is a
          // separate supervisor obligation and must still run.
          { killLive: true },
        );
        cleanupIncomplete = result.failures.length > 0 ||
          result.stillRunning.length > 0;
      } catch {
        cleanupIncomplete = true;
      }
      throw normalizeFirecrackerError(error, {
        operation: "restore Firecracker",
        signal: request.signal,
        cleanupIncomplete,
      });
    }
  }

  /** Destructive 1.0 restart policy: terminate and reclaim every journal. */
  async reconcileAfterSupervisorRestart(
    signal?: AbortSignal,
  ): Promise<ReconcileResult> {
    try {
      return await this.#runtime.reconcile(this.#registry, {
        killLive: true,
        signal,
      });
    } catch (error) {
      throw normalizeFirecrackerError(error, {
        operation: "reconcile Firecracker after supervisor restart",
        signal,
        cleanupIncomplete: true,
      });
    }
  }
}

/** A launched machine that tracks every outbound vsock connection. */
export class FirecrackerMachine implements AsyncDisposable {
  /** The owning sandbox id (`sbx_loc_…`). */
  readonly sandboxId: string;
  readonly #machine: RuntimeMachine;
  readonly #outbound = new Set<VsockConn>();

  /** Wrap a launched/restored runtime machine for `sandboxId`. */
  constructor(sandboxId: string, machine: RuntimeMachine) {
    this.sandboxId = sandboxId;
    this.#machine = machine;
    void machine.exited.then(() => this.closeOutboundConnections());
  }

  /** The boot attempt's execution id (the VMM id). */
  get executionId(): string {
    return this.#machine.vmId;
  }

  /** The VMM process pid. */
  get pid(): number {
    return this.#machine.pid;
  }

  /** Current VMM lifecycle state. */
  get state(): RuntimeMachine["state"] {
    return this.#machine.state;
  }

  /** Resolves when the VMM process exits. */
  get exited(): Promise<VmmExit> {
    return this.#machine.exited;
  }

  /** Dial a guest vsock port, tracking the connection for teardown. */
  async connectVsock(
    port: number,
    options?: VsockDialOptions,
  ): Promise<VsockConn> {
    try {
      const connection = await this.#machine.vsock.connect(port, options);
      this.#outbound.add(connection);
      return connection;
    } catch (error) {
      throw normalizeFirecrackerError(error, {
        operation: "connect guest vsock",
        signal: options?.signal,
      });
    }
  }

  /** Close every tracked outbound vsock connection (idempotent). */
  closeOutboundConnections(): void {
    for (const connection of this.#outbound) {
      try {
        connection.close();
      } catch {
        // A caller may already have closed the Deno.Conn.
      }
    }
    this.#outbound.clear();
  }

  /** Graceful shutdown under an optional supervisor deadline; force-kills on expiry. */
  async shutdown(options: AdapterShutdownOptions = {}): Promise<VmmExit> {
    this.closeOutboundConnections();
    const operation = "shut down Firecracker";
    try {
      const shutdown = this.#machine.shutdown(options.stages);
      if (options.timeoutMs === undefined) return await shutdown;
      return await withDeadline(shutdown, options.timeoutMs);
    } catch (error) {
      if (error instanceof OuterDeadlineError) {
        void this.#machine.kill().catch(() => {});
      }
      throw normalizeFirecrackerError(error, {
        operation,
        deadlineExpired: error instanceof OuterDeadlineError,
      });
    }
  }

  /** Force-terminate the VMM; resolves the observed exit. */
  async kill(): Promise<VmmExit> {
    this.closeOutboundConnections();
    try {
      return await this.#machine.kill();
    } catch (error) {
      throw normalizeFirecrackerError(error, {
        operation: "kill Firecracker",
      });
    }
  }

  /** `await using` disposal — closes connections and disposes the VMM. */
  async [Symbol.asyncDispose](): Promise<void> {
    this.closeOutboundConnections();
    try {
      await this.#machine[Symbol.asyncDispose]();
    } catch (error) {
      throw normalizeFirecrackerError(error, {
        operation: "dispose Firecracker",
        cleanupIncomplete: true,
      });
    }
  }
}

function copyStageEntry(entry: CopyStageEntry): StageEntry {
  return {
    hostPath: entry.hostPath,
    ...(entry.jailPath === undefined ? {} : { jailPath: entry.jailPath }),
    ...(entry.readWrite === undefined ? {} : { readWrite: entry.readWrite }),
    mode: "copy",
  };
}

class OuterDeadlineError extends Error {
  constructor() {
    super("the outer Firecracker operation deadline expired");
    this.name = "OuterDeadlineError";
  }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new FirecrackerAdapterError({
      code: "SBX_FC_STATE",
      operation: "validate Firecracker deadline",
      message:
        "validate Firecracker deadline was invalid for the current VMM state",
      retryable: false,
    });
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OuterDeadlineError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
