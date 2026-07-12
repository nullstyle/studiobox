/**
 * studioboxd guest-agent plane: the transport-free {@linkcode AgentApi}
 * domain contract (M3). Implementations live beside it:
 * `processes`/`env`/`deno_runtime` (Track A), `fs` (Track B), the
 * in-process FakeSandboxHost (host phase), with the capnp
 * `sandbox_agent.capnp` wire adapter attaching on top once upstream
 * codegen is unblocked. See `./api.ts` for the contract, including the
 * sandbox-root confinement rules.
 *
 * @module
 */

export { AgentError, SeekMode } from "./api.ts";
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
  CodeExtension,
  DirEntry,
  ExpandGlobOptions,
  FileInfo,
  MkdirOptions,
  OpenOptions,
  ReadFileOptions,
  RemoveOptions,
  Signal,
  WalkEntry,
  WalkOptions,
  WriteFileOptions,
} from "./api.ts";

// Implementations (Track A: processes/env/deno_runtime; Track B: fs).
// `replServerSource` and the repl codec stay internal to deno_runtime.
export {
  AgentEnv,
  layerSpawnEnv,
  validateEnvName,
  validateEnvValue,
} from "./env.ts";
export {
  AgentProcesses,
  collectOutput,
  normalizeSandboxPath,
  resolveSandboxPath,
  sandboxCwd,
  sandboxHome,
  validateSpawnSpec,
} from "./processes.ts";
export type {
  AgentProcessesOptions,
  AgentProcessOutput,
  EnvSnapshotSource,
  ResolvedSandboxPath,
} from "./processes.ts";
export { AgentDeno } from "./deno_runtime.ts";
export type { AgentDenoOptions } from "./deno_runtime.ts";
export { AgentFs } from "./fs.ts";

// Wire plane: the capnp `sandbox_agent.capnp` adapter over `AgentApi`
// (M3 agent core). Server-side transport wiring plus the wire-facing
// identity/limits vocabulary.
export {
  AGENT_PLANE_FEATURES,
  createAgentWireConnection,
  DEFAULT_OUTPUT_CALL_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
  serveAgentWireTransport,
} from "./service.ts";
export type {
  AgentWireConnection,
  AgentWireOptions,
  AgentWireServer,
} from "./service.ts";

// Streaming SHA-256 (TransferCommit verification).
export { Sha256, sha256 } from "./sha256.ts";
