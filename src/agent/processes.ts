/**
 * `AgentProcessSpawner` implementation over `Deno.Command` (Track A of
 * the M3 agent plane), plus the sandbox-root path resolution helpers the
 * whole agent shares and the upstream-shaped {@linkcode collectOutput}
 * buffering helper.
 *
 * Semantics mirrored here (target `@deno/sandbox@0.13.2`, see
 * `src/agent/api.ts`):
 *
 * - The agent always produces PIPED streams; a stdio request only
 *   controls the `"null"` discard (upstream's `"inherit"` is client-side
 *   piping and never reaches the agent).
 * - Signal-caused exits report the shell convention `code = 128 + n`
 *   (SIGTERM 143, SIGKILL 137, ... — `Deno.Command` already reports this
 *   on POSIX, verified for the pinned floor).
 * - `oom` is only meaningful with exit code 137: the spawner consults
 *   its {@linkcode AgentOomAnnotator} seam then (default `false`); real
 *   cgroup `memory.events` detection is M10.
 * - Spawn environments are `agent env (AgentEnv) ⊕ per-spawn env`, with
 *   `clearEnv` dropping the agent layer. The HOST process environment
 *   never leaks: children are always spawned with `clearEnv: true` at
 *   the `Deno.Command` level and given exactly the layered map.
 * - `cwd` resolves under the sandbox root per the confinement contract
 *   in `src/agent/api.ts` (module doc, rules 1–5).
 *
 * @module
 */

import {
  AgentError,
  type AgentKillSignal,
  type AgentOomAnnotator,
  type AgentProcess,
  type AgentProcessSpawner,
  type AgentProcessStatus,
  type AgentRootConfig,
  type AgentSpawnSpec,
  type AgentStdioMode,
} from "./api.ts";
import { layerSpawnEnv, validateEnvName, validateEnvValue } from "./env.ts";

// ---------------------------------------------------------------------------
// Sandbox-root path resolution (confinement contract rules 1–4)
// ---------------------------------------------------------------------------

/** A path resolved per the sandbox-root confinement contract. */
export interface ResolvedSandboxPath {
  /** Normalized absolute in-sandbox path (rules 1–2). */
  readonly sandboxPath: string;
  /** Lexical host mapping under the root (rule 3), pre-symlink. */
  readonly hostPath: string;
  /**
   * Symlink-resolved host path, containment-verified (rule 4). Trailing
   * segments that do not exist yet are appended lexically to the
   * resolved deepest existing ancestor.
   */
  readonly realHostPath: string;
}

function assertAbsolute(path: string, what: string): void {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `${what} must be an absolute path: ${JSON.stringify(path)}`,
    );
  }
}

/** Effective in-sandbox home directory of `config` (default `/home/app`). */
export function sandboxHome(config: AgentRootConfig): string {
  const home = config.home ?? "/home/app";
  assertAbsolute(home, "sandbox home");
  return home;
}

/** Effective default in-sandbox cwd of `config` (default: the home). */
export function sandboxCwd(config: AgentRootConfig): string {
  const cwd = config.cwd ?? sandboxHome(config);
  assertAbsolute(cwd, "sandbox cwd");
  return cwd;
}

/**
 * Rules 1–2 of the confinement contract: resolve `path` to a normalized
 * absolute IN-SANDBOX path. Relative paths resolve against the effective
 * in-sandbox cwd; `.`/`..` fold lexically and `..` clamps at the sandbox
 * root (`/.. == /`). Throws `SBX_AGENT_VALIDATION` on malformed input.
 */
