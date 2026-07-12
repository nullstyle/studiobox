/**
 * Client-side wire adapters that present the `sandbox_agent.capnp`
 * `SandboxAgent` plane (over the tunnel) as the transport-free
 * {@linkcode AgentApi} sub-interfaces the {@linkcode AgentBackedSandbox}
 * facade consumes. This is the CLIENT counterpart to the agent's server
 * adapter (`src/agent/service.ts`) — each domain method encodes its request,
 * calls the same-named wire method, and decodes the result / `SbxError`
 * union (mapped via `wire_errors.ts`).
 *
 * ## Wire-plane bounds (M8; NO schema change ⇒ no M1 codegen drift)
 *
 * The `sandbox_agent.capnp` plane is a deliberate SUBSET of the upstream
 * `fs.*` / process surface. What the wire does not carry surfaces as a typed
 * {@linkcode ImplementationPendingError} ("not wired yet"), never a silent
 * wrong answer:
 *
 * - **`Process.pid`** — the wire `Process` exposes no pid; a wire-backed
 *   process reports `pid === -1`. (An M8+ `sandbox_agent.capnp` `pid` field.)
 * - **`FileSystem` extras** — the wire exposes only `stat / list / makeDir /
 *   remove / rename / open / beginUpload / beginDownload`. `copyFile`,
 *   `makeTempDir`, `makeTempFile`, `walk`, `expandGlob` are COMPOSED here over
 *   that core (SDK-side, as the parity suite designates). `lstat`, `chmod`,
 *   `chown`, `link`, `symlink`, `readLink`, `realPath`, `umask`, `utime` still
 *   need a `sandbox_agent.capnp` extension (they require a distinct guest
 *   syscall the core cannot express) and remain typed not-yet.
 * - **`FsFile` extras** — `utime`, `lock`, `unlock` are not-yet (`syncData`
 *   folds onto `sync`).
 *
 * Everything Tier-A that the wire DOES carry — `spawn`/stdio/stdin/kill,
 * `env.*`, `deno.eval`/`repl`/`run`, file read/write/stat/mkdir/remove/
 * rename/open/truncate — is fully wired here.
 *
 * @module
 */

import type { RpcStub, RpcWireClient } from "@nullstyle/capnp";

import type * as wire from "../wire/generated/sandbox_agent_types.ts";
import * as streams from "../wire/generated/streams_types.ts";
import type { EmptyResult, KeyValue } from "../wire/generated/common_types.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../wire/contract.ts";
import { basename, globToRegExp, join } from "@std/path";

import { Sha256 } from "../agent/sha256.ts";
import { decodeReplValue } from "../agent/deno_runtime_codec.ts";

