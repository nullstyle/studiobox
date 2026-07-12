/**
 * The studioboxd guest-agent DOMAIN interface.
 *
 * {@linkcode AgentApi} is a plain TypeScript mirror of the
 * `schema/sandbox_agent.capnp` `SandboxAgent` plane semantics —
 * `ProcessSpawner`/`Process`, `FileSystem`/`RemoteFile`, `Environment`,
 * `DenoRuntime`/`DenoRepl`, plus `ping` — expressed transport-free so the
 * M3 fake host and the real in-guest agent implement one contract.
 *
 * **Wire adapter note (blocked upstream, same split as M2):** once capnp
 * codegen for the five-schema bundle is unblocked in capnp-deno, the
 * `sandbox_agent.capnp` capnp services become *thin adapters* over these
 * interfaces — each RPC method decodes its request struct, calls the
 * same-named method here, and encodes the result / `SbxError` union.
 * Wire-only mechanics do not appear here and are owned by that adapter:
 * `OutputSink` push streams (domain: `ReadableStream` pulls),
 * `writeStdin(sequence, data) -> stream` flow control (domain: promise
 * backpressure), `TransferCommit`/`FinishResult` framing, `Upload`
 * chunking, and `Process.release` capability lifetime. Nothing in this
 * module may import `src/wire/generated/` or `@nullstyle/capnp`.
 *
 * **Upstream fidelity (target `@deno/sandbox@0.13.2`):** doc comments on
 * each member carry the upstream semantics they mirror; DESIGN.md §5
 * Tier A is the authoritative inventory. `fs.upload`/`fs.download` are
 * SDK-side recursion (M8) and deliberately NOT agent surface.
 *
 * ## Sandbox-root confinement contract
 *
 * Every filesystem path and every process working directory resolves
 * within a configured {@linkcode AgentRootConfig.root}. The real guest
 * runs with `root: "/"` (the microVM boundary is the actual jail, so the
 * checks are vacuous there); the fake host roots every sandbox in a
 * per-sandbox temp dir and relies on these rules for isolation of the
 * *test host* (they are a correctness contract for the fake, not a
 * security boundary against hostile code — hostile workloads belong in
 * the VM).
 *
 * Resolution rules (normative, in order):
 *
 * 1. **Logical view.** Callers speak in-sandbox paths. A relative path
 *    resolves against the effective in-sandbox cwd (default
 *    {@linkcode AgentRootConfig.home}, itself defaulting to `/home/app`
 *    — the upstream guest home and cwd). An absolute in-sandbox path is
 *    rooted at the sandbox root, never at the host root.
 * 2. **Lexical normalization.** `.` and `..` segments are folded before
 *    any host path is formed; `..` at the sandbox root clamps to the
 *    root, mirroring POSIX `/.. == /` so real-guest and fake behavior
 *    agree.
 * 3. **Host mapping.** The normalized in-sandbox path is joined under
 *    `root` to produce the host path actually touched.
 * 4. **Symlink policy: resolve, then verify containment.** After the
 *    lexical mapping, implementations resolve symlinks (the deepest
 *    existing ancestor via realpath, plus each traversed link target)
 *    and verify the resolved host path still lies within `root`. A
 *    resolution that lands outside `root` throws
 *    {@linkcode AgentError} `SBX_AGENT_PATH_ESCAPE` — never a silent
 *    re-clamp, never a fallback to the unresolved path. Symlink
 *    *targets* are stored verbatim (relative targets stay relative, as
 *    upstream's download preserves them); confinement is enforced at
 *    traversal time, not at link-creation time, so dangling and
 *    out-of-root links may exist but cannot be followed.
 * 5. Operations that *return* paths (`realPath`, `makeTempDir`,
 *    `makeTempFile`, `readLink`, `walk`/`expandGlob` entries, cwd
 *    defaults) return in-sandbox paths — the host prefix never leaks
 *    across this interface.
 *
 * @module
 */

