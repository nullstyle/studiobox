/**
 * `@nullstyle/studiobox/testing` — {@linkcode FakeSandboxHost}: an
 * in-process, no-VM `Sandbox` backend for testing studiobox-consuming
 * applications on any OS.
 *
 * The fake wires the carried upstream-shaped SDK façade (`src/api/` —
 * `Sandbox`, `SandboxCommandBuilder`, `KillController`, ...) directly to
 * an in-process M3 agent plane (`src/agent/` — `AgentProcesses`,
 * `AgentFs`, `AgentEnv`, `AgentDeno`) rooted at a per-sandbox temp
 * directory, and installs itself behind the `Sandbox.create`/`connect`
 * provider seam (`installSandboxProvider`).
 *
 * > **WARNING — this is a test double, NOT an isolation boundary.**
 * > Every process a fake sandbox spawns runs directly on the host **as
 * > the current user**, with the host's real filesystem underneath the
 * > per-sandbox root. Path confinement here is a correctness contract
 * > for tests, not a security barrier: `sandbox.sh` and
 * > `sandbox.spawn()` execute arbitrary host commands. Never point it
 * > at untrusted code — hostile workloads belong in the real microVM
 * > backend. (Same stance as `@nullstyle/firecracker`'s
 * > FakeFirecracker.)
 *
 * Upstream semantics honored (target `@deno/sandbox@0.13.2`):
 *
 * - `Sandbox.create()` → id grammar `sbx_loc_<20 of [0-9a-hjkmnp-z]>`;
 *   `SandboxOptions.env` is applied post-create through `env.set`.
 * - `close()` terminates the (session-semantics) sandbox, `kill()` is
 *   authoritative termination, `[Symbol.asyncDispose]` === `close()`;
 *   `closed` resolves on teardown; later calls throw
 *   {@linkcode ConnectionClosedError}.
 * - spawn stdio defaults: stdin `"null"`, stdout/stderr `"inherit"` —
 *   "inherit" is CLIENT-side: the agent pipes, and this module pumps
 *   those bytes into the host's stdout/stderr without closing them.
 * - `ChildProcess.output()` buffers with lazy text getters; a stream
 *   read failure yields `null` buffers, never a throw; signal exits
 *   report `128 + n`.
 *
 * M3 boundaries (surface that exists upstream but is later-milestone
 * here): `Sandbox.fetch`, `extendTimeout`, `exposeHttp`,
 * `fs.upload`/`fs.download`, and `DenoProcess.httpReady`/`fetch` throw
 * {@linkcode ImplementationPendingError}; Tier C surface
 * (`exposeSsh`/`exposeVscode`/`deno.deploy`/`secrets`/`volumes`/...)
 * throws `UnsupportedFeatureError` exactly as the real backend will.
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";

import {
  ChildProcess,
  type ChildProcessOutput,
  type ChildProcessStatus,
  type Signal,
} from "../src/api/process.ts";
import {
  ConnectionClosedError,
  ConnectionEstablishmentError,
  ImplementationPendingError,
  UnsupportedFeatureError,
} from "../src/api/errors.ts";
import {
  type FileInfo,
  FsFile,
  type SandboxFs,
  type SeekMode,
} from "../src/api/fs.ts";
import { downloadTree, uploadTree } from "../src/api/fs_transfer.ts";
import type {
  DenoReplOptions,
  DenoRunOptions,
  SandboxDeno,
} from "../src/api/deno.ts";
import { DenoProcess, DenoRepl } from "../src/api/deno.ts";
import type { SandboxEnv } from "../src/api/env.ts";
import {
  installSandboxProvider,
  type SandboxProvider,
} from "../src/api/provider.ts";
import {
  type ConnectOptions,
  Sandbox,
  type SandboxOptions,
  type SpawnOptions,
} from "../src/api/sandbox.ts";
import type {
  Region,
  SandboxesListOptions,
  SandboxMetadata,
} from "../src/api/types.ts";

import type {
  AgentDenoRepl,
  AgentDenoReplOptions,
  AgentDenoRunSpec,
  AgentOomAnnotator,
  AgentProcess,
  AgentRootConfig,
  AgentSpawnSpec,
  AgentStdioMode,
} from "../src/agent/api.ts";
import { AgentDeno } from "../src/agent/deno_runtime.ts";
import { AgentEnv } from "../src/agent/env.ts";
import { AgentFs } from "../src/agent/fs.ts";
import { AgentProcesses } from "../src/agent/processes.ts";

// ---------------------------------------------------------------------------
// Sandbox ids: upstream grammar with `loc` in the region slot
// ---------------------------------------------------------------------------

/** Upstream id alphabet (no `i`, `l`, `o`). */
const ID_ALPHABET = "0123456789abcdefgh" + "jk" + "mn" + "pqrstuvwxyz";
const ID_LENGTH = 20;

function generateSandboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let suffix = "";
  for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `sbx_loc_${suffix}`;
}

// ---------------------------------------------------------------------------
// Shared per-sandbox state
// ---------------------------------------------------------------------------

class SandboxState {
  closed = false;
  /** "inherit" pump completions awaited at teardown. */
  readonly pumps = new Set<Promise<void>>();
  /** Open repl sessions torn down at close. */
  readonly repls = new Set<FakeDenoRepl>();

  assertOpen(): void {
    if (this.closed) throw new ConnectionClosedError();
  }
}

function toPathString(path: string | URL): string {
  return path instanceof URL ? fromFileUrl(path) : path;
}

// ---------------------------------------------------------------------------
// Process adaptation: AgentProcess -> upstream ChildProcess semantics
// ---------------------------------------------------------------------------

type ClientStdioMode = "piped" | "inherit" | "null";

interface ClientStdio {
  readonly stdin: "piped" | "null";
  readonly stdout: ClientStdioMode;
  readonly stderr: ClientStdioMode;
}

/** Client-side stdio lowering: the agent pipes unless discarding. */
function toAgentStdio(mode: ClientStdioMode): AgentStdioMode {
  return mode === "null" ? "null" : "piped";
}

/**
 * Pump an "inherit" stream into the host's stdout/stderr WITHOUT closing
 * it (the upstream client-side inherit contract). Write errors quietly
 * end the pump.
 */
function pumpInherit(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  dest: { write(p: Uint8Array): Promise<number> },
): Promise<void> {
  return (async () => {
    for await (const chunk of stream) {
      let offset = 0;
      while (offset < chunk.length) {
        offset += await dest.write(chunk.subarray(offset));
      }
    }
  })().catch(() => {});
}

/** Upstream output(): a stream read failure yields null, never throws. */
async function readAllOrNull(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (stream === null) return null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } catch {
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
 * The shared client-side process core: owns inherit pumps, the upstream
 * status shape, stdin wrapping, and buffered output(). Both
 * {@linkcode FakeChildProcess} and {@linkcode FakeDenoProcess} delegate
 * here (they extend different abstract classes).
 */
class ProcessCore {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array<ArrayBuffer>> | null;
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly status: Promise<ChildProcessStatus>;
  readonly #process: AgentProcess;
  readonly #outStream: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly #errStream: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  #output: Promise<ChildProcessOutput> | undefined;

  constructor(
    state: SandboxState,
    process: AgentProcess,
    stdio: ClientStdio,
    signal?: AbortSignal,
  ) {
    this.#process = process;
    this.pid = process.pid;

    const pumps: Promise<void>[] = [];
    const route = (
      mode: ClientStdioMode,
      stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
      dest: { write(p: Uint8Array): Promise<number> },
    ): ReadableStream<Uint8Array<ArrayBuffer>> | null => {
      if (mode !== "inherit" || stream === null) {
        return mode === "piped" ? stream : null;
      }
      const pump = pumpInherit(stream, dest);
      pumps.push(pump);
      state.pumps.add(pump);
      pump.finally(() => state.pumps.delete(pump));
      return null;
    };
    this.stdout = route(stdio.stdout, process.stdout, Deno.stdout);
    this.stderr = route(stdio.stderr, process.stderr, Deno.stderr);
    // Buffered output() must read from the agent streams directly, so
    // remember them apart from the (inherit-nulled) public getters.
    this.#outStream = stdio.stdout === "piped" ? process.stdout : null;
    this.#errStream = stdio.stderr === "piped" ? process.stderr : null;

    this.stdin = stdio.stdin === "piped"
      ? new WritableStream<Uint8Array<ArrayBuffer>>({
        write: (chunk) => process.writeStdin(chunk),
        close: () => process.closeStdin(),
        abort: () => process.closeStdin(),
      })
      : null;

    if (signal !== undefined) {
      const onAbort = () => void process.kill("SIGTERM").catch(() => {});
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      process.status.finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    }

    this.status = (async () => {
      const exit = await process.status;
      // Inherit pumps end at child EOF; settle them so output ordering
      // and test sanitizers see a quiescent process.
      await Promise.all(pumps);
      return {
        success: exit.code === 0,
        code: exit.code,
        signal: exit.signal,
        oom: exit.oom,
      };
    })();
  }

  kill(signal?: Signal): Promise<void> {
    return this.#process.kill(signal);
  }

  output(): Promise<ChildProcessOutput> {
    this.#output ??= (async () => {
      const [stdout, stderr, status] = await Promise.all([
        readAllOrNull(this.#outStream),
        readAllOrNull(this.#errStream),
        this.status,
      ]);
      let stdoutText: string | null | undefined;
      let stderrText: string | null | undefined;
      return {
        status,
        stdout,
        stderr,
        get stdoutText(): string | null {
          stdoutText ??= stdout === null
            ? null
            : new TextDecoder().decode(stdout);
          return stdoutText;
        },
        get stderrText(): string | null {
          stderrText ??= stderr === null
            ? null
            : new TextDecoder().decode(stderr);
          return stderrText;
        },
      };
    })();
    return this.#output;
  }

  async dispose(): Promise<void> {
    await this.#process.kill("SIGKILL").catch(() => {});
    await this.status.catch(() => {});
  }
}

function spawnStdio(options: SpawnOptions | undefined): ClientStdio {
  return {
    stdin: options?.stdin ?? "null",
    stdout: options?.stdout ?? "inherit",
    stderr: options?.stderr ?? "inherit",
  };
}

function toSpawnSpec(
  command: string | URL,
  options: SpawnOptions | undefined,
  stdio: ClientStdio,
): AgentSpawnSpec {
  return {
    command: toPathString(command),
    args: options?.args,
    cwd: options?.cwd === undefined ? undefined : toPathString(options.cwd),
    env: options?.env,
    clearEnv: options?.clearEnv,
    stdin: stdio.stdin,
    stdout: toAgentStdio(stdio.stdout),
    stderr: toAgentStdio(stdio.stderr),
  };
}

class FakeChildProcess extends ChildProcess {
  readonly #core: ProcessCore;

  constructor(core: ProcessCore) {
    super();
    this.#core = core;
  }

  get pid(): number {
    return this.#core.pid;
  }
  get stdin(): WritableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#core.stdin;
  }
  get stdout(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#core.stdout;
  }
  get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#core.stderr;
  }
  get status(): Promise<ChildProcessStatus> {
    return this.#core.status;
  }
  kill(signal?: Signal): Promise<void> {
    return this.#core.kill(signal);
  }
  output(): Promise<ChildProcessOutput> {
    return this.#core.output();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.#core.dispose();
  }
}