import { ImplementationPendingError } from "../api/errors.ts";
import { SeekMode } from "../api/fs.ts";
import type {
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
import type { Signal } from "../api/process.ts";
import type {
  AgentDenoRepl,
  AgentDenoReplOptions,
  AgentDenoRunSpec,
  AgentDenoRuntime,
  AgentEnvironment,
  AgentFileSystem,
  AgentFsFile,
  AgentKillSignal,
  AgentMakeTempOptions,
  AgentProcess,
  AgentProcessSpawner,
  AgentProcessStatus,
  AgentSpawnSpec,
  AgentStdioMode,
  AgentSymlinkOptions,
} from "../agent/api.ts";
import { expectArm, normalizeThrown, throwSbxError } from "./wire_errors.ts";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Options for a call whose result carries NO fresh capability. */
function call(timeoutMs: number): { timeoutMs: number } {
  return { timeoutMs };
}

/**
 * Options for a call whose result RETAINS a capability. The agent exports
 * result caps wire-managed, so the question must finish WITHOUT eager
 * release, or the export is dropped before first use (the agent-wire-test
 * contract).
 */
function capCall(
  timeoutMs: number,
): { timeoutMs: number; finish: { releaseResultCaps: false } } {
  return { timeoutMs, finish: { releaseResultCaps: false } };
}

/**
 * Default in-sandbox home the golden image boots studioboxd with (DESIGN.md
 * §7: `--home /home/app`). `fs.expandGlob` resolves a RELATIVE glob against
 * this, mirroring `Deno.cwd()` inside the sandbox; the SDK's paths are all
 * `/home/app`-rooted, so the assumption is consistent across the surface.
 */
const DEFAULT_SANDBOX_HOME = "/home/app";

/**
 * `@std/fs`'s `walk`/`expandGlob` include-predicate, ported for the wire
 * backend (the agent implements these host-side over `@std/fs`, but the SDK
 * composes them over the wire `list`/`stat` core — the parity suite designates
 * `walk`/`expandGlob` SDK-side). `exts` is matched by suffix, `match`/`skip`
 * by regex, exactly as upstream.
 */
function includePath(
  path: string,
  exts: readonly string[] | undefined,
  match: readonly RegExp[] | undefined,
  skip: readonly RegExp[] | undefined,
): boolean {
  if (exts !== undefined && !exts.some((ext) => path.endsWith(ext))) {
    return false;
  }
  if (match !== undefined && !match.some((p) => path.match(p) !== null)) {
    return false;
  }
  if (skip !== undefined && skip.some((p) => path.match(p) !== null)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Signal / status / FileInfo translation
// ---------------------------------------------------------------------------

/** The narrowed wire kill enum. */
type WireKillSignal = wire.KillSignal;

/** Lower the full upstream {@link Signal} union onto the wire kill enum. */
function toWireSignal(signal: AgentKillSignal | undefined): WireKillSignal {
  switch (signal) {
    case "SIGKILL":
      return "sigkill";
    case "SIGINT":
      return "sigint";
    case "SIGHUP":
      return "sighup";
    default:
      // SIGTERM (upstream kill default) and any signal outside the wire enum
      // collapse to sigterm — the wire adapter's documented narrowing.
      return "sigterm";
  }
}

/** Raise the wire kill enum back to an upstream {@link Signal}. */
function fromWireSignal(signal: WireKillSignal): Signal {
  switch (signal) {
    case "sigkill":
      return "SIGKILL";
    case "sigint":
      return "SIGINT";
    case "sighup":
      return "SIGHUP";
    default:
      return "SIGTERM";
  }
}

function toAgentStatus(status: wire.ProcessStatus): AgentProcessStatus {
  return {
    code: status.code,
    signal: status.signaled ? fromWireSignal(status.signal) : null,
    signaled: status.signaled,
    oom: status.oom,
  };
}

function toFileInfo(info: wire.FileInfo): FileInfo {
  const mtime = new Date(Number(info.modifiedAtUnixMs));
  return {
    isFile: info.kind === "regular",
    isDirectory: info.kind === "directory",
    isSymlink: info.kind === "symlink",
    size: Number(info.size),
    mtime,
    atime: mtime,
    birthtime: mtime,
    ctime: mtime,
    dev: 0,
    ino: 0,
    mode: info.mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(Number(info.size) / 512),
    isBlockDevice: false,
    isCharDevice: false,
    isFifo: false,
    isSocket: false,
  };
}

function toDirEntry(info: wire.FileInfo): DirEntry {
  const name = info.path.slice(info.path.lastIndexOf("/") + 1);
  return {
    name,
    isFile: info.kind === "regular",
    isDirectory: info.kind === "directory",
    isSymlink: info.kind === "symlink",
  };
}

function toKeyValues(
  env: Readonly<Record<string, string>> | undefined,
): KeyValue[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));
}

// ---------------------------------------------------------------------------
// Output channel sink: agent PUSH chunks -> client PULL ReadableStreams
// ---------------------------------------------------------------------------

interface ChannelState {
  controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | null;
  readonly stream: ReadableStream<Uint8Array<ArrayBuffer>>;
  nextSequence: bigint;
  hash: Sha256;
  totalBytes: bigint;
  chunkCount: bigint;
  closed: boolean;
}

/**
 * A client-hosted {@link streams.OutputSinkService}: the agent pushes a
 * spawned process's stdout/stderr into it; we re-expose each channel as a
 * pull `ReadableStream` for the facade's process core. `finish` closes the
 * stream and returns the verifying receipt (mirrors the agent-wire-test
 * sink); `fail` errors it.
 */
class OutputChannels implements streams.OutputSinkService {
  readonly #channels = new Map<streams.OutputChannel, ChannelState>();

  #channel(name: streams.OutputChannel): ChannelState {
    let state = this.#channels.get(name);
    if (state === undefined) {
      let controller:
        | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
        | null = null;
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start: (ctrl) => {
          controller = ctrl;
        },
      });
      state = {
        controller,
        stream,
        nextSequence: 0n,
        hash: new Sha256(),
        totalBytes: 0n,
        chunkCount: 0n,
        closed: false,
      };
      // `start` runs synchronously above, so the controller is set now.
      state.controller = controller;
      this.#channels.set(name, state);
    }
    return state;
  }

  /** The pull stream for `name`; lazily created on first access. */
  stream(name: streams.OutputChannel): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.#channel(name).stream;
  }

  chunk(params: streams.ChunkParams2): void {
    const state = this.#channel(params.channel);
    const data = params.data.slice();
    state.hash.update(data);
    state.totalBytes += BigInt(data.byteLength);
    state.chunkCount += 1n;
    state.nextSequence += 1n;
    if (!state.closed) state.controller?.enqueue(data);
  }

  finish(params: streams.FinishParams2): streams.FinishResult {
    const state = this.#channel(params.channel);
    if (!state.closed) {
      state.closed = true;
      state.controller?.close();
    }
    return {
      which: "receipt",
      receipt: {
        totalBytes: state.totalBytes,
        chunkCount: state.chunkCount,
        sha256: state.hash.digest(),
      },
    };
  }

  fail(params: streams.FailParams): EmptyResult {
    const state = this.#channel(params.channel);
    if (!state.closed) {
      state.closed = true;
      state.controller?.error(
        new Error(`${params.channel} stream failed: ${params.error.message}`),
      );
    }
    return { which: "ok", ok: {} };
  }
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