import type { Signal } from "../api/process.ts";
import type {
  DirEntry,
  ExpandGlobOptions,
  FileInfo,
  MkdirOptions,
  OpenOptions,
  ReadFileOptions,
  RemoveOptions,
  SeekMode,
  WalkEntry,
  WalkOptions,
  WriteFileOptions,
} from "../api/fs.ts";
import type { CodeExtension } from "../api/deno.ts";

// Re-export the carried upstream-shaped vocabulary the contract is written
// in, so implementations and tests import everything from this module (or
// the `src/agent/mod.ts` barrel) without reaching into `src/api/`.
export type { Signal } from "../api/process.ts";
export { SeekMode } from "../api/fs.ts";
export type {
  DirEntry,
  ExpandGlobOptions,
  FileInfo,
  MkdirOptions,
  OpenOptions,
  ReadFileOptions,
  RemoveOptions,
  WalkEntry,
  WalkOptions,
  WriteFileOptions,
} from "../api/fs.ts";
export type { CodeExtension } from "../api/deno.ts";

// ---------------------------------------------------------------------------
// Sandbox-root confinement
// ---------------------------------------------------------------------------

/**
 * Where a sandbox lives on the host and how in-sandbox paths map onto it.
 * See the module doc's "Sandbox-root confinement contract" for the
 * normative resolution + escape rules every implementation follows.
 */
export interface AgentRootConfig {
  /**
   * Absolute host directory that contains the whole sandbox filesystem.
   * `"/"` in the real guest; a per-sandbox temp dir in the fake host.
   */
  readonly root: string;
  /**
   * Effective in-sandbox home directory (`$HOME`). Defaults to
   * `/home/app`, matching the upstream guest image (user `sandbox`,
   * uid 1000, home `/home/app`).
   */
  readonly home?: string;
  /**
   * Default in-sandbox working directory for spawns and relative path
   * resolution. Defaults to {@linkcode AgentRootConfig.home}.
   */
  readonly cwd?: string;
}

/** Discriminants for {@linkcode AgentError}. */
export type AgentErrorCode =
  /**
   * A path resolved (post-symlink) outside the sandbox root — rule 4 of
   * the confinement contract.
   */
  | "SBX_AGENT_PATH_ESCAPE"
  /** A request failed structural validation (bad spec, bad mode, ...). */
  | "SBX_AGENT_VALIDATION"
  /**
   * A handle (process stdin, fs file, repl) was used after it was closed
   * or its owning process exited. `close()` itself is idempotent and
   * never throws this.
   */
  | "SBX_AGENT_CLOSED"
  /** The operation is invalid for the current state of the target. */
  | "SBX_AGENT_STATE"
  /**
   * The REPL driver could not evaluate or serialize a result (transport
   * failure, unserializable value). Errors *thrown by the evaluated
   * code* re-throw with the guest error's message instead.
   */
  | "SBX_AGENT_EVAL"
  /** The agent build does not implement the requested operation yet. */
  | "SBX_AGENT_UNSUPPORTED";

/**
 * Typed agent-plane domain error; becomes `SbxError` on the wire adapter.
 *
 * Filesystem operations deliberately do NOT wrap OS errors in this type:
 * they surface `Deno.errors.*` (`NotFound`, `AlreadyExists`,
 * `PermissionDenied`, ...) unchanged, because upstream's `fs.*` mirrors
 * `Deno.*` semantics and the SDK maps those errors 1:1. `AgentError` is
 * reserved for agent-plane failures: confinement violations, closed
 * handles, invalid specs, REPL driver faults.
 */
export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Processes (mirrors `ProcessSpawner` / `Process`)
// ---------------------------------------------------------------------------