export function normalizeSandboxPath(
  config: AgentRootConfig,
  path: string,
): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `path must be a non-empty string: ${JSON.stringify(path)}`,
    );
  }
  if (path.includes("\0")) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "path must not contain NUL",
    );
  }
  const absolute = path.startsWith("/")
    ? path
    : `${sandboxCwd(config)}/${path}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop(); // ".." at the root clamps (POSIX "/.." === "/")
      continue;
    }
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

/**
 * Rules 3–4: map a normalized in-sandbox path onto the host and verify
 * post-symlink containment. The deepest existing ancestor is resolved
 * via realpath; a resolution landing outside the root throws
 * {@linkcode AgentError} `SBX_AGENT_PATH_ESCAPE` (never a re-clamp).
 * With `root: "/"` (the real guest) the check is vacuous by design.
 */
export async function resolveSandboxPath(
  config: AgentRootConfig,
  path: string,
): Promise<ResolvedSandboxPath> {
  assertAbsolute(config.root, "sandbox root");
  const sandboxPath = normalizeSandboxPath(config, path);
  const rootTrimmed = config.root === "/"
    ? ""
    : config.root.replace(/\/+$/, "");
  const hostPath = sandboxPath === "/"
    ? (rootTrimmed || "/")
    : rootTrimmed + sandboxPath;

  const realRoot = await Deno.realPath(rootTrimmed || "/");

  // Resolve the deepest existing ancestor; the remaining (not yet
  // existing) segments cannot contain symlinks and rejoin lexically.
  let existing = hostPath;
  const missing: string[] = [];
  let real: string;
  for (;;) {
    try {
      real = await Deno.realPath(existing);
      break;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
      if (existing === "/" || existing === (rootTrimmed || "/")) {
        // The root itself resolved above, so this is unreachable unless
        // the root races deletion; treat as the root then.
        real = realRoot;
        break;
      }
      const slash = existing.lastIndexOf("/");
      missing.unshift(existing.slice(slash + 1));
      existing = slash === 0 ? "/" : existing.slice(0, slash);
    }
  }

  if (real !== realRoot && !real.startsWith(realRoot + "/")) {
    throw new AgentError(
      "SBX_AGENT_PATH_ESCAPE",
      `path resolves outside the sandbox root: ${sandboxPath}`,
    );
  }
  const realHostPath = missing.length === 0
    ? real
    : (real === "/" ? "" : real) + "/" + missing.join("/");
  return { sandboxPath, hostPath, realHostPath };
}

// ---------------------------------------------------------------------------
// Spawn spec validation
// ---------------------------------------------------------------------------

const STDIO_MODES: readonly AgentStdioMode[] = ["piped", "null"];

function validateStdio(
  value: AgentStdioMode | undefined,
  stream: string,
): void {
  if (value !== undefined && !STDIO_MODES.includes(value)) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `spawn ${stream} must be "piped" or "null": ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Structural validation of an {@linkcode AgentSpawnSpec}; throws
 * {@linkcode AgentError} `SBX_AGENT_VALIDATION` before any process is
 * spawned. OS-level failures (missing command, missing cwd, ...) are
 * NOT checked here — they surface from the spawn itself, unchanged.
 */
export function validateSpawnSpec(spec: AgentSpawnSpec): void {
  if (typeof spec !== "object" || spec === null) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "spawn spec must be an object",
    );
  }
  if (typeof spec.command !== "string" || spec.command.length === 0) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "spawn command must be a non-empty string",
    );
  }
  if (spec.args !== undefined) {
    if (!Array.isArray(spec.args)) {
      throw new AgentError(
        "SBX_AGENT_VALIDATION",
        "spawn args must be an array of strings",
      );
    }
    for (const arg of spec.args) {
      if (typeof arg !== "string") {
        throw new AgentError(
          "SBX_AGENT_VALIDATION",
          `spawn args must all be strings: ${JSON.stringify(arg)}`,
        );
      }
    }
  }
  if (spec.cwd !== undefined && typeof spec.cwd !== "string") {
    throw new AgentError("SBX_AGENT_VALIDATION", "spawn cwd must be a string");
  }
  if (spec.env !== undefined) {
    if (typeof spec.env !== "object" || spec.env === null) {
      throw new AgentError(
        "SBX_AGENT_VALIDATION",
        "spawn env must be a record of strings",
      );
    }
    for (const [name, value] of Object.entries(spec.env)) {
      validateEnvName(name);
      validateEnvValue(value);
    }
  }
  if (spec.clearEnv !== undefined && typeof spec.clearEnv !== "boolean") {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "spawn clearEnv must be a boolean",
    );
  }
  validateStdio(spec.stdin, "stdin");
  validateStdio(spec.stdout, "stdout");
  validateStdio(spec.stderr, "stderr");
}

// ---------------------------------------------------------------------------
// The process handle
// ---------------------------------------------------------------------------

interface EffectiveStdio {
  readonly stdin: AgentStdioMode;
  readonly stdout: AgentStdioMode;
  readonly stderr: AgentStdioMode;
}

class AgentChildProcess implements AgentProcess {
  readonly #child: Deno.ChildProcess;
  readonly #stdinMode: AgentStdioMode;
  #stdinWriter: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> | null =
    null;
  #stdinClosed = false;
  #exited = false;

  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly status: Promise<AgentProcessStatus>;