class WireAgentProcess implements AgentProcess {
  /** The wire plane carries no pid (M8+ schema field). */
  readonly pid = -1;
  readonly stdout: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly stderr: ReadableStream<Uint8Array<ArrayBuffer>> | null;
  readonly status: Promise<AgentProcessStatus>;

  readonly #process: RpcStub<wire.Process>;
  readonly #timeoutMs: number;
  #stdinSequence = 0n;
  #stdinHash = new Sha256();
  #stdinBytes = 0n;
  #stdinChunks = 0n;
  #stdinClosed = false;
  readonly #stdinPiped: boolean;

  constructor(
    process: RpcStub<wire.Process>,
    channels: OutputChannels | null,
    stdio: {
      stdout: AgentStdioMode;
      stderr: AgentStdioMode;
      stdin: AgentStdioMode;
    },
    timeoutMs: number,
  ) {
    this.#process = process;
    this.#timeoutMs = timeoutMs;
    this.#stdinPiped = stdio.stdin === "piped";
    this.stdout = stdio.stdout === "piped" && channels !== null
      ? channels.stream("stdout")
      : null;
    this.stderr = stdio.stderr === "piped" && channels !== null
      ? channels.stream("stderr")
      : null;
    this.status = this.#awaitExit();
    // The exit promise starts eagerly. If the sandbox connection drops while a
    // child is still live (e.g. `kill()` tears the tunnel down out from under a
    // pending `wait`), `#awaitExit` rejects; register a benign handler so that
    // rejection can never escape as an unhandled rejection that crashes the
    // runtime. A caller awaiting `status` still observes the rejection.
    this.status.catch(() => {});
  }

  async #awaitExit(): Promise<AgentProcessStatus> {
    try {
      const result = expectArm(
        await this.#process.wait(call(this.#timeoutMs)),
        "status",
      );
      const status = result.status!;
      const mapped = toAgentStatus(status);
      // Release the server-side handle + client stub; a live sandbox that
      // spawns many short processes must not accrete process caps.
      await this.#process.release(call(this.#timeoutMs)).catch(() => {});
      await this.#process.close().catch(() => {});
      return mapped;
    } catch (error) {
      throw normalizeThrown(error);
    }
  }

  async kill(signal?: AgentKillSignal): Promise<void> {
    try {
      const result = await this.#process.signal(
        toWireSignal(signal),
        call(this.#timeoutMs),
      );
      if (result.which === "error" && result.error !== undefined) {
        // Signalling an already-exited process is a no-op upstream; the agent
        // may report failedPrecondition — swallow that, surface the rest.
        if (result.error.code !== "failedPrecondition") {
          throwSbxError(result.error);
        }
      }
    } catch (error) {
      // A process that already exited (stub closed) is a no-op kill.
      const normalized = normalizeThrown(error);
      if (
        normalized instanceof Error &&
        normalized.name === "ConnectionClosedError"
      ) {
        return;
      }
      throw normalized;
    }
  }

  async writeStdin(data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.#stdinPiped || this.#stdinClosed) return;
    const sequence = this.#stdinSequence;
    this.#stdinSequence += 1n;
    this.#stdinHash.update(data);
    this.#stdinBytes += BigInt(data.byteLength);
    this.#stdinChunks += 1n;
    try {
      await this.#process.writeStdin({ sequence, data }, call(this.#timeoutMs));
    } catch (error) {
      throw normalizeThrown(error);
    }
  }

  async closeStdin(): Promise<void> {
    if (!this.#stdinPiped || this.#stdinClosed) return;
    this.#stdinClosed = true;
    try {
      const result = await this.#process.closeStdin({
        totalBytes: this.#stdinBytes,
        chunkCount: this.#stdinChunks,
        sha256: this.#stdinHash.digest(),
      }, call(this.#timeoutMs));
      if (result.which === "error" && result.error !== undefined) {
        throwSbxError(result.error);
      }
    } catch (error) {
      const normalized = normalizeThrown(error);
      if (
        normalized instanceof Error &&
        normalized.name === "ConnectionClosedError"
      ) {
        return;
      }
      throw normalized;
    }
  }
}