class FakeDenoProcess extends DenoProcess {
  readonly #core: ProcessCore;

  constructor(core: ProcessCore) {
    super();
    this.#core = core;
  }

  /** `DenoProcess.httpReady` is M8 surface (wire `HttpClient` plane). */
  get httpReady(): Promise<boolean> {
    throw new ImplementationPendingError("DenoProcess.httpReady");
  }
  fetch(): Promise<Response> {
    return Promise.reject(new ImplementationPendingError("DenoProcess.fetch"));
  }

  get pid(): number {
    return this.#core.pid;
  }
  get stdin(): WritableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#core.stdin;
  }
  get stdout(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#core.stdout;
  }
  get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    return this.#core.stderr;
  }
  get status(): Promise<ChildProcessStatus> {
    return this.#core.status;
  }
  kill(signal?: Signal): Promise<void> {
    return this.#core.kill(signal);
  }
  output(): Promise<ChildProcessOutput> {
    return this.#core.output();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.#core.dispose();
  }
}

// ---------------------------------------------------------------------------
// Repl adaptation
// ---------------------------------------------------------------------------

/**
 * Upstream `DenoRepl` over an {@linkcode AgentDenoRepl} session. The M3
 * agent contract does not expose the repl's underlying process, so the
 * `ChildProcess` members (`pid`/`stdin`/`stdout`/`stderr`/`status`/
 * `output`) throw {@linkcode ImplementationPendingError} until the M8
 * SDK attaches to the wire `DenoProcess` plane; `kill()` tears the
 * session down like `close()`.
 */
class FakeDenoRepl extends DenoRepl {
  readonly #state: SandboxState;
  readonly #session: AgentDenoRepl;

  constructor(state: SandboxState, session: AgentDenoRepl) {
    super();
    this.#state = state;
    this.#session = session;
    state.repls.add(this);
  }

