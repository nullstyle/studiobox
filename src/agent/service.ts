/**
 * The studioboxd capnp wire plane: `schema/sandbox_agent.capnp` services
 * over the {@linkcode AgentApi} domain core.
 *
 * This module is the M3-wire adapter DESIGN.md §4/§10 describe: every
 * RPC handler decodes its request struct, delegates to the same-named
 * domain method on `src/agent/api.ts`, and encodes the result (or
 * `SbxError` union arm). Domain logic never lives here; wire-only
 * mechanics (bootstrap gating, `OutputSink` push pumps, `-> stream`
 * sequence bookkeeping, `TransferCommit` verification, capability
 * export) never live in the domain.
 *
 * ## Connection lifecycle (fail-closed)
 *
 * Each accepted transport serves one {@linkcode AgentWireConnection}:
 * a generated `AgentBootstrap` root whose `negotiate` → `authenticate`
 * ordering is enforced by {@linkcode BootstrapGate}. `agent()` (and
 * every service getter behind it) asserts the `authenticated` phase;
 * an out-of-order call closes the gate permanently. Credentials are
 * compared constant-time and failures are attempt-limited by the gate.
 *
 * ## Streaming
 *
 * - Process stdout/stderr are PUMPED by the agent through the caller's
 *   `streams.capnp` `OutputSink` capability using the generated
 *   `-> stream` chunk sender with a bounded in-flight window
 *   (negotiated `TransportLimits.maxChunksInFlight`) and chunk size
 *   (`maxChunkBytes`). Each channel ends with `finish(TransferCommit)`
 *   carrying total bytes + chunk count + a streaming SHA-256; a pump
 *   failure emits `fail(SbxError)` best-effort.
 * - `Process.writeStdin` / `Upload.chunk` / `RemoteFile.write` accept
 *   the schema's sequenced `-> stream` flow; sequence gaps fail loudly
 *   and `closeStdin`/`finish` verify the caller's `TransferCommit`.
 * - `FileSystem.beginDownload` serves a pull `ByteReader` whose `end`
 *   receipt carries the streaming SHA-256 of everything read.
 *
 * ## Mappings pinned here (the wire contract of record for M3)
 *
 * - `StdioMode`: wire `inherit` and `piped` both lower to the domain's
 *   `"piped"`; wire `discard` lowers to `"null"` (see the
 *   `AgentStdioMode` note in `api.ts` — "inherit" is client-side
 *   behavior; the agent always produces piped streams).
 * - `KillSignal`: the wire enum's four signals map 1:1; a terminating
 *   signal outside that set reports wire `sigterm` with the truthful
 *   `code = 128 + n` (the code, not the enum, is the upstream-fidelity
 *   surface).
 * - `EvalResult.json` carries UTF-8 JSON `{"value": <repl-codec form>}`
 *   (`src/agent/deno_runtime_codec.ts`); clients decode with
 *   `decodeReplValue(JSON.parse(bytes).value)`.
 * - `DenoRuntime.run` interprets `SpawnSpec.command` as the in-sandbox
 *   entrypoint path and `SpawnSpec.args` as `scriptArgs` (inline-code
 *   runs are SDK-side composition, M8).
 * - `Process.release` drops the domain registry entry (unconsumed
 *   stdio is reaped) but never kills — capability drop and termination
 *   stay distinct, mirroring the schema.
 *
 * ## Deferred loudly (report, don't guess)
 *
 * - `SandboxAgent.http()` (the `HttpClient` egress plane) and
 *   `DenoProcess.fetch`/`httpReady` return/throw `unsupportedFeature` —
 *   they are M8 surface.
 * - `upload`/`download` recursive composition is SDK-side (M8); the
 *   agent serves only the schema's `beginUpload`/`beginDownload`.
 *
 * @module
 */

import wireCompat from "../../compat/wire.json" with { type: "json" };

import type {
  AgentApi,
  AgentDenoRepl,
  AgentDenoRunSpec,
  AgentFileSystem,
  AgentFsFile,
  AgentKillSignal,
  AgentProcess,
  AgentProcessStatus,
  AgentSpawnSpec,
  AgentStdioMode,
  FileInfo as DomainFileInfo,
} from "./api.ts";
import { AgentError, SeekMode } from "./api.ts";
import { encodeReplValue } from "./deno_runtime_codec.ts";
import { Sha256 } from "./sha256.ts";

import {
  AuthenticationRejectedError,
  BootstrapGate,
  type BootstrapPhase,
  BootstrapRejectedError,
  BootstrapStateError,
} from "../wire/bootstrap_gate.ts";
import type {
  ContractIdentity,
  NegotiatedContract as ContractNegotiatedContract,
  NegotiationPolicy,
  ProtocolOffer as ContractProtocolOffer,
  SbxError as ContractSbxError,
  TransportLimits,
} from "../wire/contract.ts";
import {
  DEFAULT_TRANSPORT_LIMITS,
  FEATURE,
  negotiateProtocol,
  SHA256_BYTES,
  timingSafeEqual,
} from "../wire/contract.ts";

import type {
  RpcCallContext,
  RpcServerRegistry,
  RpcStub,
  RpcTransport,
} from "@nullstyle/capnp/rpc";
import { RpcServerRuntime } from "@nullstyle/capnp/rpc";
import type { CapabilityPointer } from "@nullstyle/capnp/encoding";

import * as wire from "../wire/generated/sandbox_agent_types.ts";
import type * as wireCommon from "../wire/generated/common_types.ts";
import * as wireStreams from "../wire/generated/streams_types.ts";

// ---------------------------------------------------------------------------
// Contract identity (M3 placeholder — real artifact identity arrives at M5)
// ---------------------------------------------------------------------------

/** Feature bits this agent build both offers and requires of its peer. */
export const AGENT_PLANE_FEATURES: bigint = FEATURE.typedErrors |
  FEATURE.boundedStreams;

/** Default per-call timeout for agent-originated `OutputSink` calls. */
export const DEFAULT_OUTPUT_CALL_TIMEOUT_MS = 30_000;

/** Default authenticated-session TTL reported in `AuthSession`. */
export const DEFAULT_SESSION_TTL_MS = 3_600_000;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError("invalid hex digest");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The M3 agent-plane {@linkcode ContractIdentity}: protocol version,
 * canonical schema-bundle hash, and capnp runtime version come from
 * `compat/wire.json`; the artifact / WASM / firecracker digests are
 * explicit placeholders (all-zero digests, `"unpinned"` package) until
 * M5 wires the real artifact manifest into the identity. Both ends of
 * an M3 connection must build their identity through this helper —
 * negotiation compares these fields for equality.
 */