function toWireSpec(spec: AgentSpawnSpec): wire.SpawnSpec {
  return {
    command: spec.command,
    args: [...(spec.args ?? [])],
    cwd: spec.cwd ?? "",
    env: toKeyValues(spec.env),
    stdin: spec.stdin === "piped" ? "piped" : "discard",
    stdout: spec.stdout === "null" ? "discard" : "piped",
    stderr: spec.stderr === "null" ? "discard" : "piped",
  };
}

/** Build the output sink for a spawn, or `null` when both channels discard. */
function makeOutputSink(
  wireClient: RpcWireClient,
  stdout: AgentStdioMode,
  stderr: AgentStdioMode,
): { channels: OutputChannels; sink: RpcStub<streams.OutputSink> } | null {
  if (stdout === "null" && stderr === "null") return null;
  const channels = new OutputChannels();
  // referenceCount 2 pins the export past the WASM relay's post-call release
  // (the agent retains the sink to pump after spawn returns).
  const sink = streams.OutputSink.registerServer(wireClient, channels, {
    referenceCount: 2,
  }) as unknown as RpcStub<streams.OutputSink>;
  return { channels, sink };
}

class WireAgentProcesses implements AgentProcessSpawner {
  constructor(
    private readonly spawner: RpcStub<wire.ProcessSpawner>,
    private readonly wireClient: RpcWireClient,
    private readonly timeoutMs: number,
  ) {}

