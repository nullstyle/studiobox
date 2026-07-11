/**
 * Local, Firecracker-backed implementation of the declared
 * `@deno/sandbox` execution surface.
 *
 * The upstream-parity SDK surface (the `@deno/sandbox` API shape) is
 * re-exported wholesale from `src/mod.ts`. Below it, the package also
 * surfaces the runtime daemon seams — the `studiobox-hostd` tunnel
 * authorization boundary and the `studiobox-rootd` Firecracker adapter —
 * for embedders that assemble a local host.
 *
 * @module
 */

// Public SDK surface (upstream `@deno/sandbox` parity barrel).
export * from "./src/mod.ts";

// studiobox-hostd seam: ticket-gated tunnel authorization.
export { TunnelAuthorizer } from "./src/hostd/tunnel_authorizer.ts";
export type {
  PrivilegedBridgeFactory,
  PrivilegedBridgeRequest,
} from "./src/hostd/tunnel_authorizer.ts";

// studiobox-rootd seam: Firecracker adapter surface (root-side daemon
// boundary; not part of the upstream-parity SDK surface).
export {
  assertExecutionId,
  createExecutionId,
  CreateOnlyVmRegistry,
  EXECUTION_ID_METADATA,
  ExecutionIdConflictError,
  FirecrackerAdapter,
  FirecrackerAdapterError,
  FirecrackerMachine,
  normalizeFirecrackerError,
  SANDBOX_ID_METADATA,
  SandboxStateJailRecordStore,
  scopeRegistry,
  StaleExecutionIdError,
} from "./src/rootd/firecracker/mod.ts";
export type {
  AdapterShutdownOptions,
  AtomicJailRecordStore,
  CopyStageEntry,
  FirecrackerAdapterErrorCode,
  FirecrackerCompatibility,
  FirecrackerRuntime,
  JailedLaunchRequest,
  RuntimeMachine,
} from "./src/rootd/firecracker/mod.ts";

// studiobox-rootd supervisor domain core: journal-driven machine lifecycle
// (capnp wire adapter attaches on top of `SupervisorApi` in a later
// milestone; this surface is transport-free).
export {
  NOOP_RECLAIM_HOOKS,
  SupervisorCore,
} from "./src/rootd/supervisor_core.ts";
export type {
  ReclaimHook,
  SupervisorCoreOptions,
  SupervisorLaunchPlan,
  SupervisorLaunchPlanner,
} from "./src/rootd/supervisor_core.ts";
export { SupervisorError } from "./src/rootd/supervisor_core_api.ts";
export { JournalArtifactReferenceReader } from "./src/rootd/artifact_refs.ts";
export type { SandboxRecordSource } from "./src/rootd/artifact_refs.ts";
export type { ArtifactReference } from "./src/state/model.ts";
export type {
  SupervisorApi,
  SupervisorErrorCode,
  SupervisorHealth,
  SupervisorMachineState,
  SupervisorMachineStatus,
  SupervisorMachineUsage,
  SupervisorReconcileFailure,
  SupervisorReconcileSummary,
} from "./src/rootd/supervisor_core_api.ts";