export function m3AgentContractIdentity(buildId: string): ContractIdentity {
  return Object.freeze({
    protocol: Object.freeze({
      major: wireCompat.protocol.major,
      minor: wireCompat.protocol.minor,
    }),
    featureBits: AGENT_PLANE_FEATURES,
    schemaHash: hexToBytes(wireCompat.schemaSha256),
    capnpDenoVersion: wireCompat.codegen.version,
    wasmAbi: 1,
    wasmSha256: new Uint8Array(SHA256_BYTES),
    buildId,
    artifactHash: new Uint8Array(SHA256_BYTES),
    firecrackerPackage: "unpinned",
    firecrackerSha256: new Uint8Array(SHA256_BYTES),
    firecrackerPinned: "0.0.0",
    firecrackerMin: "0.0.0",
  });
}

// ---------------------------------------------------------------------------
// Wire <-> domain vocabulary mapping
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function kvToRecord(list: readonly wireCommon.KeyValue[]): Record<
  string,
  string
> {
  const out: Record<string, string> = {};
  for (const entry of list) out[entry.key] = entry.value;
  return out;
}

function recordToKv(record: Record<string, string>): wireCommon.KeyValue[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function stdioToDomain(mode: wire.StdioMode): AgentStdioMode {
  // Wire `inherit` is CLIENT-side behavior (the SDK pipes into the
  // host's stdio); at the agent boundary both inherit and piped are
  // piped streams. Only `discard` suppresses the pipe.
  return mode === "discard" ? "null" : "piped";
}

const WIRE_TO_SIGNAL: Record<wire.KillSignal, AgentKillSignal> = {
  sigterm: "SIGTERM",
  sigkill: "SIGKILL",
  sigint: "SIGINT",
  sighup: "SIGHUP",
};

function signalToWire(signal: AgentKillSignal | null): wire.KillSignal {
  switch (signal) {
    case "SIGKILL":
      return "sigkill";
    case "SIGINT":
      return "sigint";
    case "SIGHUP":
      return "sighup";
    default:
      // Signals outside the wire enum (SIGABRT, SIGQUIT, ...) report
      // sigterm here; `code = 128 + n` carries the truthful signal.
      return "sigterm";
  }
}

function spawnSpecToDomain(spec: wire.SpawnSpec): AgentSpawnSpec {
  return {
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd === "" ? undefined : spec.cwd,
    env: spec.env.length === 0 ? undefined : kvToRecord(spec.env),
    stdin: stdioToDomain(spec.stdin),
    stdout: stdioToDomain(spec.stdout),
    stderr: stdioToDomain(spec.stderr),
  };
}

function statusToWire(status: AgentProcessStatus): wire.ProcessStatus {
  return {
    running: false,
    code: status.code,
    signal: signalToWire(status.signal),
    signaled: status.signaled,
    oom: status.oom,
  };
}

function fileKindOf(info: DomainFileInfo): wire.FileKind {
  if (info.isSymlink) return "symlink";
  if (info.isDirectory) return "directory";
  return "regular";
}

function fileInfoToWire(path: string, info: DomainFileInfo): wire.FileInfo {
  return {
    path,
    kind: fileKindOf(info),
    size: BigInt(info.size),
    mode: info.mode >>> 0,
    modifiedAtUnixMs: BigInt(Math.max(0, info.mtime.getTime())),
  };
}

function joinSandboxPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

// ---------------------------------------------------------------------------
// SbxError mapping
// ---------------------------------------------------------------------------

function makeSbxError(
  code: wireCommon.ErrorCode,
  message: string,
  details: wireCommon.ErrorDetail[] = [],
): wireCommon.SbxError {
  return {
    code,
    message: message.slice(0, 512),
    retryable: false,
    operationId: "",
    sandboxId: "",
    details,
  };
}

const AGENT_ERROR_CODES: Record<
  AgentError["code"],
  wireCommon.ErrorCode
> = {
  SBX_AGENT_PATH_ESCAPE: "permissionDenied",
  SBX_AGENT_VALIDATION: "invalidArgument",
  SBX_AGENT_CLOSED: "failedPrecondition",
  SBX_AGENT_STATE: "failedPrecondition",
  SBX_AGENT_EVAL: "internal",
  SBX_AGENT_UNSUPPORTED: "unsupportedFeature",
};

/**
 * Lower a thrown domain error onto the wire's `SbxError`:
 * {@linkcode AgentError} codes map per {@linkcode AGENT_ERROR_CODES}
 * (the agent code rides in `details.agentCode`); `Deno.errors.*`
 * surface with their OS error name in `details.errorName` so the SDK
 * can rebuild the 1:1 `Deno.errors` mapping upstream requires; other
 * errors use `fallback`.
 */
function toWireSbxError(
  error: unknown,
  fallback: wireCommon.ErrorCode = "internal",
): wireCommon.SbxError {
  if (error instanceof AgentError) {
    return makeSbxError(AGENT_ERROR_CODES[error.code], error.message, [
      { key: "agentCode", value: error.code },
    ]);
  }
  if (error instanceof Error) {
    let code: wireCommon.ErrorCode = fallback;
    if (error instanceof Deno.errors.NotFound) code = "notFound";
    else if (error instanceof Deno.errors.AlreadyExists) {
      code = "alreadyExists";
    } else if (error instanceof Deno.errors.PermissionDenied) {
      code = "permissionDenied";
    }
    return makeSbxError(code, error.message, [
      { key: "errorName", value: error.name },
    ]);
  }
  return makeSbxError(fallback, String(error));
}

function contractErrorToWire(error: ContractSbxError): wireCommon.SbxError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    operationId: error.operationId,
    sandboxId: error.sandboxId,
    details: recordToKv({ ...error.details }),
  };
}

function okResult(): wireCommon.EmptyResult {
  return { which: "ok", ok: {} };
}

function errorResult(error: wireCommon.SbxError): wireCommon.EmptyResult {
  return { which: "error", error };
}

async function emptyResultOf(
  operation: () => Promise<void>,
): Promise<wireCommon.EmptyResult> {
  try {
    await operation();
    return okResult();
  } catch (error) {
    return errorResult(toWireSbxError(error));
  }
}

// ---------------------------------------------------------------------------
// Contract-struct conversions (generated common <-> src/wire/contract.ts)
// ---------------------------------------------------------------------------

function identityToContract(
  identity: wireCommon.ContractIdentity,
): ContractIdentity {
  return {
    protocol: {
      major: identity.protocol.major,
      minor: identity.protocol.minor,
    },
    featureBits: identity.featureBits,
    schemaHash: identity.schemaHash,
    capnpDenoVersion: identity.capnpDenoVersion,
    wasmAbi: identity.wasmAbi,
    wasmSha256: identity.wasmSha256,
    buildId: identity.buildId,
    artifactHash: identity.artifactHash,
    firecrackerPackage: identity.firecrackerPackage,
    firecrackerSha256: identity.firecrackerSha256,
    firecrackerPinned: identity.firecrackerPinned,
    firecrackerMin: identity.firecrackerMin,
  };
}