  async spawn(spec: AgentSpawnSpec): Promise<AgentProcess> {
    const stdout = spec.stdout ?? "piped";
    const stderr = spec.stderr ?? "piped";
    const stdin = spec.stdin ?? "null";
    const output = makeOutputSink(this.wireClient, stdout, stderr);
    try {
      const result = expectArm(
        await this.spawner.spawn({
          spec: toWireSpec({ ...spec, stdout, stderr, stdin }),
          output: output?.sink ?? null,
        }, capCall(this.timeoutMs)),
        "process",
      );
      return new WireAgentProcess(
        result.process!,
        output?.channels ?? null,
        { stdout, stderr, stdin },
        this.timeoutMs,
      );
    } catch (error) {
      throw normalizeThrown(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

class WireAgentEnv implements AgentEnvironment {
  constructor(
    private readonly env: RpcStub<wire.Environment>,
    private readonly timeoutMs: number,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const result = await this.env.get(key, call(this.timeoutMs));
    if (result.which === "value") return result.value;
    if (result.which === "missing") return undefined;
    if (result.error !== undefined) throwSbxError(result.error);
    return undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const result = await this.env.set({ key, value }, call(this.timeoutMs));
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  async delete(key: string): Promise<void> {
    const result = await this.env.delete(key, call(this.timeoutMs));
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  async toObject(): Promise<Record<string, string>> {
    const result = await this.env.list(call(this.timeoutMs));
    const arm = expectArm(result, "values");
    const out: Record<string, string> = {};
    for (const entry of arm.values ?? []) out[entry.key] = entry.value;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

class WireAgentFsFile implements AgentFsFile {
  #cursor = 0n;
  #writeSequence = 0n;
  #closed = false;
  readonly #file: RpcStub<wire.RemoteFile>;
  readonly #timeoutMs: number;

  constructor(file: RpcStub<wire.RemoteFile>, timeoutMs: number) {
    this.#file = file;
    this.#timeoutMs = timeoutMs;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Deno.errors.BadResource("file handle is closed");
    }
  }

  get readable(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        const buffer = new Uint8Array(64 * 1024);
        const count = await this.read(buffer);
        if (count === null) {
          controller.close();
          return;
        }
        controller.enqueue(buffer.subarray(0, count).slice());
      },
    });
  }

  get writable(): WritableStream<Uint8Array<ArrayBuffer>> {
    return new WritableStream<Uint8Array<ArrayBuffer>>({
      write: async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          offset += await this.write(chunk.subarray(offset));
        }
      },
    });
  }

  async read(data: Uint8Array<ArrayBufferLike>): Promise<number | null> {
    this.#assertOpen();
    const result = await this.#file.read(
      { offset: this.#cursor, maxBytes: data.byteLength },
      call(this.#timeoutMs),
    );
    if (result.which === "end") return null;
    if (result.which !== "chunk" || result.chunk === undefined) {
      if (result.error !== undefined) throwSbxError(result.error);
      return null;
    }
    const bytes = result.chunk.data;
    const count = Math.min(bytes.byteLength, data.byteLength);
    data.set(bytes.subarray(0, count));
    this.#cursor += BigInt(count);
    return count === 0 ? null : count;
  }

  async write(data: Uint8Array<ArrayBuffer>): Promise<number> {
    this.#assertOpen();
    const sequence = this.#writeSequence;
    this.#writeSequence += 1n;
    await this.#file.write(
      { offset: this.#cursor, sequence, data },
      call(this.#timeoutMs),
    );
    this.#cursor += BigInt(data.byteLength);
    return data.byteLength;
  }

  async seek(offset: number | bigint, whence: SeekMode): Promise<number> {
    this.#assertOpen();
    const delta = BigInt(offset);
    if (whence === SeekMode.Start) {
      this.#cursor = delta;
    } else if (whence === SeekMode.Current) {
      this.#cursor += delta;
    } else {
      // SeekMode.End: resolve size via stat.
      const size = (await this.stat()).size;
      this.#cursor = BigInt(size) + delta;
    }
    if (this.#cursor < 0n) this.#cursor = 0n;
    return Number(this.#cursor);
  }

  async truncate(length?: number): Promise<void> {
    this.#assertOpen();
    const result = await this.#file.truncate(
      BigInt(length ?? 0),
      call(this.#timeoutMs),
    );
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  async stat(): Promise<FileInfo> {
    this.#assertOpen();
    const result = await this.#file.stat(call(this.#timeoutMs));
    return toFileInfo(expectArm(result, "info").info!);
  }

  async sync(): Promise<void> {
    this.#assertOpen();
    const result = await this.#file.sync(call(this.#timeoutMs));
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  /** The wire has one fsync; `syncData` folds onto it. */
  syncData(): Promise<void> {
    return this.sync();
  }

  utime(): Promise<void> {
    return Promise.reject(new ImplementationPendingError("FsFile.utime"));
  }
  lock(): Promise<void> {
    return Promise.reject(new ImplementationPendingError("FsFile.lock"));
  }
  unlock(): Promise<void> {
    return Promise.reject(new ImplementationPendingError("FsFile.unlock"));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#file.close(call(this.#timeoutMs)).catch(() => {});
  }
}

class WireAgentFs implements AgentFileSystem {
  constructor(
    private readonly fs: RpcStub<wire.FileSystem>,
    private readonly timeoutMs: number,
  ) {}

  async readFile(
    path: string,
    _options?: ReadFileOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const result = await this.fs.beginDownload(path, capCall(this.timeoutMs));
    const reader = expectArm(result, "reader").reader!;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read(64 * 1024, call(this.timeoutMs));
        if (chunk.which === "end") break;
        if (chunk.which !== "chunk" || chunk.chunk === undefined) {
          if (chunk.error !== undefined) throwSbxError(chunk.error);
          break;
        }
        chunks.push(chunk.chunk.data.slice());
      }
    } finally {
      await reader.close().catch(() => {});
    }
    let length = 0;
    for (const chunk of chunks) length += chunk.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  async readTextFile(path: string, options?: ReadFileOptions): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path, options));
  }

  async writeFile(
    path: string,
    data: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>,
    options?: WriteFileOptions,
  ): Promise<void> {
    const result = await this.fs.beginUpload({
      path,
      mode: options?.mode ?? 0o644,
    }, capCall(this.timeoutMs));
    const upload = expectArm(result, "upload").upload!;
    const hash = new Sha256();
    let total = 0n;
    let sequence = 0n;
    const sink = async (chunk: Uint8Array): Promise<void> => {
      hash.update(chunk);
      total += BigInt(chunk.byteLength);
      await upload.chunk(
        { sequence, data: chunk as Uint8Array<ArrayBuffer> },
        call(this.timeoutMs),
      );
      sequence += 1n;
    };
    try {
      if (data instanceof ReadableStream) {
        const reader = data.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.byteLength > 0) {
            await sink(value as Uint8Array<ArrayBuffer>);
          }
        }
      } else if (data.byteLength > 0) {
        const size = 64 * 1024;
        for (let offset = 0; offset < data.byteLength; offset += size) {
          await sink(data.subarray(offset, offset + size));
        }
      }
      const finish = await upload.finish({
        totalBytes: total,
        chunkCount: sequence,
        sha256: hash.digest(),
      }, call(this.timeoutMs));
      if (finish.which === "error" && finish.error !== undefined) {
        throwSbxError(finish.error);
      }
    } finally {
      await upload.close().catch(() => {});
    }
  }

  async writeTextFile(
    path: string,
    data: string | ReadableStream<string>,
    options?: WriteFileOptions,
  ): Promise<void> {
    if (typeof data === "string") {
      return await this.writeFile(
        path,
        new TextEncoder().encode(data),
        options,
      );
    }
    const bytes = data.pipeThrough(new TextEncoderStream());
    return await this.writeFile(
      path,
      bytes as unknown as ReadableStream<Uint8Array>,
      options,
    );
  }

  async *readDir(path: string): AsyncIterableIterator<DirEntry> {
    const result = await this.fs.list(path, call(this.timeoutMs));
    const list = expectArm(result, "list").list!;
    for (const entry of list.entries) yield toDirEntry(entry);
  }

  async remove(path: string, options?: RemoveOptions): Promise<void> {
    const result = await this.fs.remove({
      path,
      recursive: options?.recursive ?? false,
    }, call(this.timeoutMs));
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const result = await this.fs.makeDir({
      path,
      recursive: options?.recursive ?? false,
    }, call(this.timeoutMs));
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const result = await this.fs.rename({
      from: oldPath,
      to: newPath,
    }, call(this.timeoutMs));
    if (result.which === "error" && result.error !== undefined) {
      throwSbxError(result.error);
    }
  }

  async stat(path: string): Promise<FileInfo> {
    const result = await this.fs.stat(path, call(this.timeoutMs));
    return toFileInfo(expectArm(result, "info").info!);
  }

  async open(path: string, options?: OpenOptions): Promise<AgentFsFile> {
    const result = await this.fs.open({
      path,
      create: options?.create ?? options?.createNew ?? false,
      truncate: options?.truncate ?? false,
    }, capCall(this.timeoutMs));
    return new WireAgentFsFile(expectArm(result, "file").file!, this.timeoutMs);
  }

  async create(path: string): Promise<AgentFsFile> {
    const result = await this.fs.open({
      path,
      create: true,
      truncate: true,
    }, capCall(this.timeoutMs));
    return new WireAgentFsFile(expectArm(result, "file").file!, this.timeoutMs);
  }

  async truncate(path: string, length?: number): Promise<void> {
    const file = await this.open(path, { write: true });
    try {
      await file.truncate(length ?? 0);
    } finally {
      await file.close();
    }
  }

  // -- wire-plane gaps: typed not-yet (M8+ sandbox_agent.capnp extensions) --

  lstat(_path: string): Promise<FileInfo> {
    return Promise.reject(new ImplementationPendingError("fs.lstat"));
  }
  chmod(_path: string, _mode: number): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.chmod"));
  }
  chown(
    _path: string,
    _uid: number | null,
    _gid: number | null,
  ): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.chown"));
  }
  /** Copy file CONTENTS (mirrors `Deno.copyFile`) over the wire read/write core. */
  async copyFile(from: string, to: string): Promise<void> {
    await this.writeFile(to, await this.readFile(from));
  }
  link(_target: string, _path: string): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.link"));
  }
  symlink(
    _target: string,
    _path: string,
    _options?: AgentSymlinkOptions,
  ): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.symlink"));
  }
  readLink(_path: string): Promise<string> {
    return Promise.reject(new ImplementationPendingError("fs.readLink"));
  }
  realPath(_path: string): Promise<string> {
    return Promise.reject(new ImplementationPendingError("fs.realPath"));
  }
  umask(_mask?: number): Promise<number> {
    return Promise.reject(new ImplementationPendingError("fs.umask"));
  }
  utime(
    _path: string,
    _atime: number | Date,
    _mtime: number | Date,
  ): Promise<void> {
    return Promise.reject(new ImplementationPendingError("fs.utime"));
  }
  /** Mirrors `Deno.makeTempDir`: mkdir a random name under `dir` (default `/tmp`). */
  async makeTempDir(options?: AgentMakeTempOptions): Promise<string> {
    const path = tempPath(options);
    await this.mkdir(path, { recursive: false });
    return path;
  }

  /** Mirrors `Deno.makeTempFile`: create an empty random file under `dir`. */
  async makeTempFile(options?: AgentMakeTempOptions): Promise<string> {
    const path = tempPath(options);
    const file = await this.create(path);
    await file.close();
    return path;
  }

  /** Mirrors `@std/fs/walk` over the wire `list`/`stat` core (SDK-side recursion). */
  walk(
    path: string,
    options: WalkOptions = {},
  ): AsyncIterableIterator<WalkEntry> {
    return this.#walk(path, options, options.maxDepth ?? Infinity);
  }

  async *#walk(
    root: string,
    options: WalkOptions,
    depth: number,
  ): AsyncIterableIterator<WalkEntry> {
    const {
      includeFiles = true,
      includeDirs = true,
      includeSymlinks = true,
      followSymlinks = false,
      exts,
      match,
      skip,
    } = options;
    if (depth < 0) return;
    if (includeDirs && includePath(root, undefined, match, skip)) {
      yield {
        path: root,
        name: basename(root),
        isFile: false,
        isDirectory: true,
        isSymlink: false,
      };
    }
    if (depth < 1 || !includePath(root, undefined, undefined, skip)) return;
    for await (const entry of this.readDir(root)) {
      const path = join(root, entry.name);
      let { isDirectory } = entry;
      if (entry.isSymlink) {
        if (!followSymlinks) {
          if (includeSymlinks && includePath(path, exts, match, skip)) {
            yield { path, ...entry };
          }
          continue;
        }
        // Follow the link: resolve its target type via stat (follows links).
        isDirectory = (await this.stat(path)).isDirectory;
      }
      if (isDirectory) {
        yield* this.#walk(path, options, depth - 1);
      } else if (includeFiles && includePath(path, exts, match, skip)) {
        yield {
          path,
          name: entry.name,
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        };
      }
    }
  }

  /** Mirrors `@std/fs/expandGlob` over the wire core (SDK-side recursion). */
  async *expandGlob(
    glob: string,
    options: ExpandGlobOptions = {},
  ): AsyncIterableIterator<WalkEntry> {
    const root = options.root ?? DEFAULT_SANDBOX_HOME;
    const absoluteGlob = glob.startsWith("/") ? glob : join(root, glob);
    const regExpOptions = {
      extended: options.extended ?? true,
      globstar: options.globstar ?? true,
      caseInsensitive: options.caseInsensitive ?? false,
      os: "linux" as const,
    };
    const pattern = globToRegExp(absoluteGlob, regExpOptions);
    const excludes = (options.exclude ?? []).map((glob) =>
      globToRegExp(
        glob.startsWith("/") ? glob : join(root, glob),
        regExpOptions,
      )
    );
    const includeDirs = options.includeDirs ?? true;
    // Walk from the longest leading non-glob prefix so we never descend
    // unrelated trees, then match each full path against the compiled glob.
    const base = staticGlobBase(absoluteGlob);
    for await (
      const entry of this.#walk(base, {
        includeDirs: true,
        includeFiles: true,
        followSymlinks: options.followSymlinks ?? false,
      }, Infinity)
    ) {
      if (!includeDirs && entry.isDirectory) continue;
      if (!pattern.test(entry.path)) continue;
      if (excludes.some((exclude) => exclude.test(entry.path))) continue;
      yield entry;
    }
  }
}