  constructor(
    child: Deno.ChildProcess,
    stdio: EffectiveStdio,
    annotate: AgentOomAnnotator,
  ) {
    this.#child = child;
    this.#stdinMode = stdio.stdin;
    this.pid = child.pid;
    this.stdout = stdio.stdout === "piped" ? child.stdout : null;
    this.stderr = stdio.stderr === "piped" ? child.stderr : null;
    this.status = child.status.then(async (st) => {
      this.#exited = true;
      // Free the stdin pipe once the child is gone; late writers get
      // SBX_AGENT_CLOSED via the #exited flag.
      this.#quietCloseStdin();
      const signal = (st.signal ?? null) as AgentKillSignal | null;
      const oom = st.code === 137 &&
        (await annotate({ pid: child.pid, code: st.code, signal })) === true;
      return { code: st.code, signal, signaled: signal !== null, oom };
    });
  }

  kill(signal: AgentKillSignal = "SIGTERM"): Promise<void> {
    if (this.#exited) return Promise.resolve();
    try {
      this.#child.kill(signal as Deno.Signal);
    } catch (err) {
      // Deno throws TypeError ("Child process has already terminated")
      // when the exit raced us — signaling an exited process is a no-op
      // per the contract.
      if (!(err instanceof TypeError)) return Promise.reject(err);
    }
    return Promise.resolve();
  }

  async writeStdin(data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.#stdinMode === "null") {
      throw new AgentError(
        "SBX_AGENT_STATE",
        'cannot write stdin: the spawn requested stdin "null"',
      );
    }
    if (this.#stdinClosed) {
      throw new AgentError("SBX_AGENT_CLOSED", "stdin has been closed");
    }
    if (this.#exited) {
      throw new AgentError("SBX_AGENT_CLOSED", "the process has exited");
    }
    try {
      await this.#writer().write(data);
    } catch (err) {
      throw new AgentError(
        "SBX_AGENT_CLOSED",
        "the stdin pipe is closed",
        err,
      );
    }
  }

  async closeStdin(): Promise<void> {
    if (this.#stdinMode === "null" || this.#stdinClosed) return;
    this.#stdinClosed = true;
    try {
      await this.#writer().close();
    } catch {
      // Child already exited / pipe already broken — closeStdin is a
      // no-op then, per the contract.
    }
  }

  /**
   * Internal (registry) cleanup: close stdin and cancel any UNCONSUMED
   * piped streams. Streams a reader currently holds locked are left
   * alone. Does not kill the process.
   */
  releaseResources(): void {
    this.#quietCloseStdin();
    for (const stream of [this.stdout, this.stderr]) {
      if (stream !== null && !stream.locked) {
        stream.cancel().catch(() => {});
      }
    }
  }

  #writer(): WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>> {
    this.#stdinWriter ??= this.#child.stdin.getWriter();
    return this.#stdinWriter;
  }

  #quietCloseStdin(): void {
    if (this.#stdinMode === "null" || this.#stdinClosed) return;
    this.#stdinClosed = true;
    try {
      this.#writer().close().catch(() => {});
    } catch {
      // stdin already errored or detached.
    }
  }
}

// ---------------------------------------------------------------------------
// The spawner + concurrent process registry
// ---------------------------------------------------------------------------

/** Base-environment source the spawner layers under per-spawn env. */
export interface EnvSnapshotSource {
  snapshot(): Record<string, string>;
}

/** Construction options for {@linkcode AgentProcesses}. */
export interface AgentProcessesOptions {
  /** Sandbox root/home/cwd; see the confinement contract in `api.ts`. */
  readonly config: AgentRootConfig;
  /**
   * The agent environment store (usually an `AgentEnv`); every spawn
   * inherits its snapshot as the base layer. Default: an empty base.
   */
  readonly env?: EnvSnapshotSource;
  /**
   * The oom annotation seam, consulted once per exit with `code === 137`
   * (see {@linkcode AgentOomAnnotator}). Default: always `false`; real
   * cgroup detection replaces this in M10.
   */
  readonly oomAnnotator?: AgentOomAnnotator;
}

/**
 * `Deno.Command`-backed {@linkcode AgentProcessSpawner} with a
 * concurrent process registry.
 *
 * Registry semantics (the domain side of wire `Process.release`):
 * spawned processes are registered until they exit (automatic removal)
 * or are explicitly {@linkcode AgentProcesses.release}d. Release drops
 * the registry entry and relinquishes unconsumed stdio resources but
 * does NOT kill — capability drop and termination are distinct
 * operations, exactly as on the wire. {@linkcode AgentProcesses.shutdown}
 * is the agent-teardown path: SIGKILL everything still live and await
 * the exits.
 */
export class AgentProcesses implements AgentProcessSpawner {
  readonly #config: AgentRootConfig;
  readonly #env: EnvSnapshotSource;
  readonly #annotate: AgentOomAnnotator;
  readonly #live = new Set<AgentChildProcess>();