/** Widen a domain identity into the generated wire struct. */
export function identityToWire(
  identity: ContractIdentity,
): wireCommon.ContractIdentity {
  return {
    protocol: {
      major: identity.protocol.major,
      minor: identity.protocol.minor,
    },
    featureBits: identity.featureBits,
    schemaHash: identity.schemaHash.slice(),
    capnpDenoVersion: identity.capnpDenoVersion,
    wasmAbi: identity.wasmAbi,
    wasmSha256: identity.wasmSha256.slice(),
    buildId: identity.buildId,
    artifactHash: identity.artifactHash.slice(),
    firecrackerPackage: identity.firecrackerPackage,
    firecrackerSha256: identity.firecrackerSha256.slice(),
    firecrackerPinned: identity.firecrackerPinned,
    firecrackerMin: identity.firecrackerMin,
  };
}

function limitsToContract(limits: wireCommon.TransportLimits): TransportLimits {
  return {
    maxFrameBytes: limits.maxFrameBytes,
    maxSegments: limits.maxSegments,
    maxNestingDepth: limits.maxNestingDepth,
    maxTraversalWords: Number(limits.maxTraversalWords),
    maxQueuedFrames: limits.maxQueuedFrames,
    maxQueuedBytes: limits.maxQueuedBytes,
    maxInFlightCalls: limits.maxInFlightCalls,
    maxExports: limits.maxExports,
    maxCompletedAnswers: limits.maxCompletedAnswers,
    maxChunkBytes: limits.maxChunkBytes,
    maxChunksInFlight: limits.maxChunksInFlight,
  };
}

/** Widen domain transport limits into the generated wire struct. */
export function limitsToWire(
  limits: TransportLimits,
): wireCommon.TransportLimits {
  return {
    maxFrameBytes: limits.maxFrameBytes,
    maxSegments: limits.maxSegments,
    maxNestingDepth: limits.maxNestingDepth,
    maxTraversalWords: BigInt(limits.maxTraversalWords),
    maxQueuedFrames: limits.maxQueuedFrames,
    maxQueuedBytes: limits.maxQueuedBytes,
    maxInFlightCalls: limits.maxInFlightCalls,
    maxExports: limits.maxExports,
    maxCompletedAnswers: limits.maxCompletedAnswers,
    maxChunkBytes: limits.maxChunkBytes,
    maxChunksInFlight: limits.maxChunksInFlight,
  };
}

function offerToContract(
  offer: wireCommon.ProtocolOffer,
): ContractProtocolOffer {
  return {
    identity: identityToContract(offer.identity),
    limits: limitsToContract(offer.limits),
    requiredFeatureBits: offer.requiredFeatureBits,
  };
}

function negotiatedToWire(
  value: ContractNegotiatedContract,
): wireCommon.NegotiatedContract {
  return {
    identity: identityToWire(value.identity),
    limits: limitsToWire(value.limits),
    selectedFeatureBits: value.selectedFeatureBits,
  };
}

// ---------------------------------------------------------------------------
// Streaming bookkeeping
// ---------------------------------------------------------------------------

/**
 * Sequence + SHA-256 + byte accounting for one directed byte stream
 * (a wire `-> stream` flow or an agent-side pump). Sequences are dense
 * from 0; a gap or replay throws `SBX_AGENT_VALIDATION`.
 */
class StreamTally {
  #hash = new Sha256();
  #bytes = 0n;
  #chunks = 0n;
  #next = 0n;

  /** Record an outbound chunk; returns its sequence number. */
  absorb(data: Uint8Array): bigint {
    const sequence = this.#next;
    this.#next += 1n;
    this.#chunks += 1n;
    this.#bytes += BigInt(data.byteLength);
    this.#hash.update(data);
    return sequence;
  }

  /**
   * Assert `sequence` is the next expected inbound sequence WITHOUT
   * mutating any counter. Callers validate (this + the chunk-size check)
   * BEFORE the downstream write, then {@linkcode absorb} the bytes only
   * after the write succeeds — a failed write must not advance the hash,
   * byte, chunk, or sequence tally (otherwise a later commit verifies
   * against bytes that never landed).
   */
  expectSequence(sequence: bigint): void {
    if (sequence !== this.#next) {
      throw new AgentError(
        "SBX_AGENT_VALIDATION",
        `out-of-order stream chunk: expected sequence ${this.#next}, received ${sequence}`,
      );
    }
  }

  commit(): wireStreams.TransferCommit {
    return {
      totalBytes: this.#bytes,
      chunkCount: this.#chunks,
      sha256: this.#hash.digest(),
    };
  }

  receipt(): wireStreams.TransferReceipt {
    return {
      totalBytes: this.#bytes,
      chunkCount: this.#chunks,
      sha256: this.#hash.digest(),
    };
  }

  /** Returns a mismatch description, or null when the commit matches. */
  verify(commit: wireStreams.TransferCommit): string | null {
    if (commit.totalBytes !== this.#bytes) {
      return `totalBytes ${commit.totalBytes} != received ${this.#bytes}`;
    }
    if (commit.chunkCount !== this.#chunks) {
      return `chunkCount ${commit.chunkCount} != received ${this.#chunks}`;
    }
    if (!timingSafeEqual(commit.sha256, this.#hash.digest())) {
      return "sha256 does not match the received bytes";
    }
    return null;
  }
}

function clampChunkBytes(requested: number, ceiling: number): number {
  const wanted = Number.isInteger(requested) && requested > 0 ? requested : 1;
  return Math.min(wanted, ceiling);
}

/**
 * Reject an inbound `-> stream` chunk whose payload exceeds the
 * negotiated `TransportLimits.maxChunkBytes` BEFORE it is buffered or
 * written. Enforcing the ceiling at the boundary keeps a hostile peer
 * from smuggling an oversized frame past the streaming flow control and
 * guarantees an oversized chunk commits no partial data.
 */
function assertChunkWithinLimit(
  data: Uint8Array,
  maxChunkBytes: number,
): void {
  if (data.byteLength > maxChunkBytes) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `stream chunk of ${data.byteLength} bytes exceeds the negotiated maxChunkBytes of ${maxChunkBytes}`,
    );
  }
}

function asBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  // Generated decode always materializes fresh ArrayBuffer-backed
  // views; the domain API is typed against Uint8Array<ArrayBuffer>.
  return data as Uint8Array<ArrayBuffer>;
}

async function writeAll(
  file: AgentFsFile,
  data: Uint8Array<ArrayBuffer>,
): Promise<void> {
  let written = 0;
  while (written < data.byteLength) {
    written += await file.write(asBody(data.subarray(written)));
  }
}