/** Assemble a random temp path under `dir` (default `/tmp`) with prefix/suffix. */
function tempPath(options?: AgentMakeTempOptions): string {
  const dir = options?.dir ?? "/tmp";
  const prefix = options?.prefix ?? "";
  const suffix = options?.suffix ?? "";
  const rand = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return join(dir, `${prefix}${rand}${suffix}`);
}

/** The longest leading path segment of an absolute glob with no glob chars. */
function staticGlobBase(absoluteGlob: string): string {
  const segments = absoluteGlob.split("/");
  const stat: string[] = [];
  for (const segment of segments) {
    if (/[*?{}[\]]/.test(segment)) break;
    stat.push(segment);
  }
  const base = stat.join("/");
  return base === "" ? "/" : base;
}

// ---------------------------------------------------------------------------
// Deno runtime
// ---------------------------------------------------------------------------

function decodeEval<T>(result: wire.EvalResult): T {
  if (result.which !== "json" || result.json === undefined) {
    if (result.error !== undefined) throwSbxError(result.error);
    throw new ImplementationPendingError("deno.eval");
  }
  const frame = JSON.parse(new TextDecoder().decode(result.json)) as {
    value?: unknown;
    error?: { name?: string; message?: string };
  };
  if (frame.error !== undefined) {
    const error = new Error(frame.error.message ?? "eval failed");
    if (frame.error.name !== undefined) error.name = frame.error.name;
    throw error;
  }
  return decodeReplValue(frame.value) as T;
}

