import {
  FIRECRACKER_COMPAT,
  Machine,
  type MachineOptions,
  reconcile,
  type ReconcileOptions,
  type ReconcileResult,
  type RestoreOptions,
  type ShutdownOptions,
  type VmmExit,
  type VmRegistry,
  type VmState,
  type VsockConn,
  type VsockDialOptions,
} from "@nullstyle/firecracker";

/** The Machine surface used by Studiobox; intentionally smaller than Machine. */
export interface RuntimeMachine {
  /** The VMM's stable id. */
  readonly vmId: string;
  /** The VMM process pid (pidfile authority). */
  readonly pid: number;
  /** Current VMM lifecycle state. */
  readonly state: VmState;
  /** Resolves when the VMM process exits. */
  readonly exited: Promise<VmmExit>;
  /** Guest vsock accessor for dialing agent ports. */
  readonly vsock: {
    /** Dial a guest vsock port. */
    connect(port: number, options?: VsockDialOptions): Promise<VsockConn>;
  };
  /** Graceful shutdown; resolves the observed exit. */
  shutdown(options?: ShutdownOptions): Promise<VmmExit>;
  /** Force-terminate the VMM; resolves the observed exit. */
  kill(): Promise<VmmExit>;
  /** `await using` disposal — reclaims the machine. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** The Firecracker version window the runtime advertises. */
export interface FirecrackerCompatibility {
  /** The exact pinned Firecracker version. */
  readonly pinned: string;
  /** The minimum Firecracker version accepted. */
  readonly min: string;
}

/** Injection seam used by host-safe tests and the real package adapter. */
export interface FirecrackerRuntime {
  /** The runtime's Firecracker compatibility window. */
  readonly compatibility: FirecrackerCompatibility;
  /** Spawn a fresh VMM and boot it (cold path). */
  launch(options: MachineOptions): Promise<RuntimeMachine>;
  /**
   * Spawn a fresh VMM and load a snapshot into it (the snapshot-restore fast
   * path). The restored machine comes back `running` when
   * `snapshot.resume_vm` is set, and is otherwise driven exactly like a
   * launched one (pidfile pid authority, vsock accessor, dispose/reclaim).
   */
  restore(options: RestoreOptions): Promise<RuntimeMachine>;
  /** Reconcile the registry against live VMMs (crash recovery / leak sweep). */
  reconcile(
    registry: VmRegistry,
    options?: ReconcileOptions,
  ): Promise<ReconcileResult>;
}

export const nullstyleFirecrackerRuntime: FirecrackerRuntime = Object.freeze({
  compatibility: FIRECRACKER_COMPAT,
  launch: (options: MachineOptions) => Machine.launch(options),
  restore: (options: RestoreOptions) => Machine.restore(options),
  reconcile,
});
