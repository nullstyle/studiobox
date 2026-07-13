export { Sandbox, VsCode } from "./api/sandbox.ts";
export {
  KillController,
  KillSignal,
  type KillSignalListener,
} from "./api/process.ts";
export {
  ChildProcess,
  type ChildProcessOutput,
  type ChildProcessStatus,
  type Signal,
} from "./api/process.ts";
export type { SandboxEnv } from "./api/env.ts";
export {
  type DirEntry,
  type ExpandGlobOptions,
  type FileInfo,
  FsFile,
  type MkdirOptions,
  type OpenOptions,
  type ReadFileOptions,
  type RemoveOptions,
  type SandboxFs,
  SeekMode,
  type WalkEntry,
  type WalkOptions,
  type WriteFileOptions,
} from "./api/fs.ts";
export {
  type Build,
  type BuildOptions,
  type CodeExtension,
  DenoProcess,
  DenoRepl,
  type DenoReplOptions,
  type DenoRunOptions,
  type DeployOptions,
  type SandboxDeno,
} from "./api/deno.ts";
export type {
  ConnectOptions,
  RequestInit,
  SandboxOptions,
  SpawnOptions,
  VsCodeOptions,
} from "./api/sandbox.ts";
export {
  ApiError,
  ConnectionClosedError,
  ConnectionEstablishmentError,
  HostCapacityError,
  InvalidMemoryError,
  InvalidTimeoutError,
  InvalidTokenError,
  MissingTokenError,
  NetworkError,
  ProviderNotInstalledError,
  RpcError,
  SandboxCommandError,
  SandboxKillError,
  SandboxSdkError,
  UnsupportedFeatureError,
} from "./api/errors.ts";
export type { Memory } from "./api/memory.ts";
export type {
  App,
  AppConfig,
  AppConfigBase,
  AppId,
  AppInit,
  AppListOptions,
  AppLogsOptions,
  Apps,
  AppSlug,
  AppUpdate,
  BuildLog,
  BuildLogsOptions,
  BuildStep,
  Cursor,
  DeployAsset,
  DeployConfig,
  DeployInit,
  DeployRevision,
  EnvVar,
  EnvVarInit,
  EnvVarUpdate,
  Framework,
  Layer,
  LayerAppRef,
  LayerAppsListOptions,
  LayerId,
  LayerInit,
  LayerListOptions,
  LayerRef,
  Layers,
  LayerSlug,
  LayerUpdate,
  ListOptions,
  LogLevel,
  PaginatedList,
  Region,
  Revision,
  RevisionConfig,
  RevisionEnvVar,
  RevisionFailureReason,
  RevisionListOptions,
  RevisionProgress,
  RevisionProgressCompletedStage,
  RevisionProgressDeployingStage,
  RevisionProgressPendingStage,
  RevisionProgressRoutingStage,
  RevisionProgressRunningStage,
  RevisionProgressSkippedStage,
  RevisionProgressStage,
  RevisionProgressStageStatus,
  RevisionProgressStageWithCommand,
  RevisionProgressTimelineBlockedStage,
  RevisionProgressTimelineRef,
  RevisionProgressTimelineStage,
  Revisions,
  RevisionStatus,
  RuntimeConfig,
  RuntimeLog,
  Sandboxes,
  SandboxesListOptions,
  SandboxMetadata,
  SecretConfig,
  SnapshotId,
  SnapshotInit,
  SnapshotListOptions,
  Snapshots,
  SnapshotSlug,
  Timeline,
  TimelineListOptions,
  Timelines,
  VolumeId,
  VolumeInit,
  VolumeListOptions,
  Volumes,
  VolumeSlug,
} from "./api/types.ts";
export { Volume } from "./api/volume.ts";
export { Snapshot } from "./api/snapshot.ts";
export { type BaseClientOptions, Client } from "./api/client.ts";

import { ProviderNotInstalledError } from "./api/errors.ts";
import { registerDefaultSandboxProvider } from "./api/provider.ts";

// Auto-wire the real provider from the environment the first time
// `Sandbox.create()`/`connect()`/`list()` runs with nothing installed
// explicitly — so `import { Sandbox } from "@nullstyle/studiobox"` is a true
// drop-in once a host is up (STUDIOBOX_HOST/STUDIOBOX_TUNNEL set). The
// host-dialing graph (`./sdk/provider.ts` → hostd/rootd/capnp) is loaded via
// DYNAMIC import so it never enters the client barrel's static graph, and it
// only loads when the fallback actually fires. An explicitly installed provider
// (a `FakeSandboxHost`, or `installStudiobox()`) always wins; a missing
// environment surfaces as an actionable `ProviderNotInstalledError`.
registerDefaultSandboxProvider(async () => {
  try {
    const { StudioboxProvider } = await import("./sdk/provider.ts");
    return StudioboxProvider.fromEnv();
  } catch (cause) {
    throw new ProviderNotInstalledError(cause);
  }
});