class WireAgentDenoRepl implements AgentDenoRepl {
  #closed = false;
  constructor(
    private readonly repl: RpcStub<wire.DenoRepl>,
    private readonly timeoutMs: number,
  ) {}

  async eval<T = unknown>(source: string): Promise<T> {
    const result = await this.repl.eval(source, call(this.timeoutMs));
    return decodeEval<T>(result);
  }

  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    // The wire `DenoRepl` exposes only `eval`; `call` is composed as an
    // eval of `(fn)(...args)` with JSON-serialized arguments (the common
    // case). Arguments that are not JSON-round-trippable are an M8 wire gap.
    const argList = args.map((arg) => JSON.stringify(arg) ?? "undefined").join(
      ",",
    );
    return this.eval<T>(`await (${fn})(${argList})`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.repl.close(call(this.timeoutMs)).catch(() => {});
  }
}

class WireAgentDeno implements AgentDenoRuntime {
  constructor(
    private readonly deno: RpcStub<wire.DenoRuntime>,
    private readonly wireClient: RpcWireClient,
    private readonly timeoutMs: number,
  ) {}

  async eval<T = unknown>(
    source: string,
    options?: AgentDenoReplOptions,
  ): Promise<T> {
    const result = await this.deno.eval({
      source,
      env: toKeyValues(options?.env),
    }, call(this.timeoutMs));
    return decodeEval<T>(result);
  }

