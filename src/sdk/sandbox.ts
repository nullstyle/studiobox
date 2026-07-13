/**
 * The concrete {@linkcode Sandbox} the Studiobox provider returns: the
 * carried upstream-shaped SDK façade (`src/api/`) bound to an
 * {@linkcode SandboxBackend} (the wire {@linkcode SandboxAgent} plane over
 * the tunnel) plus a {@linkcode SandboxLifecycle} (close/kill/extendTimeout
 * over the host control plane).
 *
 * The process/stdio/output semantics mirror the M3 FakeSandboxHost
 * (`testing/mod.ts`) exactly — `spawn` stdio defaults (stdin `null`,
 * stdout/stderr `inherit`), client-side `inherit` pumping into the host's
 * stdout/stderr without closing them, `output()` that buffers and never
 * throws on a stream failure, and `128 + n` signal exits — so the same
 * parity assertions hold against the real backend.
 *
 * @module
 */

import { fromFileUrl } from "@std/path";

import {
  ChildProcess,
  type ChildProcessOutput,
  type ChildProcessStatus,
  type Signal,
} from "../api/process.ts";
import {
  ConnectionClosedError,
  ImplementationPendingError,
  InvalidTimeoutError,
  UnsupportedFeatureError,
} from "../api/errors.ts";
import {
  type FileInfo,
  FsFile,
  type SandboxFs,
  type SeekMode,
} from "../api/fs.ts";
import {
  DenoProcess,
  DenoRepl,
  type DenoReplOptions,
  type DenoRunOptions,
  type SandboxDeno,
} from "../api/deno.ts";
import type { SandboxEnv } from "../api/env.ts";
import { Sandbox, type SpawnOptions, type VsCode } from "../api/sandbox.ts";

import type {
  AgentDenoRepl,
  AgentDenoReplOptions,
  AgentDenoRunSpec,
  AgentFsFile,
  AgentProcess,
  AgentSpawnSpec,
  AgentStdioMode,
} from "../agent/api.ts";
import type { SandboxBackend } from "./wire_agent.ts";

// ---------------------------------------------------------------------------
// Lifecycle seam (host control plane operations)
// ---------------------------------------------------------------------------