/**
 * Signal accepted by {@linkcode AgentProcess.kill}. The full upstream
 * `Signal` union (what `Deno.kill` accepts in-guest), not the narrowed
 * `sandbox_agent.capnp` `KillSignal` enum — widening that wire enum to
 * cover the abort-code set (SIGTERM 143, SIGKILL 137, SIGABRT 134,
 * SIGQUIT 131, SIGINT 130 — see `src/api/process.ts` `abortExitCode`,
 * carried; reuse, don't duplicate) is the wire adapter's concern.
 */
export type AgentKillSignal = Signal;

/**
 * Agent-side stdio request for one stream.
 *
 * Upstream spawn defaults are stdin `"null"`, stdout/stderr `"inherit"` —
 * but `"inherit"` is a CLIENT-side behavior: on the wire the stream is
 * piped and the SDK pipes it into the host's stdout/stderr without
 * closing them. The agent therefore always produces piped streams; the
 * only thing a stdio request controls agent-side is the `"null"`
 * discard. That is modeled explicitly here: the schema's three-valued
 * `StdioMode` (`inherit`/`piped`/`discard`) collapses to this two-valued
 * type at the agent boundary (`inherit` → `"piped"`, `discard` →
 * `"null"`), and re-expanding to upstream's `"inherit"` is SDK-side
 * (M8).
 */
export type AgentStdioMode = "piped" | "null";

/**
 * Mirror of `sandbox_agent.capnp` `SpawnSpec` (with `clearEnv`, which the
 * wire adapter lowers into the env list it sends).
 */
export interface AgentSpawnSpec {
  /** Program to execute (upstream `spawn(command, ...)`). */
  readonly command: string;
  /** Argv after the command. Default `[]`. */
  readonly args?: readonly string[];
  /**
   * In-sandbox working directory; resolves under the sandbox root per
   * the confinement contract. Default: the agent's configured cwd
   * (upstream: `/home/app`).
   */
  readonly cwd?: string;
  /**
   * Per-spawn environment, layered OVER the agent environment
   * ({@linkcode AgentEnvironment} state): agent env is the base, these
   * entries win on conflict.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * When true the inherited agent environment is dropped and `env` is
   * the entire environment of the child.
   */
  readonly clearEnv?: boolean;
  /**
   * Default `"null"` (upstream's stdin default). `"piped"` makes
   * {@linkcode AgentProcess.writeStdin} usable.
   */
  readonly stdin?: AgentStdioMode;
  /**
   * Default `"piped"` — upstream's `"inherit"` default lowers to piped
   * at this boundary (see {@linkcode AgentStdioMode}).
   */
  readonly stdout?: AgentStdioMode;
  /** Default `"piped"`, same lowering as `stdout`. */
  readonly stderr?: AgentStdioMode;
}

/**
 * Terminal status of an exited process; mirror of `sandbox_agent.capnp`
 * `ProcessStatus` with `running` dropped (the domain reports exit via a
 * promise, so a delivered status is always terminal).
 *
 * The SDK derives upstream `ChildProcessStatus` `{success, code, signal}`
 * from this: `success === (code === 0)`. Signal-caused exits report the
 * shell convention `code = 128 + n` (SIGTERM 143, SIGKILL 137, SIGABRT
 * 134, SIGQUIT 131, SIGINT 130) with `signaled: true`.
 */
export interface AgentProcessStatus {
  /** Exit code (128+n for signal exits, matching upstream). */
  readonly code: number;
  /** Terminating signal when the exit was signal-caused, else `null`. */
  readonly signal: AgentKillSignal | null;
  /** True when the exit was caused by a signal. */
  readonly signaled: boolean;
  /**
   * OOM-kill annotation. Only meaningful when `code === 137`; upstream
   * collapses "exit 137 + cgroup memory.events oom_kill" to this
   * boolean. Until real cgroup detection lands (M10) implementations
   * consult their {@linkcode AgentOomAnnotator} seam (default: always
   * `false`).
   */
  readonly oom: boolean;
}