  async openRepl(options?: AgentDenoReplOptions): Promise<AgentDenoRepl> {
    const result = await this.deno.openRepl(
      toKeyValues(options?.env),
      capCall(this.timeoutMs),
    );
    return new WireAgentDenoRepl(
      expectArm(result, "repl").repl!,
      this.timeoutMs,
    );
  }

  async run(spec: AgentDenoRunSpec): Promise<AgentProcess> {
    // deno.run builds the `deno run` argv agent-side; the SDK maps its spec
    // to a SpawnSpec whose command carries the entrypoint or inline code.
    const stdout = spec.stdout ?? "piped";
    const stderr = spec.stderr ?? "piped";
    const stdin = spec.stdin ?? "null";
    const output = makeOutputSink(this.wireClient, stdout, stderr);
    const wireSpec: wire.SpawnSpec = {
      command: "entrypoint" in spec ? spec.entrypoint : "",
      args: [...(spec.scriptArgs ?? [])],
      cwd: spec.cwd ?? "",
      env: toKeyValues(spec.env),
      stdin: stdin === "piped" ? "piped" : "discard",
      stdout: stdout === "null" ? "discard" : "piped",
      stderr: stderr === "null" ? "discard" : "piped",
    };
    try {
      const result = expectArm(
        await this.deno.run({
          spec: wireSpec,
          output: output?.sink ?? null,
        }, capCall(this.timeoutMs)),
        "process",
      );
      // DenoProcess shares Process's control surface (writeStdin/closeStdin/
      // signal/wait); adapt it through the same process core.
      return new WireAgentProcess(
        result.process! as unknown as RpcStub<wire.Process>,
        output?.channels ?? null,
        { stdout, stderr, stdin },
        this.timeoutMs,
      );
    } catch (error) {
      throw normalizeThrown(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Backend aggregate
// ---------------------------------------------------------------------------

/** The four wire sub-capabilities the backend drives. */
export interface WireAgentStubs {
  readonly agent: RpcStub<wire.SandboxAgent>;
  readonly processes: RpcStub<wire.ProcessSpawner>;
  readonly fs: RpcStub<wire.FileSystem>;
  readonly env: RpcStub<wire.Environment>;
  readonly deno: RpcStub<wire.DenoRuntime>;
}

/** The {@link AgentApi}-shaped backend a facade sandbox binds to. */
export interface SandboxBackend {
  readonly processes: AgentProcessSpawner;
  readonly fs: AgentFileSystem;
  readonly env: AgentEnvironment;
  readonly deno: AgentDenoRuntime;
}

/**
 * Resolve the four sub-capabilities of a bootstrapped {@link
 * wire.SandboxAgent} and wrap them as a {@link SandboxBackend}. `timeoutMs`
 * bounds every subsequent plane call.
 */
export async function resolveWireBackend(
  agent: RpcStub<wire.SandboxAgent>,
  wireClient: RpcWireClient,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<{ backend: SandboxBackend; stubs: WireAgentStubs }> {
  const [processes, fs, env, deno] = await Promise.all([
    agent.processes(capCall(timeoutMs)),
    agent.filesystem(capCall(timeoutMs)),
    agent.environment(capCall(timeoutMs)),
    agent.deno(capCall(timeoutMs)),
  ]);
  const backend: SandboxBackend = {
    processes: new WireAgentProcesses(processes, wireClient, timeoutMs),
    fs: new WireAgentFs(fs, timeoutMs),
    env: new WireAgentEnv(env, timeoutMs),
    deno: new WireAgentDeno(deno, wireClient, timeoutMs),
  };
  return { backend, stubs: { agent, processes, fs, env, deno } };
}

export const DEFAULT_AGENT_CALL_TIMEOUT_MS = DEFAULT_CALL_TIMEOUT_MS;
export { DEFAULT_TRANSPORT_LIMITS };
