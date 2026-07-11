import {
  FIRECRACKER_COMPAT,
  Machine,
  type MachineOptions,
  reconcile,
  type ReconcileOptions,
  type ReconcileResult,
  type ShutdownOptions,
  type VmmExit,
  type VmRegistry,
  type VmState,
  type VsockConn,
  type VsockDialOptions,
} from "@nullstyle/firecracker";

/** The Machine surface used by Studiobox; intentionally smaller than Machine. */
export interface RuntimeMachine {
  readonly vmId: string;
  readonly pid: number;
  readonly state: VmState;
  readonly exited: Promise<VmmExit>;
  readonly vsock: {
    connect(port: number, options?: VsockDialOptions): Promise<VsockConn>;
  };
  shutdown(options?: ShutdownOptions): Promise<VmmExit>;
  kill(): Promise<VmmExit>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface FirecrackerCompatibility {
  readonly pinned: string;
  readonly min: string;
}

/** Injection seam used by host-safe tests and the real package adapter. */
export interface FirecrackerRuntime {
  readonly compatibility: FirecrackerCompatibility;
  launch(options: MachineOptions): Promise<RuntimeMachine>;
  reconcile(
    registry: VmRegistry,
    options?: ReconcileOptions,
  ): Promise<ReconcileResult>;
}

export const nullstyleFirecrackerRuntime: FirecrackerRuntime = Object.freeze({
  compatibility: FIRECRACKER_COMPAT,
  launch: (options: MachineOptions) => Machine.launch(options),
  reconcile,
});
