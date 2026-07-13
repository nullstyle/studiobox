/**
 * **Unstable** host-assembly surface — the `studiobox-hostd` / `studiobox-rootd`
 * runtime daemon seams, for embedders that assemble a local host rather than
 * merely consume the `@deno/sandbox` drop-in client (the package root `.`).
 *
 * Unlike the client surface, NOTHING here follows the `@deno/sandbox` shape or
 * carries a stability guarantee before 1.0: the tunnel authorization boundary,
 * the Firecracker adapter, the journal-driven supervisor core, the guest-agent
 * `AgentApi` contract, and the capnp `supervisor.capnp` wire plane may all
 * change between minor releases. Import from `@nullstyle/studiobox/unstable-host`
 * and pin exactly.
 *
 * @module
 */

// studiobox-hostd seam: ticket-gated tunnel authorization.
export { TunnelAuthorizer } from "./src/hostd/tunnel_authorizer.ts";
export type {
  PrivilegedBridgeFactory,
  PrivilegedBridgeRequest,
} from "./src/hostd/tunnel_authorizer.ts";
// The domain grant shape `HostSandbox.openTunnel` returns and the E2E/SDK
// client consumes (ticket + loopback endpoint + agent binding).
export type { TunnelGrant } from "./src/hostd/control_core.ts";

// Client tunnel dial (the external leg of the ticketed tunnel): present the
// `SBXTUN1` preface carrying a single-use ticket and, on `SBXACK1(Ok)`, get
// back the raw duplex to the guest agent's capnp `SandboxAgent` plane.
export {
  DEFAULT_TUNNEL_DIAL_TIMEOUT_MS,
  dialTunnel,
  TunnelDialError,
} from "./src/transports/tunnel_client.ts";
export type { TunnelEndpoint } from "./src/transports/tunnel_client.ts";

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
// (the capnp wire adapter attaches on top of `SupervisorApi`; this surface is
// transport-free).
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

// studioboxd guest-agent domain core: the transport-free `AgentApi`
// contract mirroring `schema/sandbox_agent.capnp`. Only the Agent*
// vocabulary is surfaced here — the agent barrel's carried convenience
// re-exports (`Signal`, `SeekMode`, `FileInfo`, ...) already reach the
// package root through the client SDK barrel.
export { AgentError } from "./src/agent/mod.ts";
export type {
  AgentApi,
  AgentDenoRepl,
  AgentDenoReplOptions,
  AgentDenoRunSpec,
  AgentDenoRuntime,
  AgentEnvironment,
  AgentErrorCode,
  AgentFileSystem,
  AgentFsFile,
  AgentInfo,
  AgentKillSignal,
  AgentMakeTempOptions,
  AgentOomAnnotator,
  AgentProcess,
  AgentProcessSpawner,
  AgentProcessStatus,
  AgentRootConfig,
  AgentSpawnSpec,
  AgentStdioMode,
  AgentSymlinkOptions,
} from "./src/agent/mod.ts";

// studiobox-rootd supervisor wire plane: the capnp `supervisor.capnp`
// adapter over `SupervisorApi` plus the UDS server assembly, for hostd
// embedders.
export {
  buildSupervisorContractIdentity,
  contractIdentityFromWire,
  contractIdentityToWire,
  createSupervisorWireConnection,
  protocolOfferToWire,
  SUPERVISOR_FEATURE_BITS,
  supervisorFaultToWire,
  transportLimitsFromWire,
  transportLimitsToWire,
} from "./src/rootd/service.ts";
export type {
  SupervisorCompatIdentitySource,
  SupervisorIdentityOptions,
  SupervisorWireConnection,
  SupervisorWireOptions,
} from "./src/rootd/service.ts";
export {
  startSupervisorServer,
  UdsSupervisorAcceptSource,
} from "./src/rootd/main.ts";
export type {
  SupervisorServerHandle,
  SupervisorServerOptions,
  SupervisorServerStats,
} from "./src/rootd/main.ts";