/** Host-plane lifecycle a provider wires under one sandbox. */
export interface SandboxLifecycle {
  readonly id: string;
  readonly url?: string;
  readonly ssh?: { username: string; hostname: string };
  /** Drop the connection (a session sandbox then dies). Idempotent. */
  teardown(): Promise<void>;
  /** Authoritative terminate over the host control plane. */
  kill(): Promise<void>;
  /** Extend the lease; resolves the new absolute deadline. */
  extendTimeout(milliseconds: number): Promise<Date>;
  /**
   * Expose a guest TCP port on the host over the host control plane; resolves
   * the loopback URL (`http://127.0.0.1:<hostPort>`). Absent when the provider
   * does not support exposeHttp.
   */
  exposeHttp?(guestPort: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Shared per-sandbox state
// ---------------------------------------------------------------------------

class SandboxState {
  closed = false;
  readonly pumps = new Set<Promise<void>>();
  readonly repls = new Set<FacadeDenoRepl>();

  assertOpen(): void {
    if (this.closed) throw new ConnectionClosedError();
  }
}

function toPathString(path: string | URL): string {
  return path instanceof URL ? fromFileUrl(path) : path;
}

// ---------------------------------------------------------------------------
// Process adaptation
// ---------------------------------------------------------------------------

type ClientStdioMode = "piped" | "inherit" | "null";

interface ClientStdio {
  readonly stdin: "piped" | "null";
  readonly stdout: ClientStdioMode;
  readonly stderr: ClientStdioMode;
}

function toAgentStdio(mode: ClientStdioMode): AgentStdioMode {
  return mode === "null" ? "null" : "piped";
}

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

class FacadeChildProcess extends ChildProcess {
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

class FacadeDenoProcess extends DenoProcess {
  readonly #core: ProcessCore;
  constructor(core: ProcessCore) {
    super();
    this.#core = core;
  }
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

class FacadeDenoRepl extends DenoRepl {
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

class FacadeFsFile extends FsFile {
  readonly #file: AgentFsFile;
  constructor(file: AgentFsFile) {
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

class FacadeSandboxFs implements SandboxFs {
  readonly #state: SandboxState;
  readonly #fs: SandboxBackend["fs"];
  constructor(state: SandboxState, fs: SandboxBackend["fs"]) {
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
  readDir(
    path: string | URL,
  ): AsyncIterable<import("../api/fs.ts").DirEntry> {
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
  ): AsyncIterableIterator<import("../api/fs.ts").WalkEntry> {
    this.#state.assertOpen();
    return this.#fs.walk(path, options);
  }
  expandGlob(
    glob: string,
    options?: Parameters<SandboxFs["expandGlob"]>[1],
  ): AsyncIterableIterator<import("../api/fs.ts").WalkEntry> {
    this.#state.assertOpen();
    return this.#fs.expandGlob(glob, options);
  }
  async create(path: string | URL): Promise<FsFile> {
    return new FacadeFsFile(await this.#fs.create(this.#path(path)));
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
    return new FacadeFsFile(await this.#fs.open(this.#path(path), options));
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
  /** SDK-side recursion over the wire primitives (M8 not-yet). */
  upload(_localPath: string | URL, _sandboxPath: string | URL): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.upload"));
  }
  download(
    _sandboxPath: string | URL,
    _localPath: string | URL,
  ): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.download"));
  }
}

// ---------------------------------------------------------------------------
// env + deno adaptation
// ---------------------------------------------------------------------------

class FacadeSandboxEnv implements SandboxEnv {
  readonly #state: SandboxState;
  readonly #env: SandboxBackend["env"];
  constructor(state: SandboxState, env: SandboxBackend["env"]) {
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

class FacadeSandboxDeno implements SandboxDeno {
  readonly #state: SandboxState;
  readonly #deno: SandboxBackend["deno"];
  constructor(state: SandboxState, deno: SandboxBackend["deno"]) {
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
    return new FacadeDenoProcess(
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
    return new FacadeDenoRepl(this.#state, session);
  }
  deploy(): Promise<import("../api/deno.ts").Build> {
    return Promise.reject(new UnsupportedFeatureError("deno.deploy"));
  }
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

/**
 * A {@linkcode Sandbox} bound to a live {@link SandboxBackend} (the agent
 * plane over the tunnel) and a {@link SandboxLifecycle} (host control).
 */
export class AgentBackedSandbox extends Sandbox {
  readonly #backend: SandboxBackend;
  readonly #lifecycle: SandboxLifecycle;
  readonly #state = new SandboxState();
  readonly #fs: FacadeSandboxFs;
  readonly #deno: FacadeSandboxDeno;
  readonly #env: FacadeSandboxEnv;
  readonly #closed: Promise<void>;
  #resolveClosed!: () => void;
  #connTeardown: Promise<void> | undefined;
  #killIssued: Promise<void> | undefined;

  constructor(backend: SandboxBackend, lifecycle: SandboxLifecycle) {
    super();
    this.#backend = backend;
    this.#lifecycle = lifecycle;
    this.#fs = new FacadeSandboxFs(this.#state, backend.fs);
    this.#deno = new FacadeSandboxDeno(this.#state, backend.deno);
    this.#env = new FacadeSandboxEnv(this.#state, backend.env);
    this.#closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get id(): string {
    return this.#lifecycle.id;
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
    return this.#lifecycle.ssh;
  }
  get url(): string | undefined {
    return this.#lifecycle.url;
  }

  async spawn(
    command: string | URL,
    options?: SpawnOptions,
  ): Promise<ChildProcess> {
    this.#state.assertOpen();
    const stdio = spawnStdio(options);
    const process = await this.#backend.processes.spawn(
      toSpawnSpec(command, options, stdio),
    );
    return new FacadeChildProcess(
      new ProcessCore(this.#state, process, stdio, options?.signal),
    );
  }

  /** `Sandbox.fetch` rides the M10 egress / `HttpClient` plane. */
  fetch(): Promise<Response> {
    return Promise.reject(new ImplementationPendingError("Sandbox.fetch"));
  }

  /** Drop the connection; a session sandbox then terminates. Idempotent. */
  close(): Promise<void> {
    return this.#teardownConnection();
  }

  /**
   * Authoritative terminate over the host control plane, then drop the
   * connection.
   *
   * The host-plane terminate is memoized SEPARATELY from the connection
   * teardown, so it runs exactly once but is never coalesced away by a prior
   * `close()`: a `kill()` after `close()` still issues the terminate rather
   * than resolving as a silent no-op. Any failure of the terminate (a host
   * `error` arm, or the control connection already being gone) propagates —
   * `kill()` never reports a success it could not confirm.
   */
  async kill(): Promise<void> {
    this.#killIssued ??= this.#lifecycle.kill();
    try {
      await this.#killIssued;
    } finally {
      await this.#teardownConnection();
    }
  }

  async extendTimeout(timeout: `${number}s` | `${number}m`): Promise<Date> {
    this.#state.assertOpen();
    return await this.#lifecycle.extendTimeout(parseDurationMs(timeout));
  }

  /**
   * Expose a guest TCP port on the host and resolve the loopback URL
   * (`http://127.0.0.1:<hostPort>`). Only `{ port }` is supported (the wire
   * `HostSandbox.exposeHttp` takes a guest port); `{ pid }` is not.
   */
  exposeHttp(target: { port: number } | { pid: number }): Promise<string> {
    this.#state.assertOpen();
    if (!("port" in target)) {
      return Promise.reject(
        new UnsupportedFeatureError("Sandbox.exposeHttp by pid"),
      );
    }
    if (this.#lifecycle.exposeHttp === undefined) {
      return Promise.reject(
        new UnsupportedFeatureError("Sandbox.exposeHttp"),
      );
    }
    return this.#lifecycle.exposeHttp(target.port);
  }
  exposeSsh(): Promise<{ hostname: string; username: string }> {
    return Promise.reject(new UnsupportedFeatureError("Sandbox.exposeSsh"));
  }
  exposeVscode(): Promise<VsCode> {
    return Promise.reject(new UnsupportedFeatureError("Sandbox.exposeVscode"));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** Drop the connection exactly once; best-effort, so it never throws. */
  #teardownConnection(): Promise<void> {
    this.#connTeardown ??= this.#doTeardownConnection();
    return this.#connTeardown;
  }

  async #doTeardownConnection(): Promise<void> {
    this.#state.closed = true;
    for (const repl of [...this.#state.repls]) {
      await repl.close().catch(() => {});
    }
    // Drop the connection FIRST, THEN drain the inherit-stdio pumps. An
    // `inherit` pump (the default for stdout/stderr) only ends when the
    // process's stream ends, which for a still-live process happens only when
    // the connection closes — so draining before the drop would deadlock
    // close()/kill()/`await using` on any sandbox with a running process.
    await this.#lifecycle.teardown().catch(() => {});
    await Promise.allSettled([...this.#state.pumps]);
    this.#resolveClosed();
  }
}

/** Parse the upstream `${n}s` / `${n}m` timeout grammar to milliseconds. */
export function parseDurationMs(timeout: `${number}s` | `${number}m`): number {
  const match = /^(\d+(?:\.\d+)?)(s|m)$/.exec(timeout);
  if (match === null) {
    throw new InvalidTimeoutError(`Invalid timeout format: ${timeout}`);
  }
  const value = Number(match[1]);
  return match[2] === "m" ? value * 60_000 : value * 1000;
}