  constructor(options: AgentProcessesOptions) {
    this.#config = options.config;
    this.#env = options.env ?? { snapshot: () => ({}) };
    this.#annotate = options.oomAnnotator ?? (() => false);
  }

  async spawn(spec: AgentSpawnSpec): Promise<AgentProcess> {
    validateSpawnSpec(spec);
    const resolvedCwd = await resolveSandboxPath(
      this.#config,
      spec.cwd ?? sandboxCwd(this.#config),
    );
    const env = layerSpawnEnv(this.#env.snapshot(), spec);
    const stdio: EffectiveStdio = {
      stdin: spec.stdin ?? "null",
      stdout: spec.stdout ?? "piped",
      stderr: spec.stderr ?? "piped",
    };
    // clearEnv at the Deno.Command level is unconditional: the agent's
    // environment store is the WHOLE base environment; the host process
    // env never leaks into sandboxed children.
    const child = new Deno.Command(spec.command, {
      args: [...(spec.args ?? [])],
      cwd: resolvedCwd.realHostPath,
      env,
      clearEnv: true,
      stdin: stdio.stdin,
      stdout: stdio.stdout,
      stderr: stdio.stderr,
    }).spawn();
    const process = new AgentChildProcess(child, stdio, this.#annotate);
    this.#live.add(process);
    const unregister = () => {
      this.#live.delete(process);
    };
    process.status.then(unregister, unregister);
    return process;
  }

  /** Snapshot of the currently registered (not-yet-released, live) processes. */
  get live(): readonly AgentProcess[] {
    return [...this.#live];
  }

  /**
   * Drop `process` from the registry (wire `Process.release` semantics):
   * closes its stdin and cancels unconsumed stdout/stderr, but does NOT
   * kill it — the caller's handle stays usable. Returns whether the
   * process was registered. Releasing an unknown or already-released
   * process is a no-op.
   */
  release(process: AgentProcess): boolean {
    if (!(process instanceof AgentChildProcess)) return false;
    const found = this.#live.delete(process);
    if (found) process.releaseResources();
    return found;
  }

  /**
   * Agent teardown: SIGKILL every registered process, await the exits,
   * and release their resources. Idempotent.
   */
  async shutdown(): Promise<void> {
    const procs = [...this.#live];
    this.#live.clear();
    await Promise.all(procs.map(async (process) => {
      try {
        await process.kill("SIGKILL");
      } catch {
        // Exit races are fine; anything else is moot during teardown.
      }
      try {
        await process.status;
      } catch {
        // Annotator failures do not block teardown.
      }
      process.releaseResources();
    }));
  }
}

// ---------------------------------------------------------------------------
// Upstream ChildProcess.output() buffering semantics
// ---------------------------------------------------------------------------

/**
 * Buffered output of one process, shaped like upstream
 * `ChildProcess.output()`: byte buffers plus LAZY text getters (the
 * UTF-8 decode happens on first access and is cached). A `null` buffer
 * means the stream was not piped (`"null"` stdio) or its read failed —
 * upstream yields `null` for read failures, it never throws.
 */
export interface AgentProcessOutput {
  readonly status: AgentProcessStatus;
  readonly stdout: Uint8Array<ArrayBuffer> | null;
  readonly stderr: Uint8Array<ArrayBuffer> | null;
  readonly stdoutText: string | null;
  readonly stderrText: string | null;
}

async function readAll(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (stream === null) return null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } catch {
    // Upstream contract: a stream read failure yields null, never throws.
    return null;
  }
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Drain `process` to completion and buffer its output with upstream
 * `ChildProcess.output()` semantics (see {@linkcode AgentProcessOutput}).
 * Consumes the process's stdout/stderr streams.
 */
export async function collectOutput(
  process: AgentProcess,
): Promise<AgentProcessOutput> {
  const [stdout, stderr, status] = await Promise.all([
    readAll(process.stdout),
    readAll(process.stderr),
    process.status,
  ]);
  let stdoutText: string | null | undefined;
  let stderrText: string | null | undefined;
  return {
    status,
    stdout,
    stderr,
    get stdoutText(): string | null {
      if (stdoutText === undefined) {
        stdoutText = stdout === null ? null : new TextDecoder().decode(stdout);
      }
      return stdoutText;
    },
    get stderrText(): string | null {
      if (stderrText === undefined) {
        stderrText = stderr === null ? null : new TextDecoder().decode(stderr);
      }
      return stderrText;
    },
  };
}