/**
 * The oom annotation seam: consulted once per exit with `code === 137`
 * to decide {@linkcode AgentProcessStatus.oom}. Implementations accept
 * one at construction; the default annotator returns `false`. Real
 * detection (cgroup `memory.events`) replaces the default in M10 —
 * the seam exists now so fakes and tests can exercise the `oom: true`
 * path without cgroups.
 */
export type AgentOomAnnotator = (
  exit: {
    readonly pid: number;
    readonly code: number;
    readonly signal: AgentKillSignal | null;
  },
) => boolean | Promise<boolean>;

/**
 * A live (or exited) child; mirror of `sandbox_agent.capnp` `Process`.
 *
 * Stream ownership: `stdout`/`stderr` are single-reader pull streams fed
 * by the child's pipes; they end (not error) at child EOF. A read
 * failure on the SDK side yields `null` buffers in upstream
 * `ChildProcess.output()` — it never throws — so the agent side never
 * needs to synthesize errors into these streams. The wire adapter later
 * pumps them into `OutputSink`.
 */
export interface AgentProcess {
  /** In-guest pid. */
  readonly pid: number;
  /**
   * Piped stdout bytes; `null` iff the spawn requested
   * `stdout: "null"`.
   */
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  /**
   * Piped stderr bytes; `null` iff the spawn requested
   * `stderr: "null"`.
   */
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  /**
   * Resolves exactly once, when the child exits. Never rejects for a
   * nonzero exit — nonzero is data, not an error (upstream `status`
   * semantics; `sh`'s throw-on-nonzero lives in the SDK builder).
   */
  readonly status: Promise<AgentProcessStatus>;
  /**
   * Deliver a signal (wire `Process.signal`; upstream
   * `ChildProcess.kill(signal?)`, default `"SIGTERM"`). Resolves once
   * the signal is delivered; the exit, if any, is observed via
   * {@linkcode AgentProcess.status}. Signaling an already-exited
   * process is a no-op.
   */
  kill(signal?: AgentKillSignal): Promise<void>;
  /**
   * Write to the child's stdin. Resolves when the bytes are accepted by
   * the pipe (promise backpressure; the wire's `sequence`d `-> stream`
   * flow control is the adapter's concern). Throws `AgentError`
   * `SBX_AGENT_STATE` when the spawn requested `stdin: "null"`, and
   * `SBX_AGENT_CLOSED` after {@linkcode AgentProcess.closeStdin} or
   * child exit.
   */
  writeStdin(data: Uint8Array<ArrayBuffer>): Promise<void>;
  /**
   * Close the child's stdin (EOF). Idempotent; a no-op when stdin is
   * `"null"` or the child already exited.
   */
  closeStdin(): Promise<void>;
}

/** Mirror of `sandbox_agent.capnp` `ProcessSpawner`. */
export interface AgentProcessSpawner {
  /**
   * Spawn a child under the sandbox root (cwd confined per the module
   * contract, uid 1000 in the real guest). Rejects with `AgentError`
   * `SBX_AGENT_VALIDATION` on a malformed spec and surfaces spawn OS
   * failures (`Deno.errors.NotFound` for a missing command, ...)
   * unchanged.
   *
   * The upstream `sh` builder ultimately arrives here as
   * `spawn({ command: "bash", args: ["-c", text], ... })` with
   * `BASH_ENV=$HOME/.bashrc` merged UNDER user env — that assembly is
   * `src/api/command.ts` (carried); the agent just executes the spec.
   */
  spawn(spec: AgentSpawnSpec): Promise<AgentProcess>;
}

// ---------------------------------------------------------------------------
// Filesystem (mirrors `FileSystem` / `RemoteFile`)
// ---------------------------------------------------------------------------

/** Options for {@linkcode AgentFileSystem.makeTempDir}/`makeTempFile`. */
export interface AgentMakeTempOptions {
  /** In-sandbox parent directory; default: the sandbox's temp root. */
  dir?: string;
  prefix?: string;
  suffix?: string;
}

