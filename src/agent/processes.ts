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
 *   its {@linkcode AgentOomAnnotator} seam then (default `false`). The
 *   real cgroup v2 `memory.events` `oom_kill` reader is
 *   {@linkcode createCgroupOomAnnotator} (wired in `src/agent/main.ts`).
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

  // When the sandbox root is the filesystem root, its realpath is "/" and
  // the containment prefix is "/" itself (every absolute path is inside it)
  // — NOT "//", which would reject every path. This is the pivot_root/chroot
  // case: overlay-init roots studioboxd at the writable overlay so the guest
  // sees `/home/app` as an absolute in-sandbox path.
  const realRootPrefix = realRoot === "/" ? "/" : realRoot + "/";
  if (real !== realRoot && !real.startsWith(realRootPrefix)) {
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
   * (see {@linkcode AgentOomAnnotator}). Default: always `false`. The real
   * cgroup v2 reader is {@linkcode createCgroupOomAnnotator}, which
   * `src/agent/main.ts` wires in for the guest.
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
// cgroup v2 OOM annotation (M10)
// ---------------------------------------------------------------------------

/**
 * The subset of a cgroup v2 `memory.events` file the OOM annotator needs.
 * `oom_kill` is the cumulative count of processes in the cgroup (or its
 * descendants) killed by any OOM killer — the counter upstream collapses
 * with "exit 137" into {@linkcode AgentProcessStatus.oom}.
 */
export interface CgroupMemoryEvents {
  /** The cgroup v2 `memory.events` `oom_kill` counter (>= 0). */
  readonly oomKill: number;
}

/**
 * Injected accessor for the guest cgroup v2 filesystem so
 * {@linkcode createCgroupOomAnnotator} is unit-testable on a host with no
 * cgroupfs (macOS). The default {@linkcode denoCgroupReader} reads the
 * real files under `/proc` and `/sys/fs/cgroup`.
 */
export interface CgroupReader {
  /**
   * Resolve the absolute path of the `memory.events` file for the agent's
   * OWN cgroup. studioboxd and the children it spawns share one cgroup (the
   * guest pid 1, tini, creates no sub-cgroup), so its cgroup (read from
   * `/proc/self/cgroup`) is the one a killed child belonged to — and, unlike
   * `/proc/<pid>/cgroup`, it is
   * still readable after the child is reaped. Rejects on a non-cgroup-v2
   * host or a malformed/unreadable `/proc/self/cgroup`.
   */
  resolveSelfMemoryEventsPath(): Promise<string>;
  /**
   * Read and parse the `memory.events` file at `path`. Rejects on a
   * missing/unreadable file.
   */
  readMemoryEvents(path: string): Promise<CgroupMemoryEvents>;
}

/**
 * Map the unified-hierarchy (`0::<path>`) line of a `/proc/<pid>/cgroup`
 * body to the absolute `memory.events` path under `/sys/fs/cgroup`. cgroup
 * v2 exposes a single `0::<relpath>` entry; the root cgroup is `0::/`.
 * Throws {@linkcode AgentError} `SBX_AGENT_STATE` when no unified line is
 * present (a cgroup-v1-only / hybrid host has no `memory.events` at the v2
 * mount, so it is treated as "not cgroup v2" and fails safe upstream).
 */
export function parseSelfCgroupMemoryEventsPath(procCgroup: string): string {
  for (const line of procCgroup.split("\n")) {
    // Unified hierarchy line: hierarchy-id 0, empty controller: "0::<path>".
    if (line.startsWith("0::")) {
      const rel = line.slice(3).trim();
      const base = rel === "" || rel === "/" ? "" : rel.replace(/\/+$/, "");
      return `/sys/fs/cgroup${base}/memory.events`;
    }
  }
  throw new AgentError(
    "SBX_AGENT_STATE",
    "no cgroup v2 unified hierarchy line in /proc/self/cgroup",
  );
}

/**
 * Extract the `oom_kill` counter from a cgroup v2 `memory.events` body
 * (whitespace-separated `key value` lines). A missing/unparseable
 * `oom_kill` line yields `0` (no OOM observed) rather than throwing.
 */
export function parseMemoryEventsOomKill(body: string): number {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const sep = trimmed.search(/\s/);
    if (sep < 0) continue;
    if (trimmed.slice(0, sep) === "oom_kill") {
      const value = Number.parseInt(trimmed.slice(sep + 1).trim(), 10);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }
  }
  return 0;
}