// ---------------------------------------------------------------------------
// Connection state + capability export plumbing
// ---------------------------------------------------------------------------

/** Connection-scoped closable (repl session, open file, transfer). */
interface ConnectionResource {
  closeResource(): Promise<void>;
}

class ConnectionState {
  readonly gate = new BootstrapGate();
  readonly #resources = new Set<ConnectionResource>();

  limits(): TransportLimits {
    return this.gate.contract?.limits ?? DEFAULT_TRANSPORT_LIMITS;
  }

  track(resource: ConnectionResource): void {
    this.#resources.add(resource);
  }

  untrack(resource: ConnectionResource): void {
    this.#resources.delete(resource);
  }

  async closeResources(): Promise<void> {
    const resources = [...this.#resources];
    this.#resources.clear();
    for (const resource of resources) {
      try {
        await resource.closeResource();
      } catch {
        // Best-effort teardown; the process registry sweep at agent
        // shutdown is the backstop.
      }
    }
  }
}

/**
 * Capabilities exported through the call context are WIRE-MANAGED
 * (capnp 0.3.0): registration seeds no standing reference; the Return
 * frame naming the capability mints the peer's reference and inbound
 * Release frames drain it, so a fully released capability drops its
 * dispatch entry. Callers must therefore NOT pass a `referenceCount`.
 */
function contextRegistry(ctx: RpcCallContext): RpcServerRegistry {
  const exportCapability = ctx.exportCapability;
  if (exportCapability === undefined) {
    throw new AgentError(
      "SBX_AGENT_STATE",
      "rpc call context does not support exporting capabilities",
    );
  }
  return { exportCapability };
}

function asStub<T extends object>(pointer: CapabilityPointer): RpcStub<T> {
  // Generated dehydrate walkers accept raw capability pointers wherever
  // a struct field is typed RpcStub<T>; the client-side hydrate walker
  // rebuilds the live typed stub.
  return pointer as unknown as RpcStub<T>;
}

// ---------------------------------------------------------------------------
// OutputSink pumps
// ---------------------------------------------------------------------------

interface OutputPumpOptions {
  readonly chunkBytes: number;
  readonly window: number;
  readonly callTimeoutMs: number;
}

async function pumpOutputChannel(
  sink: RpcStub<wireStreams.OutputSink>,
  channel: wireStreams.OutputChannel,
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  options: OutputPumpOptions,
): Promise<void> {
  const tally = new StreamTally();
  try {
    if (stream !== null) {
      const sender = wireStreams.createOutputSinkChunkStreamSender(sink, {
        maxInFlight: options.window,
        call: { timeoutMs: options.callTimeoutMs },
      });
      for await (const piece of stream) {
        for (
          let offset = 0;
          offset < piece.byteLength;
          offset += options.chunkBytes
        ) {
          const data = piece.subarray(
            offset,
            Math.min(offset + options.chunkBytes, piece.byteLength),
          );
          const sequence = tally.absorb(data);
          await sender.waitForCapacity();
          await sender.send({ channel, sequence, data });
        }
      }
      await sender.flush();
    }
    // A discarded ("null") channel finishes immediately with an empty
    // commit so sink owners can await completion uniformly.
    await sink.finish(
      { channel, commit: tally.commit() },
      { timeoutMs: options.callTimeoutMs },
    );
  } catch (error) {
    try {
      await sink.fail(
        { channel, error: toWireSbxError(error) },
        { timeoutMs: options.callTimeoutMs },
      );
    } catch {
      // The peer is unreachable; the transport teardown owns cleanup.
    }
  }
}

function startOutputPumps(
  state: ConnectionState,
  options: AgentWireOptions,
  process: AgentProcess,
  output: RpcStub<wireStreams.OutputSink> | null,
): void {
  if (output === null) return;
  const limits = state.limits();
  const pumpOptions: OutputPumpOptions = {
    chunkBytes: limits.maxChunkBytes,
    window: limits.maxChunksInFlight,
    callTimeoutMs: options.outputCallTimeoutMs ??
      DEFAULT_OUTPUT_CALL_TIMEOUT_MS,
  };
  void pumpOutputChannel(output, "stdout", process.stdout, pumpOptions);
  void pumpOutputChannel(output, "stderr", process.stderr, pumpOptions);
}

// ---------------------------------------------------------------------------
// Per-object services
// ---------------------------------------------------------------------------

class ProcessWire implements wire.ProcessService {
  readonly #state: ConnectionState;
  readonly #options: AgentWireOptions;
  readonly #process: AgentProcess;
  readonly #stdin = new StreamTally();
  #status: AgentProcessStatus | null = null;
  #statusError: unknown = null;
  #settled = false;

  constructor(
    state: ConnectionState,
    options: AgentWireOptions,
    process: AgentProcess,
  ) {
    this.#state = state;
    this.#options = options;
    this.#process = process;
    process.status.then(
      (status) => {
        this.#status = status;
        this.#settled = true;
      },
      (error: unknown) => {
        this.#statusError = error;
        this.#settled = true;
      },
    );
  }

  async writeStdin(params: wire.WriteStdinParams): Promise<void> {
    assertChunkWithinLimit(
      params.data,
      this.#state.limits().maxChunkBytes,
    );
    this.#stdin.expectSequence(params.sequence);
    await this.#process.writeStdin(asBody(params.data));
    // Tally only after the write lands: a failed write leaves the stdin
    // accounting untouched so `closeStdin`'s commit stays truthful.
    this.#stdin.absorb(params.data);
  }