/** Options for {@linkcode AgentFileSystem.symlink}. */
export interface AgentSymlinkOptions {
  /** Ignored on Linux/macOS targets; carried for upstream parity. */
  type?: "file" | "dir" | "junction";
}

/**
 * Open-file handle; mirror of `sandbox_agent.capnp` `RemoteFile` widened
 * to the upstream `FsFile` member set (the wire schema exposes the
 * offset-addressed subset; the adapter tracks the cursor client-side).
 * Mirrors `Deno.FsFile` semantics member-for-member.
 */
export interface AgentFsFile {
  /**
   * Pull stream over the file from the current cursor; pulls 64 KiB
   * chunks (upstream `FsFile.readable` chunk size). Consuming it
   * advances the cursor; it ends at EOF and does not close the handle.
   */
  readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Writable stream appending at the cursor. */
  readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;
  /**
   * Read into `data` at the cursor; resolves the count read, or `null`
   * at EOF (never 0 for a non-empty buffer), mirroring
   * `Deno.FsFile.read`.
   */
  read(data: Uint8Array<ArrayBufferLike>): Promise<number | null>;
  /** Write from `data` at the cursor; resolves the count written. */
  write(data: Uint8Array<ArrayBuffer>): Promise<number>;
  /** Move the cursor; resolves the new offset (`Deno.SeekMode`). */
  seek(offset: number | bigint, whence: SeekMode): Promise<number>;
  /** Truncate (or extend with zeros) to `length` (default 0). */
  truncate(length?: number): Promise<void>;
  stat(): Promise<FileInfo>;
  /** Flush data + metadata (fsync). */
  sync(): Promise<void>;
  /** Flush data only (fdatasync). */
  syncData(): Promise<void>;
  utime(atime: number | Date, mtime: number | Date): Promise<void>;
  /** Advisory lock; `exclusive` defaults to false (shared). */
  lock(exclusive?: boolean): Promise<void>;
  unlock(): Promise<void>;
  /**
   * Close the handle. **Idempotent** — a second `close()` resolves
   * without error (upstream contract); every other member throws
   * `AgentError` `SBX_AGENT_CLOSED` once closed.
   */
  close(): Promise<void>;
}

/**
 * Mirror of `sandbox_agent.capnp` `FileSystem`, widened to the full
 * upstream `fs.*` surface (the wire schema's `stat/list/makeDir/remove/
 * rename/open` core plus the members the adapter composes from it).
 * Every method mirrors the same-named `Deno.*` API's semantics and error
 * types; `walk`/`expandGlob` mirror `jsr:@std/fs`. All paths are
 * in-sandbox strings resolved per the module's confinement contract
 * (`string | URL` unions are SDK-side sugar; the SDK normalizes to
 * strings before this boundary).
 *
 * `upload`/`download` are deliberately absent: upstream implements them
 * SDK-side as recursive compositions over this surface (M8), preserving
 * relative symlinks.
 */