/**
 * The default {@linkcode CgroupReader} over `Deno.readTextFile`. Reads
 * `/proc/self/cgroup` (resolved once, then cached by the annotator) and
 * the derived `memory.events` file under `/sys/fs/cgroup`. Requires read
 * access to both trees at runtime — the compiled studioboxd bakes `-A`
 * (`deno.json` `agent:compile`), so no extra permission flag is needed.
 */
export function denoCgroupReader(): CgroupReader {
  return {
    async resolveSelfMemoryEventsPath(): Promise<string> {
      const proc = await Deno.readTextFile("/proc/self/cgroup");
      return parseSelfCgroupMemoryEventsPath(proc);
    },
    async readMemoryEvents(path: string): Promise<CgroupMemoryEvents> {
      const body = await Deno.readTextFile(path);
      return { oomKill: parseMemoryEventsOomKill(body) };
    },
  };
}

/**
 * A real {@linkcode AgentOomAnnotator} backed by cgroup v2 accounting.
 *
 * Semantics (mirroring upstream's "exit 137 + cgroup `memory.events`
 * `oom_kill`" collapse): the annotator is consulted only for a
 * `code === 137` (SIGKILL — the OOM killer's signal) exit. It reads the
 * agent cgroup's `oom_kill` counter and returns `true` iff the counter
 * INCREMENTED over the last known-good reading, i.e. an OOM kill landed in
 * the cgroup during this process's lifetime. A baseline is captured at
 * construction (agent boot, pre-workload) and advanced as a high-water
 * mark, so each `oom_kill` increment is attributed to exactly one death
 * and a subsequent non-OOM `137` (e.g. an explicit SIGKILL) stays
 * `oom: false`.
 *
 * Fail-safe: a missing file, a read/parse error, or a non-cgroup-v2 host
 * yields `false` and never throws into the exit path; a `code === 137`
 * exit with no OOM evidence stays `oom: false`. Consultations are
 * serialized so concurrent child deaths cannot double-count one increment.
 *
 * NOTE: detection is only effective when studioboxd runs in a NON-root
 * cgroup (the cgroup v2 root has no `memory.events`); provisioning that
 * cgroup is a guest-init concern outside these files. When absent, the
 * reader fails safe (`oom: false`).
 */
export function createCgroupOomAnnotator(
  reader: CgroupReader = denoCgroupReader(),
): AgentOomAnnotator {
  let pathPromise: Promise<string> | null = null;
  const readOomKill = async (): Promise<number | null> => {
    try {
      pathPromise ??= reader.resolveSelfMemoryEventsPath();
      const { oomKill } = await reader.readMemoryEvents(await pathPromise);
      return Number.isFinite(oomKill) && oomKill >= 0 ? oomKill : null;
    } catch {
      // Non-cgroup-v2 host, missing file, or parse error: fail safe and let
      // a later consultation retry path resolution.
      pathPromise = null;
      return null;
    }
  };
  // Baseline at construction: on the real guest this is the pre-workload
  // count (0); tests seed it through the injected reader. Never rejects
  // (readOomKill catches), so this pending promise cannot leak.
  let baseline: Promise<number | null> = readOomKill();
  let gate: Promise<unknown> = Promise.resolve();
  return (exit): boolean | Promise<boolean> => {
    // Only a SIGKILL exit (code 137) can be an OOM kill; the spawner
    // already gates on this, but stay defensive so the annotator is total.
    if (exit.code !== 137) return false;
    const run = gate.then(async (): Promise<boolean> => {
      const before = await baseline;
      const after = await readOomKill();
      if (after === null) return false; // read failed → no OOM evidence
      const incremented = before !== null && after > before;
      // Advance the high-water mark so the same count never re-triggers.
      if (before === null || after > before) baseline = Promise.resolve(after);
      return incremented;
    });
    // Keep the serialization chain alive even if a consultation rejects
    // (it should not — the inner body is fully guarded).
    gate = run.then(() => {}, () => {});
    return run;
  };
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