  eval<T = unknown>(code: string): Promise<T> {
    return this.#session.eval<T>(code);
  }

  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    return this.#session.call<T>(fn, ...args);
  }

  async close(): Promise<void> {
    this.#state.repls.delete(this);
    await this.#session.close();
  }

  get httpReady(): Promise<boolean> {
    throw new ImplementationPendingError("DenoRepl.httpReady");
  }
  fetch(): Promise<Response> {
    return Promise.reject(new ImplementationPendingError("DenoRepl.fetch"));
  }
  get pid(): number {
    throw new ImplementationPendingError("DenoRepl.pid");
  }
  get stdin(): WritableStream<Uint8Array<ArrayBuffer>> | null {
    throw new ImplementationPendingError("DenoRepl.stdin");
  }
  get stdout(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    throw new ImplementationPendingError("DenoRepl.stdout");
  }
  get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> | null {
    throw new ImplementationPendingError("DenoRepl.stderr");
  }
  get status(): Promise<ChildProcessStatus> {
    throw new ImplementationPendingError("DenoRepl.status");
  }
  kill(_signal?: Signal): Promise<void> {
    return this.close();
  }
  output(): Promise<ChildProcessOutput> {
    return Promise.reject(new ImplementationPendingError("DenoRepl.output"));
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

// ---------------------------------------------------------------------------
// fs adaptation
// ---------------------------------------------------------------------------

class FakeFsFile extends FsFile {
  readonly #file: import("../src/agent/api.ts").AgentFsFile;

  constructor(file: import("../src/agent/api.ts").AgentFsFile) {
    super();
    this.#file = file;
  }

  get readable(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.#file.readable;
  }
  get writable(): WritableStream<Uint8Array<ArrayBuffer>> {
    return this.#file.writable;
  }
  write(data: Uint8Array<ArrayBuffer>): Promise<number> {
    return this.#file.write(data);
  }
  truncate(length?: number): Promise<void> {
    return this.#file.truncate(length);
  }
  read(data: Uint8Array<ArrayBufferLike>): Promise<number | null> {
    return this.#file.read(data);
  }
  seek(offset: number | bigint, whence: SeekMode): Promise<number> {
    return this.#file.seek(offset, whence);
  }
  stat(): Promise<FileInfo> {
    return this.#file.stat();
  }
  sync(): Promise<void> {
    return this.#file.sync();
  }
  syncData(): Promise<void> {
    return this.#file.syncData();
  }
  utime(atime: number | Date, mtime: number | Date): Promise<void> {
    return this.#file.utime(atime, mtime);
  }
  lock(exclusive?: boolean): Promise<void> {
    return this.#file.lock(exclusive);
  }
  unlock(): Promise<void> {
    return this.#file.unlock();
  }
  close(): Promise<void> {
    return this.#file.close();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

class FakeSandboxFs implements SandboxFs {
  readonly #state: SandboxState;
  readonly #fs: AgentFs;

  constructor(state: SandboxState, fs: AgentFs) {
    this.#state = state;
    this.#fs = fs;
  }

  #path(path: string | URL): string {
    this.#state.assertOpen();
    return toPathString(path);
  }

  async readFile(
    path: string | URL,
    options?: Parameters<SandboxFs["readFile"]>[1],
  ): Promise<Uint8Array<ArrayBuffer>> {
    return await this.#fs.readFile(this.#path(path), options);
  }
  async writeFile(
    path: string | URL,
    data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    options?: Parameters<SandboxFs["writeFile"]>[2],
  ): Promise<void> {
    return await this.#fs.writeFile(this.#path(path), data, options);
  }
  async readTextFile(
    path: string | URL,
    options?: Parameters<SandboxFs["readTextFile"]>[1],
  ): Promise<string> {
    return await this.#fs.readTextFile(this.#path(path), options);
  }
  async writeTextFile(
    path: string | URL,
    data: string | ReadableStream<string>,
    options?: Parameters<SandboxFs["writeTextFile"]>[2],
  ): Promise<void> {
    return await this.#fs.writeTextFile(this.#path(path), data, options);
  }
  readDir(path: string | URL): AsyncIterable<
    import("../src/api/fs.ts").DirEntry
  > {
    return this.#fs.readDir(this.#path(path));
  }
  async remove(
    path: string | URL,
    options?: Parameters<SandboxFs["remove"]>[1],
  ): Promise<void> {
    return await this.#fs.remove(this.#path(path), options);
  }
  async mkdir(
    path: string | URL,
    options?: Parameters<SandboxFs["mkdir"]>[1],
  ): Promise<void> {
    return await this.#fs.mkdir(this.#path(path), options);
  }
  async rename(oldPath: string | URL, newPath: string | URL): Promise<void> {
    return await this.#fs.rename(this.#path(oldPath), this.#path(newPath));
  }
  async stat(path: string | URL): Promise<FileInfo> {
    return await this.#fs.stat(this.#path(path));
  }
  async lstat(path: string | URL): Promise<FileInfo> {
    return await this.#fs.lstat(this.#path(path));
  }
  async chmod(path: string | URL, mode: number): Promise<void> {
    return await this.#fs.chmod(this.#path(path), mode);
  }
  async chown(
    path: string | URL,
    uid: number | null,
    gid: number | null,
  ): Promise<void> {
    return await this.#fs.chown(this.#path(path), uid, gid);
  }
  async copyFile(fromPath: string | URL, toPath: string | URL): Promise<void> {
    return await this.#fs.copyFile(this.#path(fromPath), this.#path(toPath));
  }
  walk(
    path: string,
    options?: Parameters<SandboxFs["walk"]>[1],
  ): AsyncIterableIterator<import("../src/api/fs.ts").WalkEntry> {
    this.#state.assertOpen();
    return this.#fs.walk(path, options);
  }
  expandGlob(
    glob: string,
    options?: Parameters<SandboxFs["expandGlob"]>[1],
  ): AsyncIterableIterator<import("../src/api/fs.ts").WalkEntry> {
    this.#state.assertOpen();
    return this.#fs.expandGlob(glob, options);
  }
  async create(path: string | URL): Promise<FsFile> {
    return new FakeFsFile(await this.#fs.create(this.#path(path)));
  }
  async link(target: string | URL, path: string | URL): Promise<void> {
    return await this.#fs.link(this.#path(target), this.#path(path));
  }
  async makeTempDir(
    options?: Parameters<SandboxFs["makeTempDir"]>[0],
  ): Promise<string> {
    this.#state.assertOpen();
    return await this.#fs.makeTempDir(options);
  }
  async makeTempFile(
    options?: Parameters<SandboxFs["makeTempFile"]>[0],
  ): Promise<string> {
    this.#state.assertOpen();
    return await this.#fs.makeTempFile(options);
  }
  async open(
    path: string | URL,
    options?: Parameters<SandboxFs["open"]>[1],
  ): Promise<FsFile> {
    return new FakeFsFile(await this.#fs.open(this.#path(path), options));
  }
  async readLink(path: string | URL): Promise<string> {
    return await this.#fs.readLink(this.#path(path));
  }
  async realPath(path: string | URL): Promise<string> {
    return await this.#fs.realPath(this.#path(path));
  }
  async symlink(
    target: string | URL,
    path: string | URL,
    options?: Parameters<SandboxFs["symlink"]>[2],
  ): Promise<void> {
    // The symlink TARGET is stored verbatim (upstream behavior); only
    // URL targets are lowered to paths.
    //
    // Fake-host caveat: because there is no chroot (the sandbox root is a
    // host temp dir), an ABSOLUTE in-sandbox target — e.g. `/etc/passwd` —
    // is interpreted as a host-absolute path when the link is later
    // resolved, lands outside the per-sandbox root, and raises
    // `SBX_AGENT_PATH_ESCAPE`. A real guest would resolve the same target
    // against the guest's own `/`. Use RELATIVE targets for in-sandbox
    // links to keep fake and real backends in agreement.
    this.#state.assertOpen();
    return await this.#fs.symlink(
      toPathString(target),
      toPathString(path),
      options,
    );
  }
  async truncate(name: string | URL, length?: number): Promise<void> {
    return await this.#fs.truncate(this.#path(name), length);
  }
  async umask(mask?: number): Promise<number> {
    this.#state.assertOpen();
    return await this.#fs.umask(mask);
  }
  async utime(
    path: string | URL,
    atime: number | Date,
    mtime: number | Date,
  ): Promise<void> {
    return await this.#fs.utime(this.#path(path), atime, mtime);
  }
  /** Upload a host file/tree into the sandbox ({@linkcode uploadTree}). */
  upload(localPath: string | URL, sandboxPath: string | URL): Promise<void> {
    this.#state.assertOpen();
    return uploadTree(this, localPath, sandboxPath);
  }
  /** Download a sandbox file/tree out to the host ({@linkcode downloadTree}). */
  download(sandboxPath: string | URL, localPath: string | URL): Promise<void> {
    this.#state.assertOpen();
    return downloadTree(this, sandboxPath, localPath);
  }
}

// ---------------------------------------------------------------------------
// env + deno adaptation
// ---------------------------------------------------------------------------

class FakeSandboxEnv implements SandboxEnv {
  readonly #state: SandboxState;
  readonly #env: AgentEnv;

  constructor(state: SandboxState, env: AgentEnv) {
    this.#state = state;
    this.#env = env;
  }

  async get(key: string): Promise<string | undefined> {
    this.#state.assertOpen();
    return await this.#env.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.#state.assertOpen();
    return await this.#env.set(key, value);
  }
  async toObject(): Promise<Record<string, string>> {
    this.#state.assertOpen();
    return await this.#env.toObject();
  }
  async delete(key: string): Promise<void> {
    this.#state.assertOpen();
    return await this.#env.delete(key);
  }
}

function toReplOptions(
  options: DenoReplOptions | undefined,
): AgentDenoReplOptions {
  return {
    cwd: options?.cwd === undefined ? undefined : toPathString(options.cwd),
    env: options?.env,
    clearEnv: options?.clearEnv,
    scriptArgs: options?.scriptArgs,
  };
}

class FakeSandboxDeno implements SandboxDeno {
  readonly #state: SandboxState;
  readonly #deno: AgentDeno;

  constructor(state: SandboxState, deno: AgentDeno) {
    this.#state = state;
    this.#deno = deno;
  }

  async run(options: DenoRunOptions): Promise<DenoProcess> {
    this.#state.assertOpen();
    const stdio: ClientStdio = {
      stdin: options.stdin ?? "null",
      stdout: options.stdout ?? "inherit",
      stderr: options.stderr ?? "inherit",
    };
    const base = {
      scriptArgs: options.scriptArgs,
      cwd: options.cwd === undefined ? undefined : toPathString(options.cwd),
      env: options.env,
      clearEnv: options.clearEnv,
      stdin: stdio.stdin,
      stdout: toAgentStdio(stdio.stdout),
      stderr: toAgentStdio(stdio.stderr),
    };
    const spec: AgentDenoRunSpec = "entrypoint" in options
      ? {
        entrypoint: toPathString(options.entrypoint),
        watch: options.watch,
        ...base,
      }
      : { code: options.code, extension: options.extension, ...base };
    const process = await this.#deno.run(spec);
    return new FakeDenoProcess(
      new ProcessCore(this.#state, process, stdio, options.signal),
    );
  }

  async eval<T = unknown>(code: string): Promise<T> {
    this.#state.assertOpen();
    return await this.#deno.eval<T>(code);
  }

  async repl(options?: DenoReplOptions): Promise<DenoRepl> {
    this.#state.assertOpen();
    const session = await this.#deno.openRepl(toReplOptions(options));
    return new FakeDenoRepl(this.#state, session);
  }

  deploy(): Promise<import("../src/api/deno.ts").Build> {
    return Promise.reject(new UnsupportedFeatureError("deno.deploy"));
  }
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

interface FakeSandboxInternals {
  readonly id: string;
  readonly root: string;
  readonly env: AgentEnv;
  readonly processes: AgentProcesses;
  readonly fs: AgentFs;
  readonly deno: AgentDeno;
  /** Host callback fired once teardown completes. */
  readonly onTerminated: (id: string) => void;
}

class FakeSandbox extends Sandbox {
  readonly #internals: FakeSandboxInternals;
  readonly #state = new SandboxState();
  readonly #fs: FakeSandboxFs;
  readonly #deno: FakeSandboxDeno;
  readonly #env: FakeSandboxEnv;
  readonly #closed: Promise<void>;
  #resolveClosed!: () => void;
  #teardown: Promise<void> | undefined;
  /** Next fake exposeHttp host port (reserved forward range, DESIGN §6). */
  #nextExposedPort = 40_100;

  constructor(internals: FakeSandboxInternals) {
    super();
    this.#internals = internals;
    this.#fs = new FakeSandboxFs(this.#state, internals.fs);
    this.#deno = new FakeSandboxDeno(this.#state, internals.deno);
    this.#env = new FakeSandboxEnv(this.#state, internals.env);
    this.#closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get id(): string {
    return this.#internals.id;
  }
  get closed(): Promise<void> {
    return this.#closed;
  }
  get fs(): SandboxFs {
    return this.#fs;
  }
  get deno(): SandboxDeno {
    return this.#deno;
  }
  get env(): SandboxEnv {
    return this.#env;
  }
  get ssh(): { username: string; hostname: string } | undefined {
    return undefined;
  }
  get url(): string | undefined {
    return undefined;
  }

  async spawn(
    command: string | URL,
    options?: SpawnOptions,
  ): Promise<ChildProcess> {
    this.#state.assertOpen();
    const stdio = spawnStdio(options);
    const process = await this.#internals.processes.spawn(
      toSpawnSpec(command, options, stdio),
    );
    return new FakeChildProcess(
      new ProcessCore(this.#state, process, stdio, options?.signal),
    );
  }

  /** `Sandbox.fetch` rides the M8 `HttpClient` egress plane. */
  fetch(): Promise<Response> {
    return Promise.reject(new ImplementationPendingError("Sandbox.fetch"));
  }

  /**
   * Upstream `close()` drops the connection and a session sandbox then
   * terminates; the fake is always session-shaped, so close === full
   * teardown. Idempotent.
   */
  close(): Promise<void> {
    this.#teardown ??= this.#runTeardown();
    return this.#teardown;
  }

  /** Authoritative termination — same teardown as `close()` here. */
  kill(): Promise<void> {
    return this.close();
  }

  /** Timeout leases are hostd (M6) surface. */
  extendTimeout(): Promise<Date> {
    return Promise.reject(
      new ImplementationPendingError("Sandbox.extendTimeout"),
    );
  }

  /**
   * Expose a guest TCP port and resolve a plausible loopback URL. The fake host
   * runs no real forwarder, so it leases a distinct port from the same reserved
   * 40100..40199 range the real host uses (each call gets a new one), letting
   * host-safe SDK tests exercise the `exposeHttp` -> URL contract. Only
   * `{ port }` is supported (the wire takes a guest port); `{ pid }` is not.
   */
  exposeHttp(target: { port: number } | { pid: number }): Promise<string> {
    this.#state.assertOpen();
    if (!("port" in target)) {
      return Promise.reject(
        new UnsupportedFeatureError("Sandbox.exposeHttp by pid"),
      );
    }
    const hostPort = this.#nextExposedPort++;
    return Promise.resolve(`http://127.0.0.1:${hostPort}`);
  }

  exposeSsh(): Promise<{ hostname: string; username: string }> {
    return Promise.reject(new UnsupportedFeatureError("Sandbox.exposeSsh"));
  }

  exposeVscode(): Promise<import("../src/api/sandbox.ts").VsCode> {
    return Promise.reject(new UnsupportedFeatureError("Sandbox.exposeVscode"));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #runTeardown(): Promise<void> {
    this.#state.closed = true;
    for (const repl of [...this.#state.repls]) {
      await repl.close().catch(() => {});
    }
    await this.#internals.processes.shutdown();
    await Promise.allSettled([...this.#state.pumps]);
    try {
      await Deno.remove(this.#internals.root, { recursive: true });
    } catch {
      // Best-effort: a live handle on some file must not fail teardown.
    }
    this.#internals.onTerminated(this.#internals.id);
    this.#resolveClosed();
  }
}

// ---------------------------------------------------------------------------
// The host / provider
// ---------------------------------------------------------------------------

/** Construction options for {@linkcode FakeSandboxHost}. */
export interface FakeSandboxHostOptions {
  /**
   * Extra base environment for every sandbox, layered over the defaults
   * (`PATH` from the host, `HOME` pointing at the sandbox's home).
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The oom annotation seam handed to every sandbox's spawner (see
   * `AgentOomAnnotator`); lets tests exercise `status.oom === true`
   * without cgroups. Default: always `false`.
   */
  readonly oomAnnotator?: AgentOomAnnotator;
}

interface SandboxRecord {
  readonly createdAt: Date;
  stoppedAt: Date | null;
  readonly labels: Record<string, string>;
}

/** `SandboxOptions` members that are Tier C (unsupported by design). */
const TIER_C_CREATE_OPTIONS = [
  "secrets",
  "volumes",
  "root",
  "ssh",
  "port",
] as const;

/**
 * In-process `Sandbox.create()`-compatible test host. See the module doc
 * — especially the isolation warning — before use.
 *
 * ```ts
 * import { FakeSandboxHost } from "@nullstyle/studiobox/testing";
 * import { Sandbox } from "@nullstyle/studiobox";
 *
 * await using host = FakeSandboxHost.install();
 * await using sandbox = await Sandbox.create();
 * const greeting = await sandbox.sh`echo hello`.text();
 * ```
 */
export class FakeSandboxHost implements SandboxProvider, AsyncDisposable {
  readonly #options: FakeSandboxHostOptions;
  readonly #live = new Map<string, FakeSandbox>();
  readonly #records = new Map<string, SandboxRecord>();
  #restore: (() => void) | undefined;

  constructor(options: FakeSandboxHostOptions = {}) {
    this.#options = options;
  }

  /** Construct a host and install it behind `Sandbox.create`/`connect`. */
  static install(options: FakeSandboxHostOptions = {}): FakeSandboxHost {
    const host = new FakeSandboxHost(options);
    host.install();
    return host;
  }

  /**
   * Install this host as the process-wide sandbox provider. Returns the
   * restore function (also invoked by {@linkcode FakeSandboxHost.close}).
   */
  install(): () => void {
    this.#restore ??= installSandboxProvider(this);
    return () => this.uninstall();
  }

  /** Restore the previously installed provider (idempotent). */
  uninstall(): void {
    this.#restore?.();
    this.#restore = undefined;
  }

  async create(options: SandboxOptions = {}): Promise<Sandbox> {
    for (const key of TIER_C_CREATE_OPTIONS) {
      if (options[key] !== undefined) {
        throw new UnsupportedFeatureError(`SandboxOptions.${key}`);
      }
    }
    const id = generateSandboxId();
    const root = await Deno.makeTempDir({ prefix: "sbx-fake-" });
    // Everything after the temp root exists is provisioning: any failure
    // (host-level env validation, per-create env, process setup) must tear
    // the root down so no partial sandbox is observable via list()/connect()
    // and no temp dir leaks. `sandbox` is teardown-capable once built; before
    // that, removing the root is the only cleanup needed.
    let sandbox: FakeSandbox | undefined;
    try {
      await Deno.mkdir(join(root, "home", "app"), { recursive: true });
      await Deno.mkdir(join(root, "tmp"), { recursive: true });
      const realRoot = await Deno.realPath(root);
      const config: AgentRootConfig = { root };
      // Children run on the HOST (see the isolation warning), so HOME must
      // be a host path for `$HOME`-dependent behavior (BASH_ENV sourcing)
      // to work — an M3 divergence from the in-guest `/home/app`.
      const env = new AgentEnv({
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: join(realRoot, "home", "app"),
        ...this.#options.env,
      });
      const processes = new AgentProcesses({
        config,
        env,
        oomAnnotator: this.#options.oomAnnotator,
      });
      const fs = new AgentFs(config);
      const deno = new AgentDeno({ config, spawner: processes });
      sandbox = new FakeSandbox({
        id,
        root,
        env,
        processes,
        fs,
        deno,
        onTerminated: (terminatedId) => {
          this.#live.delete(terminatedId);
          const record = this.#records.get(terminatedId);
          if (record !== undefined) record.stoppedAt = new Date();
        },
      });
      // Upstream applies SandboxOptions.env post-create through env.set;
      // do it BEFORE registering (below) so the sandbox only becomes
      // observable once fully provisioned.
      for (const [key, value] of Object.entries(options.env ?? {})) {
        await sandbox.env.set(key, value);
      }
    } catch (error) {
      // Best-effort teardown: close() shuts down processes and removes the
      // root; if we failed before the sandbox existed, remove the root.
      if (sandbox !== undefined) {
        await sandbox.close().catch(() => {});
      } else {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      }
      throw error;
    }
    this.#live.set(id, sandbox);
    this.#records.set(id, {
      createdAt: new Date(),
      stoppedAt: null,
      labels: { ...options.labels },
    });
    return sandbox;
  }

  connect(id: string, _options?: ConnectOptions): Promise<Sandbox> {
    const sandbox = this.#live.get(id);
    if (sandbox === undefined) {
      return Promise.reject(
        new ConnectionEstablishmentError(
          404,
          "sandbox_not_found",
          `No running sandbox with id ${id}`,
        ),
      );
    }
    return Promise.resolve(sandbox);
  }

  list(options?: SandboxesListOptions): Promise<SandboxMetadata[]> {
    const wanted = Object.entries(options?.labels ?? {});
    const result: SandboxMetadata[] = [];
    for (const [id, record] of this.#records) {
      if (wanted.some(([key, value]) => record.labels[key] !== value)) {
        continue;
      }
      result.push({
        id,
        createdAt: record.createdAt,
        stoppedAt: record.stoppedAt,
        // The local backend's region slot; the upstream `Region` union
        // is widened to admit "loc" in M8 (DESIGN.md §5 Tier B).
        region: "loc" as Region,
        status: this.#live.has(id) ? "running" : "stopped",
        labels: { ...record.labels },
      });
    }
    return Promise.resolve(result);
  }

  /** Close every live sandbox and uninstall the provider. */
  async close(): Promise<void> {
    for (const sandbox of [...this.#live.values()]) {
      await sandbox.close();
    }
    this.uninstall();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