export interface AgentFileSystem {
  /** Mirrors `Deno.readFile`. */
  readFile(path: string, options?: ReadFileOptions): Promise<
    Uint8Array<ArrayBuffer>
  >;
  /**
   * Mirrors `Deno.writeFile`; additionally accepts a streamed body
   * (upstream accepts `ReadableStream` data and streams it to the
   * guest without buffering).
   */
  writeFile(
    path: string,
    data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<void>;
  /** Mirrors `Deno.readTextFile` (strict UTF-8 decode). */
  readTextFile(path: string, options?: ReadFileOptions): Promise<string>;
  /** Mirrors `Deno.writeTextFile`; streamed bodies as `writeFile`. */
  writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void>;
  /** Mirrors `Deno.readDir` (async iterable, no order guarantee). */
  readDir(path: string): AsyncIterable<DirEntry>;
  /** Mirrors `Deno.remove`. */
  remove(path: string, options?: RemoveOptions): Promise<void>;
  /** Mirrors `Deno.mkdir`. */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  /** Mirrors `Deno.rename`. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /**
   * Mirrors `Deno.stat` (follows symlinks — the resolved target must be
   * in-root per confinement rule 4). The wire `FileInfo.kind`
   * (`regular`/`directory`/`symlink`, schema `FileKind`) maps to this
   * shape's `isFile`/`isDirectory`/`isSymlink` booleans.
   */
  stat(path: string): Promise<FileInfo>;
  /** Mirrors `Deno.lstat` (does not follow the final symlink). */
  lstat(path: string): Promise<FileInfo>;
  /** Mirrors `Deno.chmod`. */
  chmod(path: string, mode: number): Promise<void>;
  /** Mirrors `Deno.chown` (`null` leaves the id unchanged). */
  chown(path: string, uid: number | null, gid: number | null): Promise<void>;
  /** Mirrors `Deno.copyFile` (contents + permissions, no metadata). */
  copyFile(fromPath: string, toPath: string): Promise<void>;
  /** Mirrors `Deno.link` (hard link). */
  link(target: string, path: string): Promise<void>;
  /**
   * Mirrors `Deno.symlink`. The target is stored verbatim (may be
   * relative, dangling, or out-of-root — see confinement rule 4:
   * enforcement happens at traversal).
   */
  symlink(
    target: string,
    path: string,
    options?: AgentSymlinkOptions,
  ): Promise<void>;
  /** Mirrors `Deno.readLink` (verbatim stored target). */
  readLink(path: string): Promise<string>;
  /**
   * Mirrors `Deno.realPath`, returned as an in-sandbox path (rule 5);
   * escape during resolution throws `SBX_AGENT_PATH_ESCAPE`.
   */
  realPath(path: string): Promise<string>;
  /** Mirrors `Deno.truncate`. */
  truncate(path: string, length?: number): Promise<void>;
  /**
   * Mirrors `Deno.umask`: sets the sandbox's creation mask when `mask`
   * is given; always resolves the previous mask.
   */
  umask(mask?: number): Promise<number>;
  /** Mirrors `Deno.utime`. */
  utime(
    path: string,
    atime: number | Date,
    mtime: number | Date,
  ): Promise<void>;
  /** Mirrors `Deno.makeTempDir`; resolves an in-sandbox path. */
  makeTempDir(options?: AgentMakeTempOptions): Promise<string>;
  /** Mirrors `Deno.makeTempFile`; resolves an in-sandbox path. */
  makeTempFile(options?: AgentMakeTempOptions): Promise<string>;
  /**
   * Mirrors `Deno.open` (wire `FileSystem.open`); returns the
   * {@linkcode AgentFsFile} handle. Default options are read-only, no
   * create — exactly `Deno.open`'s defaults.
   */
  open(path: string, options?: OpenOptions): Promise<AgentFsFile>;
  /**
   * Mirrors `Deno.create`: open for read/write, create if missing,
   * truncate if present.
   */
  create(path: string): Promise<AgentFsFile>;
  /**
   * Mirrors `jsr:@std/fs` `walk` — entry `path`s are in-sandbox paths
   * (rule 5); `followSymlinks` traversal is subject to confinement
   * rule 4.
   */
  walk(path: string, options?: WalkOptions): AsyncIterableIterator<WalkEntry>;
  /**
   * Mirrors `jsr:@std/fs` `expandGlob`; `options.root` defaults to the
   * effective cwd and is itself confinement-resolved.
   */
  expandGlob(
    glob: string,
    options?: ExpandGlobOptions,
  ): AsyncIterableIterator<WalkEntry>;
}

// ---------------------------------------------------------------------------
// Environment (mirrors `Environment`)
// ---------------------------------------------------------------------------

/**
 * Mirror of `sandbox_agent.capnp` `Environment` (wire `list` ↦
 * `toObject`, wire `EnvValueResult.missing` ↦ `undefined`), with
 * upstream `env.*` semantics: this is the AGENT-process environment that
 * every spawn inherits as its base layer. Per-spawn
 * {@linkcode AgentSpawnSpec.env} layers over it;
 * {@linkcode AgentSpawnSpec.clearEnv} drops it for that spawn.
 * `SandboxOptions.env` applied post-create (M8) lands through
 * {@linkcode AgentEnvironment.set}.
 */
export interface AgentEnvironment {
  /** Value of `key`, or `undefined` when unset (never throws for missing). */
  get(key: string): Promise<string | undefined>;
  /** Set `key` for the agent and all future spawns. */
  set(key: string, value: string): Promise<void>;
  /** Unset `key`; a no-op when already unset. */
  delete(key: string): Promise<void>;
  /** Snapshot of the entire agent environment. */
  toObject(): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Deno runtime (mirrors `DenoRuntime` / `DenoRepl`)
// ---------------------------------------------------------------------------

/**
 * Options shared by {@linkcode AgentDenoRuntime.eval} and
 * {@linkcode AgentDenoRuntime.openRepl}: the spawn-affecting subset of
 * upstream `DenoReplOptions` (stdio of the driver process is an agent
 * implementation detail, not caller-visible).
 */
export interface AgentDenoReplOptions {
  /** In-sandbox cwd of the runtime; confinement-resolved. */
  readonly cwd?: string;
  /** Layered over the agent env, as {@linkcode AgentSpawnSpec.env}. */
  readonly env?: Readonly<Record<string, string>>;
  /** Drop the inherited agent env, as {@linkcode AgentSpawnSpec.clearEnv}. */
  readonly clearEnv?: boolean;
  /** Surfaced to the evaluated code as `Deno.args`. */
  readonly scriptArgs?: readonly string[];
}

/**
 * Mirror of `sandbox_agent.capnp` `DenoRuntime.run`'s spec, shaped as
 * upstream `deno.run(options)`: exactly one of `entrypoint` (a file
 * in-sandbox) or inline `code` (materialized with `extension`, default
 * `"ts"`), plus `scriptArgs` (surfaced as `Deno.args`) and the spawn
 * options ({@linkcode AgentSpawnSpec} minus `command`/`args`, which the
 * agent owns: it assembles the pinned `deno run` argv itself).
 */
export type AgentDenoRunSpec =
  & (
    | {
      readonly entrypoint: string;
      /** Upstream `watch`: re-run on change; string[] = extra watched paths. */
      readonly watch?: boolean | readonly string[];
    }
    | { readonly code: string; readonly extension?: CodeExtension }
  )
  & {
    readonly scriptArgs?: readonly string[];
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly clearEnv?: boolean;
    readonly stdin?: AgentStdioMode;
    readonly stdout?: AgentStdioMode;
    readonly stderr?: AgentStdioMode;
  };

/**
 * A state-preserving REPL session; mirror of `sandbox_agent.capnp`
 * `DenoRepl`. Bindings, module state, and globals persist across
 * {@linkcode AgentDenoRepl.eval} calls on the same session.
 *
 * Result marshalling is structured-clone-ish (the wire's `EvalResult.
 * json` payload): `Map`/`Set`/`Date` are preserved; class instances
 * arrive as plain objects (prototypes do not cross); functions and
 * symbols do not survive. A value the driver cannot serialize rejects
 * with `AgentError` `SBX_AGENT_EVAL`. An error *thrown by the evaluated
 * code* rejects with an `Error` carrying the guest error's message.
 *
 * Known non-guarantee: {@linkcode AgentDenoRepl.eval} awaits the value the
 * evaluated source produces. If that source yields a promise that never
 * settles (e.g. `new Promise(() => {})`), `eval` never resolves — there is
 * no built-in per-eval timeout, since a wall-clock cap would also cut off
 * slow-but-valid evaluations. Bound such calls externally (an `AbortSignal`
 * on the enclosing operation, or `close()`, which rejects pending evals).
 */
export interface AgentDenoRepl {
  /** Evaluate `source` in the session, preserving state for later calls. */
  eval<T = unknown>(source: string): Promise<T>;
  /**
   * Call a function with structured-clone-ish `args`: `fn` is either the
   * name of a function already defined in the session or an inline
   * function expression source (upstream `repl.call` accepts both).
   */
  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T>;
  /**
   * Tear the session down (wire `DenoRepl.close`). Idempotent; pending
   * evals reject with `AgentError` `SBX_AGENT_CLOSED`.
   */
  close(): Promise<void>;
}

/**
 * Mirror of `sandbox_agent.capnp` `DenoRuntime`. The in-guest mechanism
 * (a driver wrapping `deno repl`, or a small eval server) is an
 * implementation detail — this contract and the wire schema are the
 * boundary (DESIGN.md §10).
 */
export interface AgentDenoRuntime {
  /**
   * Upstream `deno.eval<T>`: an EPHEMERAL repl — semantically
   * `openRepl(options)` → one `eval(source)` → `close()`, so no state
   * survives between `eval` calls. Marshalling and error semantics are
   * {@linkcode AgentDenoRepl.eval}'s.
   */
  eval<T = unknown>(
    source: string,
    options?: AgentDenoReplOptions,
  ): Promise<T>;
  /** Open a state-preserving session (upstream `deno.repl()`). */
  openRepl(options?: AgentDenoReplOptions): Promise<AgentDenoRepl>;
  /**
   * Upstream `deno.run`: spawn `deno run` with the agent's pinned flags
   * for `entrypoint` or materialized inline `code`; `scriptArgs`
   * surface as `Deno.args`. Returns a plain process handle here —
   * upstream `DenoProcess.fetch`/`httpReady` are the M8 SDK surface
   * over the wire `DenoProcess`/`HttpClient` plane and are not part of
   * the M3 contract.
   */
  run(spec: AgentDenoRunSpec): Promise<AgentProcess>;
}

// ---------------------------------------------------------------------------
// Aggregate (mirrors `SandboxAgent`)
// ---------------------------------------------------------------------------

/** Static identity of a running agent, for probes and diagnostics. */
export interface AgentInfo {
  /** Build identifier of the studioboxd binary (or fake) serving this. */
  readonly buildId: string;
  /** `Deno.version.deno` of the runtime hosting the agent. */
  readonly denoVersion: string;
  /** Guest CPU architecture (`Deno.build.arch`). */
  readonly arch: "x86_64" | "aarch64";
  /** Effective in-sandbox home (`/home/app` in the real guest). */
  readonly home: string;
  /** Wall-clock start, for uptime math across the plane. */
  readonly startedAtUnixMs: number;
}

/**
 * The whole agent plane; mirror of `sandbox_agent.capnp` `SandboxAgent`
 * (its `processes()/filesystem()/environment()/deno()` capability
 * getters become plain readonly properties here; `http()` — the
 * `HttpClient` egress plane behind `Sandbox.fetch` — is M8+ surface and
 * deliberately absent from the M3 contract). `AgentBootstrap`
 * negotiate/authenticate is transport-plane and stays with the wire
 * adapter.
 */
export interface AgentApi {
  readonly processes: AgentProcessSpawner;
  readonly fs: AgentFileSystem;
  readonly env: AgentEnvironment;
  readonly deno: AgentDenoRuntime;
  /** Identity/uptime probe. */
  info(): Promise<AgentInfo>;
  /**
   * Liveness echo; mirror of `SandboxAgent.ping` (`UInt64` nonce, hence
   * `bigint`). Resolves the same nonce.
   */
  ping(nonce: bigint): Promise<bigint>;
}