  async closeStdin(
    commit: wireStreams.TransferCommit,
  ): Promise<wireStreams.FinishResult> {
    const mismatch = this.#stdin.verify(commit);
    if (mismatch !== null) {
      return {
        which: "error",
        error: makeSbxError(
          "invalidArgument",
          `stdin transfer commit mismatch: ${mismatch}`,
        ),
      };
    }
    try {
      await this.#process.closeStdin();
    } catch (error) {
      return { which: "error", error: toWireSbxError(error) };
    }
    return { which: "receipt", receipt: this.#stdin.receipt() };
  }

  signal(signal: wire.KillSignal): Promise<wireCommon.EmptyResult> {
    return emptyResultOf(() => this.#process.kill(WIRE_TO_SIGNAL[signal]));
  }

  status(): wire.ProcessStatusResult {
    if (!this.#settled) {
      return {
        which: "status",
        status: {
          running: true,
          code: 0,
          signal: "sigterm",
          signaled: false,
          oom: false,
        },
      };
    }
    if (this.#status === null) {
      return { which: "error", error: toWireSbxError(this.#statusError) };
    }
    return { which: "status", status: statusToWire(this.#status) };
  }

  async wait(): Promise<wire.ProcessStatusResult> {
    try {
      return {
        which: "status",
        status: statusToWire(await this.#process.status),
      };
    } catch (error) {
      return { which: "error", error: toWireSbxError(error) };
    }
  }

  release(): wireCommon.EmptyResult {
    this.#options.releaseProcess?.(this.#process);
    return okResult();
  }
}

class DenoProcessWire extends ProcessWire implements wire.DenoProcessService {
  fetch(): wire.HttpExchangeResult {
    return {
      which: "error",
      error: makeSbxError(
        "unsupportedFeature",
        "DenoProcess.fetch is deferred to the M8 HttpClient plane",
      ),
    };
  }

  httpReady(): wire.HttpReadyResult {
    return {
      which: "error",
      error: makeSbxError(
        "unsupportedFeature",
        "DenoProcess.httpReady is deferred to the M8 HttpClient plane",
      ),
    };
  }
}

class RemoteFileWire implements wire.RemoteFileService, ConnectionResource {
  readonly #state: ConnectionState;
  readonly #path: string;
  readonly #file: AgentFsFile;
  readonly #reads = new StreamTally();
  #nextWriteSequence = 0n;

  constructor(state: ConnectionState, path: string, file: AgentFsFile) {
    this.#state = state;
    this.#path = path;
    this.#file = file;
    state.track(this);
  }

  async stat(): Promise<wire.FileInfoResult> {
    try {
      return {
        which: "info",
        info: fileInfoToWire(this.#path, await this.#file.stat()),
      };
    } catch (error) {
      return { which: "error", error: toWireSbxError(error) };
    }
  }

  async read(params: wire.ReadParams): Promise<wireStreams.ReadResult> {
    try {
      const size = clampChunkBytes(
        params.maxBytes,
        this.#state.limits().maxChunkBytes,
      );
      await this.#file.seek(Number(params.offset), SeekMode.Start);
      const buffer = new Uint8Array(size);
      const count = await this.#file.read(buffer);
      if (count === null) {
        return { which: "end", end: this.#reads.receipt() };
      }
      const data = buffer.subarray(0, count);
      return {
        which: "chunk",
        chunk: { sequence: this.#reads.absorb(data), data },
      };
    } catch (error) {
      return { which: "error", error: toWireSbxError(error) };
    }
  }

  async write(params: wire.WriteParams): Promise<void> {
    assertChunkWithinLimit(
      params.data,
      this.#state.limits().maxChunkBytes,
    );
    if (params.sequence !== this.#nextWriteSequence) {
      throw new AgentError(
        "SBX_AGENT_VALIDATION",
        `out-of-order write chunk: expected sequence ${this.#nextWriteSequence}, received ${params.sequence}`,
      );
    }
    await this.#file.seek(Number(params.offset), SeekMode.Start);
    await writeAll(this.#file, asBody(params.data));
    // Advance the write sequence only after the bytes land, so a failed
    // write leaves the sequence retryable rather than desynchronized.
    this.#nextWriteSequence += 1n;
  }

  truncate(size: bigint): Promise<wireCommon.EmptyResult> {
    return emptyResultOf(() => this.#file.truncate(Number(size)));
  }

  sync(): Promise<wireCommon.EmptyResult> {
    return emptyResultOf(() => this.#file.sync());
  }

  async close(): Promise<wireCommon.EmptyResult> {
    this.#state.untrack(this);
    return await emptyResultOf(() => this.#file.close());
  }

  async closeResource(): Promise<void> {
    await this.#file.close();
  }
}

class UploadWire implements wire.UploadService, ConnectionResource {
  readonly #state: ConnectionState;
  readonly #fs: AgentFileSystem;
  readonly #path: string;
  readonly #file: AgentFsFile;
  readonly #tally = new StreamTally();
  #done = false;

  constructor(
    state: ConnectionState,
    fs: AgentFileSystem,
    path: string,
    file: AgentFsFile,
  ) {
    this.#state = state;
    this.#fs = fs;
    this.#path = path;
    this.#file = file;
    state.track(this);
  }

  async chunk(params: wire.ChunkParams2): Promise<void> {
    if (this.#done) {
      throw new AgentError("SBX_AGENT_CLOSED", "the upload is finished");
    }
    assertChunkWithinLimit(
      params.data,
      this.#state.limits().maxChunkBytes,
    );
    this.#tally.expectSequence(params.sequence);
    await writeAll(this.#file, asBody(params.data));
    // Tally only after the bytes land so a failed write cannot corrupt
    // the commit hash/byte/chunk accounting `finish` verifies against.
    this.#tally.absorb(params.data);
  }

  async finish(
    commit: wireStreams.TransferCommit,
  ): Promise<wireStreams.FinishResult> {
    if (this.#done) {
      return {
        which: "error",
        error: makeSbxError("failedPrecondition", "the upload is finished"),
      };
    }
    this.#done = true;
    this.#state.untrack(this);
    const mismatch = this.#tally.verify(commit);
    if (mismatch !== null) {
      await this.#discard();
      return {
        which: "error",
        error: makeSbxError(
          "invalidArgument",
          `upload transfer commit mismatch: ${mismatch}`,
        ),
      };
    }
    try {
      await this.#file.sync();
      await this.#file.close();
    } catch (error) {
      return { which: "error", error: toWireSbxError(error) };
    }
    return { which: "receipt", receipt: this.#tally.receipt() };
  }

  async abort(): Promise<wireCommon.EmptyResult> {
    this.#done = true;
    this.#state.untrack(this);
    await this.#discard();
    return okResult();
  }

  async closeResource(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#discard();
  }

  async #discard(): Promise<void> {
    try {
      await this.#file.close();
    } catch {
      // Already closed.
    }
    try {
      await this.#fs.remove(this.#path);
    } catch {
      // Nothing to remove (never created / already gone).
    }
  }
}

class ByteReaderWire implements wireStreams.ByteReader, ConnectionResource {
  readonly #state: ConnectionState;
  readonly #file: AgentFsFile;
  readonly #tally = new StreamTally();
  #done = false;

  constructor(state: ConnectionState, file: AgentFsFile) {
    this.#state = state;
    this.#file = file;
    state.track(this);
  }

  async read(maxBytes: number): Promise<wireStreams.ReadResult> {
    try {
      if (this.#done) {
        return { which: "end", end: this.#tally.receipt() };
      }
      const size = clampChunkBytes(
        maxBytes,
        this.#state.limits().maxChunkBytes,
      );
      const buffer = new Uint8Array(size);
      const count = await this.#file.read(buffer);
      if (count === null) {
        this.#done = true;
        this.#state.untrack(this);
        await this.#file.close();
        return { which: "end", end: this.#tally.receipt() };
      }
      const data = buffer.subarray(0, count);
      return {
        which: "chunk",
        chunk: { sequence: this.#tally.absorb(data), data },
      };
    } catch (error) {
      return { which: "error", error: toWireSbxError(error) };
    }
  }

  async cancel(): Promise<wireCommon.EmptyResult> {
    this.#done = true;
    this.#state.untrack(this);
    return await emptyResultOf(() => this.#file.close());
  }

  async closeResource(): Promise<void> {
    await this.#file.close();
  }
}

function evalResultOf(value: unknown): wire.EvalResult {
  try {
    return {
      which: "json",
      json: textEncoder.encode(
        JSON.stringify({ value: encodeReplValue(value) }),
      ),
    };
  } catch (error) {
    // The repl driver produced a value the codec cannot carry.
    return {
      which: "error",
      error: toWireSbxError(
        new AgentError(
          "SBX_AGENT_EVAL",
          `eval result is not serializable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ),
    };
  }
}

class ReplWire implements wire.DenoRepl, ConnectionResource {
  readonly #state: ConnectionState;
  readonly #session: AgentDenoRepl;

  constructor(state: ConnectionState, session: AgentDenoRepl) {
    this.#state = state;
    this.#session = session;
    state.track(this);
  }

  async eval(source: string): Promise<wire.EvalResult> {
    try {
      return evalResultOf(await this.#session.eval(source));
    } catch (error) {
      // Errors THROWN BY the evaluated code arrive as plain Errors and
      // cross with code "unknown"; driver faults are typed AgentErrors.
      return { which: "error", error: toWireSbxError(error, "unknown") };
    }
  }

  async close(): Promise<wireCommon.EmptyResult> {
    this.#state.untrack(this);
    return await emptyResultOf(() => this.#session.close());
  }

  async closeResource(): Promise<void> {
    await this.#session.close();
  }
}

// ---------------------------------------------------------------------------
// Service servers (low-level generated interfaces; ctx carries the
// capability-export hook for struct-embedded capability results)
// ---------------------------------------------------------------------------

function processSpawnerServer(
  state: ConnectionState,
  options: AgentWireOptions,
): wire.ProcessSpawnerServer {
  return {
    spawn: async (params, ctx) => {
      state.gate.assertAuthorized();
      let process: AgentProcess;
      try {
        process = await options.api.processes.spawn(
          spawnSpecToDomain(params.spec),
        );
      } catch (error) {
        return {
          result: {
            which: "error",
            error: toWireSbxError(error, "invalidArgument"),
          },
        };
      }
      const pointer = wire.Process.registerServer(
        contextRegistry(ctx),
        new ProcessWire(state, options, process),
      );
      startOutputPumps(state, options, process, params.output);
      return {
        result: { which: "process", process: asStub<wire.Process>(pointer) },
      };
    },
  };
}

function fileSystemServer(
  state: ConnectionState,
  options: AgentWireOptions,
): wire.FileSystemServer {
  const fs = options.api.fs;
  return {
    stat: async (params, _ctx) => {
      state.gate.assertAuthorized();
      try {
        return {
          result: {
            which: "info",
            info: fileInfoToWire(params.path, await fs.stat(params.path)),
          },
        };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
    list: async (params, _ctx) => {
      state.gate.assertAuthorized();
      try {
        const entries: wire.FileInfo[] = [];
        for await (const entry of fs.readDir(params.path)) {
          const entryPath = joinSandboxPath(params.path, entry.name);
          entries.push(fileInfoToWire(entryPath, await fs.lstat(entryPath)));
        }
        return { result: { which: "list", list: { entries } } };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
    makeDir: async (params, _ctx) => {
      state.gate.assertAuthorized();
      return {
        result: await emptyResultOf(() =>
          fs.mkdir(params.path, { recursive: params.recursive })
        ),
      };
    },
    remove: async (params, _ctx) => {
      state.gate.assertAuthorized();
      return {
        result: await emptyResultOf(() =>
          fs.remove(params.path, { recursive: params.recursive })
        ),
      };
    },
    rename: async (params, _ctx) => {
      state.gate.assertAuthorized();
      return {
        result: await emptyResultOf(() => fs.rename(params.from, params.to)),
      };
    },
    open: async (params, ctx) => {
      state.gate.assertAuthorized();
      try {
        const file = await fs.open(params.path, {
          read: true,
          write: params.create || params.truncate,
          create: params.create,
          truncate: params.truncate,
        });
        const pointer = wire.RemoteFile.registerServer(
          contextRegistry(ctx),
          new RemoteFileWire(state, params.path, file),
        );
        return {
          result: { which: "file", file: asStub<wire.RemoteFile>(pointer) },
        };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
    beginUpload: async (params, ctx) => {
      state.gate.assertAuthorized();
      try {
        const file = await fs.open(params.path, {
          write: true,
          create: true,
          truncate: true,
          mode: params.mode === 0 ? undefined : params.mode,
        });
        const pointer = wire.Upload.registerServer(
          contextRegistry(ctx),
          new UploadWire(state, fs, params.path, file),
        );
        return {
          result: { which: "upload", upload: asStub<wire.Upload>(pointer) },
        };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
    beginDownload: async (params, ctx) => {
      state.gate.assertAuthorized();
      try {
        const file = await fs.open(params.path, { read: true });
        const pointer = wireStreams.ByteReader.registerServer(
          contextRegistry(ctx),
          new ByteReaderWire(state, file),
        );
        return {
          result: {
            which: "reader",
            reader: asStub<wireStreams.ByteReader>(pointer),
          },
        };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
  };
}

function environmentServer(
  state: ConnectionState,
  options: AgentWireOptions,
): wire.EnvironmentServer {
  const env = options.api.env;
  return {
    get: async (params, _ctx) => {
      state.gate.assertAuthorized();
      try {
        const value = await env.get(params.key);
        if (value === undefined) return { result: { which: "missing" } };
        return { result: { which: "value", value } };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
    set: async (params, _ctx) => {
      state.gate.assertAuthorized();
      return {
        result: await emptyResultOf(() => env.set(params.key, params.value)),
      };
    },
    delete: async (params, _ctx) => {
      state.gate.assertAuthorized();
      return { result: await emptyResultOf(() => env.delete(params.key)) };
    },
    list: async (_params, _ctx) => {
      state.gate.assertAuthorized();
      try {
        return {
          result: {
            which: "values",
            values: recordToKv(await env.toObject()),
          },
        };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
  };
}

function denoRuntimeServer(
  state: ConnectionState,
  options: AgentWireOptions,
): wire.DenoRuntimeServer {
  const deno = options.api.deno;
  return {
    eval: async (params, _ctx) => {
      state.gate.assertAuthorized();
      try {
        const value = await deno.eval(
          params.source,
          params.env.length === 0 ? {} : { env: kvToRecord(params.env) },
        );
        return { result: evalResultOf(value) };
      } catch (error) {
        return {
          result: { which: "error", error: toWireSbxError(error, "unknown") },
        };
      }
    },
    openRepl: async (params, ctx) => {
      state.gate.assertAuthorized();
      try {
        const session = await deno.openRepl(
          params.env.length === 0 ? {} : { env: kvToRecord(params.env) },
        );
        const pointer = wire.DenoRepl.registerServer(
          contextRegistry(ctx),
          new ReplWire(state, session),
        );
        return {
          result: { which: "repl", repl: asStub<wire.DenoRepl>(pointer) },
        };
      } catch (error) {
        return { result: { which: "error", error: toWireSbxError(error) } };
      }
    },
    run: async (params, ctx) => {
      state.gate.assertAuthorized();
      if (params.spec.command === "") {
        return {
          result: {
            which: "error",
            error: makeSbxError(
              "invalidArgument",
              "DenoRuntime.run requires SpawnSpec.command to carry the entrypoint path",
            ),
          },
        };
      }
      let process: AgentProcess;
      try {
        const runSpec: AgentDenoRunSpec = {
          entrypoint: params.spec.command,
          scriptArgs: params.spec.args,
          cwd: params.spec.cwd === "" ? undefined : params.spec.cwd,
          env: params.spec.env.length === 0
            ? undefined
            : kvToRecord(params.spec.env),
          stdin: stdioToDomain(params.spec.stdin),
          stdout: stdioToDomain(params.spec.stdout),
          stderr: stdioToDomain(params.spec.stderr),
        };
        process = await deno.run(runSpec);
      } catch (error) {
        return {
          result: {
            which: "error",
            error: toWireSbxError(error, "invalidArgument"),
          },
        };
      }
      const pointer = wire.DenoProcess.registerServer(
        contextRegistry(ctx),
        new DenoProcessWire(state, options, process),
      );
      startOutputPumps(state, options, process, params.output);
      return {
        result: {
          which: "process",
          process: asStub<wire.DenoProcess>(pointer),
        },
      };
    },
  };
}

function sandboxAgentServer(
  state: ConnectionState,
  options: AgentWireOptions,
): wire.SandboxAgentServer {
  return {
    processes: (_params, ctx) => {
      state.gate.assertAuthorized();
      const pointer = wire.registerProcessSpawnerServer(
        contextRegistry(ctx),
        processSpawnerServer(state, options),
      );
      return { service: asStub<wire.ProcessSpawner>(pointer) };
    },
    filesystem: (_params, ctx) => {
      state.gate.assertAuthorized();
      const pointer = wire.registerFileSystemServer(
        contextRegistry(ctx),
        fileSystemServer(state, options),
      );
      return { service: asStub<wire.FileSystem>(pointer) };
    },
    environment: (_params, ctx) => {
      state.gate.assertAuthorized();
      const pointer = wire.registerEnvironmentServer(
        contextRegistry(ctx),
        environmentServer(state, options),
      );
      return { service: asStub<wire.Environment>(pointer) };
    },
    deno: (_params, ctx) => {
      state.gate.assertAuthorized();
      const pointer = wire.registerDenoRuntimeServer(
        contextRegistry(ctx),
        denoRuntimeServer(state, options),
      );
      return { service: asStub<wire.DenoRuntime>(pointer) };
    },
    http: (_params, _ctx) => {
      state.gate.assertAuthorized();
      // DEFERRED (M8): the HttpClient egress plane. The schema result
      // carries no error union, so the deferral crosses as a typed RPC
      // exception rather than a silent null capability.
      throw new AgentError(
        "SBX_AGENT_UNSUPPORTED",
        "SandboxAgent.http (the HttpClient egress plane) is deferred to M8",
      );
    },
    ping: (params, _ctx) => {
      state.gate.assertAuthorized();
      return { nonce: params.nonce };
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap (negotiate -> authenticate -> agent)
// ---------------------------------------------------------------------------

/** Configuration for one served agent-plane connection. */
export interface AgentWireOptions {
  /** The domain core every handler delegates to. */
  readonly api: AgentApi;
  /** Local contract identity ({@linkcode m3AgentContractIdentity}). */
  readonly identity: ContractIdentity;
  /**
   * Shared credential presented by `authenticate` (the guest agent's
   * token, from its boot config). `null` fails every authentication
   * closed — the plane is unusable without a credential.
   */
  readonly credential: Uint8Array | null;
  /** When set, `authenticate.sandboxId` must match (constant-time). */
  readonly expectedSandboxId?: string;
  /** When set, `authenticate.bootNonce` must match (constant-time). */
  readonly expectedBootNonce?: Uint8Array;
  /** Local transport-limit ceiling; defaults to the shared defaults. */
  readonly limitsCeiling?: TransportLimits;
  /** Features the peer must offer; defaults to the agent's own set. */
  readonly requiredPeerFeatureBits?: bigint;
  /** Per-call timeout for agent-originated OutputSink calls. */
  readonly outputCallTimeoutMs?: number;
  /** Authenticated-session TTL for `AuthSession.expiresAtUnixMs`. */
  readonly sessionTtlMs?: number;
  /**
   * Domain-registry release hook for wire `Process.release` (usually
   * `AgentProcesses.release`); when absent, release only drops the
   * capability.
   */
  readonly releaseProcess?: (process: AgentProcess) => void;
}

/** One served connection: the bootstrap root plus its teardown. */
export interface AgentWireConnection {
  /**
   * Low-level generated `AgentBootstrap` dispatch implementation;
   * register as the connection's root capability with
   * `wire.registerAgentBootstrapServer` (for example through
   * `RpcServerRuntime.createWithRoot`).
   */
  readonly bootstrap: wire.AgentBootstrapServer;
  /** Bootstrap gate phase, for diagnostics. */
  readonly phase: BootstrapPhase;
  /**
   * Connection teardown: closes the gate and every connection-scoped
   * resource (repl sessions, open files, unfinished uploads). Spawned
   * processes keep running (wire release semantics) until the agent
   * itself shuts down.
   */
  close(): Promise<void>;
}

function credentialAccepted(
  options: AgentWireOptions,
  params: wire.AuthenticateParams,
): boolean {
  const expected = options.credential;
  if (expected === null || expected.byteLength === 0) return false;
  let accepted = timingSafeEqual(params.credential, expected);
  if (options.expectedSandboxId !== undefined) {
    accepted = timingSafeEqual(
      textEncoder.encode(params.sandboxId),
      textEncoder.encode(options.expectedSandboxId),
    ) && accepted;
  }
  if (options.expectedBootNonce !== undefined) {
    accepted = timingSafeEqual(params.bootNonce, options.expectedBootNonce) &&
      accepted;
  }
  return accepted;
}

/**
 * Create the wire plane for ONE accepted transport: a fresh
 * {@linkcode BootstrapGate}, the generated `AgentBootstrap` root, and
 * the connection-scoped resource registry behind it.
 */
export function createAgentWireConnection(
  options: AgentWireOptions,
): AgentWireConnection {
  const state = new ConnectionState();
  const policy: NegotiationPolicy = {
    identity: options.identity,
    ceiling: options.limitsCeiling ?? DEFAULT_TRANSPORT_LIMITS,
    requiredPeerFeatureBits: options.requiredPeerFeatureBits ??
      AGENT_PLANE_FEATURES,
  };

  const bootstrap: wire.AgentBootstrapServer = {
    negotiate: (params, _ctx) => {
      try {
        const negotiated = state.gate.acceptNegotiation(
          negotiateProtocol(offerToContract(params.offer), policy),
        );
        return {
          result: {
            which: "accepted",
            accepted: negotiatedToWire(negotiated),
          },
        };
      } catch (error) {
        if (error instanceof BootstrapRejectedError) {
          return {
            result: {
              which: "error",
              error: contractErrorToWire(error.error),
            },
          };
        }
        if (error instanceof BootstrapStateError) {
          return {
            result: {
              which: "error",
              error: makeSbxError("failedPrecondition", error.message),
            },
          };
        }
        throw error;
      }
    },
    authenticate: (params, _ctx) => {
      const verified = credentialAccepted(options, params);
      try {
        state.gate.recordAuthentication(verified);
      } catch (error) {
        if (error instanceof AuthenticationRejectedError) {
          return {
            result: {
              which: "error",
              error: makeSbxError(
                "unauthenticated",
                error.connectionClosed
                  ? "authentication rejected; attempt limit reached"
                  : "authentication rejected",
              ),
            },
          };
        }
        if (error instanceof BootstrapStateError) {
          return {
            result: {
              which: "error",
              error: makeSbxError("failedPrecondition", error.message),
            },
          };
        }
        throw error;
      }
      return {
        result: {
          which: "accepted",
          accepted: {
            sessionId: crypto.getRandomValues(new Uint8Array(16)),
            expiresAtUnixMs: BigInt(
              Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
            ),
          },
        },
      };
    },
    agent: (_params, ctx) => {
      // Fails closed: assertAuthorized throws (and closes the gate) on
      // any phase other than `authenticated`.
      state.gate.assertAuthorized();
      const pointer = wire.registerSandboxAgentServer(
        contextRegistry(ctx),
        sandboxAgentServer(state, options),
      );
      return { agent: asStub<wire.SandboxAgent>(pointer) };
    },
  };

  return {
    bootstrap,
    get phase(): BootstrapPhase {
      return state.gate.phase;
    },
    async close(): Promise<void> {
      state.gate.close();
      await state.closeResources();
    },
  };
}

// ---------------------------------------------------------------------------
// Transport serving (WASM session runtime)
// ---------------------------------------------------------------------------

/** One agent-plane session bound to a started transport. */
export interface AgentWireServer {
  /** The served connection (gate phase, resource teardown). */
  readonly connection: AgentWireConnection;
  /** Tear down the session: transport, then connection resources. */
  close(): Promise<void>;
}

/**
 * Serve one agent-plane connection over `transport` with
 * `RpcServerRuntime.createWithRoot`: the WASM session core owns the
 * protocol state machine, the generated `AgentBootstrap` root sits at
 * capability index 0, and every capability this plane mints in call
 * results (`SandboxAgent`/`ProcessSpawner`/`Process`/...) is exported
 * wire-managed through the call context (see {@linkcode contextRegistry}).
 *
 * HISTORY: through capnp 0.2.0 this function hand-rolled a pure-JS
 * `RpcServerBridge` server, because the 0.2.0 WASM session core
 * rejected `Return` frames naming freshly host-minted exports
 * (`UnknownExport`, swallowed — every `agent()` call hung silently).
 * capnp 0.3.0 relays host-minted exports and wire-manages their
 * refcounts, so the runtime path serves the whole capability graph;
 * `tests/fake/agent/agent_wire_test.ts` proves it end-to-end.
 *
 * Dispatch ordering: the runtime pumps host calls in arrival order and
 * the generated per-capability serialization chains keep inbound
 * `-> stream` calls sequential (`tests/unit/capnp/
 * runtime_qualification_test.ts` pins dense sequences with exactly one
 * active chunk handler). Long-running calls (`Process.wait`, repl
 * eval) do not head-of-line block the connection; response frames may
 * interleave out of call order, which the protocol permits.
 *
 * Outbound calls (the `OutputSink` pumps) ride the runtime's
 * intercepted outbound client: Call frames go straight to the wire and
 * their Returns never reach the WASM peer, which has no knowledge of
 * server-originated questions.
 *
 * CLIENT CONTRACT (capnp 0.3.0 — pinned by the agent-plane suite):
 * - Calls whose results carry a capability must finish with
 *   `releaseResultCaps: false`; the generated stubs' finish default
 *   eagerly releases the wire-managed export before its first use.
 * - An `OutputSink` passed to `spawn`/`run` must be exported with one
 *   EXTRA reference: the WASM relay drops its param-cap import (one
 *   Release frame) when the originating call returns — it cannot yet
 *   signal that this plane retains the sink for pumping.
 * Both are upstream wasm-relay/stub gaps, not schema semantics; drop
 * the workarounds when capnp-deno grows result-cap-aware finish
 * defaults and host-call param-cap retention.
 *
 * The caller owns the transport lifecycle (`onClose`/`onError` wiring
 * per the M1 close-ownership contract) and calls
 * {@linkcode AgentWireServer.close} on teardown.
 */
export async function serveAgentWireTransport(
  transport: RpcTransport,
  options: AgentWireOptions & {
    /** Sink for per-frame protocol/dispatch faults (default: drop). */
    readonly onError?: (error: unknown) => void;
  },
): Promise<AgentWireServer> {
  const connection = createAgentWireConnection(options);
  const onError = options.onError ?? ((): void => {});
  const runtime = await RpcServerRuntime.createWithRoot(
    transport,
    wire.registerAgentBootstrapServer,
    connection.bootstrap,
    {
      bridgeOptions: {
        // Without this hook an async dispatch-response failure is
        // swallowed and the caller hangs invisibly. Surface it.
        onUnhandledError: (error) => onError(error),
      },
    },
  );

  let closed = false;
  return {
    connection,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await runtime.close();
      } catch {
        // Transport already closed.
      }
      await connection.close();
    },
  };
}
