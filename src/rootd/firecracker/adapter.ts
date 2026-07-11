import type {
  JailerOptions,
  ReconcileResult,
  ShutdownOptions,
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

export type CopyStageEntry = Omit<StageEntry, "mode">;

export interface JailedLaunchRequest {
  readonly sandboxId: string;
  /** Fresh per boot attempt; never the public stable sandbox id. */
  readonly executionId: string;
  readonly jailer: Omit<JailerOptions, "id" | "stage">;
  /** Caller cannot select hardlinks; the adapter always emits copy mode. */
  readonly stage: ReadonlyArray<CopyStageEntry>;
  readonly config: VmConfig;
  readonly readinessTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AdapterShutdownOptions {
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

  constructor(options: FirecrackerAdapterOptions) {
    this.#registry = options.registry;
    this.#runtime = options.runtime ?? nullstyleFirecrackerRuntime;
  }

  get compatibility(): FirecrackerCompatibility {
    return this.#runtime.compatibility;
  }

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
  readonly sandboxId: string;
  readonly #machine: RuntimeMachine;
  readonly #outbound = new Set<VsockConn>();

  constructor(sandboxId: string, machine: RuntimeMachine) {
    this.sandboxId = sandboxId;
    this.#machine = machine;
    void machine.exited.then(() => this.closeOutboundConnections());
  }

  get executionId(): string {
    return this.#machine.vmId;
  }

  get pid(): number {
    return this.#machine.pid;
  }

  get state(): RuntimeMachine["state"] {
    return this.#machine.state;
  }

  get exited(): Promise<VmmExit> {
    return this.#machine.exited;
  }

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
