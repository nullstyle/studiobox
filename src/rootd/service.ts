/**
 * The studiobox-rootd capnp WIRE adapter — `schema/supervisor.capnp`'s
 * `SupervisorBootstrap` + `Supervisor` services as a thin layer over the
 * {@linkcode SupervisorApi} domain core (DESIGN.md §3/§4, PLAN M2-wire).
 *
 * Layering contract (mirrors `supervisor_core_api.ts`):
 *
 * - every RPC method decodes its request via the GENERATED codecs (the
 *   generated dispatch does that), runs the plain `src/wire/supervisor.ts`
 *   validators BEFORE touching the core, delegates to the same-named
 *   {@linkcode SupervisorApi} method, and encodes the result union — no
 *   domain logic lives here;
 * - thrown {@linkcode SupervisorError} / `FirecrackerAdapterError` /
 *   {@linkcode WireValidationError} values map onto the schema's `SbxError`
 *   arms via {@linkcode supervisorFaultToWire};
 * - the connection lifecycle is the fail-closed
 *   `connected → negotiated → authenticated → closed` gate from
 *   `src/wire/bootstrap_gate.ts`: `negotiate` runs
 *   {@linkcode negotiateProtocol} against a {@linkcode ContractIdentity}
 *   carrying the real schema-bundle hash from `compat/wire.json` plus the
 *   capnp runtime identity ({@linkcode buildSupervisorContractIdentity}),
 *   `authenticate` compares the 32-byte credential in constant time and is
 *   rate-limited by the gate, and the `Supervisor` capability (plus every
 *   method on it, defense in depth) refuses until `authenticated`.
 *
 * One {@linkcode createSupervisorWireConnection} instance serves exactly one
 * transport: the gate is connection-local state. The accept loop that pairs
 * each accepted UDS transport with a fresh connection lives in
 * `src/rootd/main.ts`.
 *
 * ## Capability handout (capnp 0.3.0)
 *
 * `SupervisorBootstrap.supervisor @2` returns a FRESH `Supervisor`
 * capability per call, exported wire-managed through the call context by
 * the generated service wrapper — the schema's intended shape. Releasing a
 * handed-out stub drops only that export; the bootstrap root and later
 * handouts are unaffected. Every `Supervisor` method still re-asserts the
 * bootstrap gate server-side (defense in depth), so a stub outlives its
 * usefulness the moment the gate closes.
 *
 * HISTORY: through capnp 0.2.0 the `Supervisor` interface instead rode as a
 * FACET of the root bootstrap capability (a merged dispatch accepting both
 * interface ids, with `supervisor @2` returning the root pointer), because
 * the 0.2.0 WASM session core rejected Return frames naming freshly
 * host-minted exports — the call would hang. capnp 0.3.0 relays host-minted
 * exports and wire-manages their refcounts, so the merged-root workaround
 * (and its `attachSupervisorCapability` side door) is retired; the agent
 * plane (`src/agent/service.ts`) made the same move.
 *
 * CLIENT CONTRACT (capnp 0.3.0 — pinned by
 * `tests/fake/rootd/supervisor_wire_test.ts`): generated stubs over
 * `RpcWireClient` auto-finish with `releaseResultCaps: true`, which would
 * drop a wire-managed fresh export before first use — clients must call
 * `bootstrap.supervisor()` with `finish: { releaseResultCaps: false }` and
 * release the stub via its lifecycle `close()`. This is an upstream stub
 * default gap, not schema semantics; drop the option when capnp-deno grows
 * result-cap-aware finish defaults on that client path.
 *
 * @module
 */

import type {
  BridgeRequest as WireBridgeRequest,
  Health as WireHealth,
  HealthResults,
  LaunchRequest as WireLaunchRequest,
  LaunchResults,
  MachineStatus as WireMachineStatus,
  MachineUsage as WireMachineUsage,
  OpenBridgeResults,
  ProbeAgentResults,
  ReconcileResults,
  ReconcileSummary as WireReconcileSummary,
  RpcStub,
  StatusResults,
  Supervisor,
  SupervisorBootstrap,
  UsageResults,
} from "../wire/generated/supervisor_types.ts";
import type {
  AuthResult as WireAuthResult,
  ContractIdentity as WireContractIdentity,
  EmptyResult as WireEmptyResult,
  ErrorCode as WireErrorCode,
  HandshakeResult as WireHandshakeResult,
  NegotiatedContract as WireNegotiatedContract,
  ProtocolOffer as WireProtocolOffer,
  SbxError as WireSbxError,
  TransportLimits as WireTransportLimits,
} from "../wire/generated/common_types.ts";
import {
  type ContractIdentity,
  FEATURE,
  type KnownRuntimePair,
  type KnownSchemaPair,
  type NegotiatedContract,
  negotiateProtocol,
  type ProtocolOffer,
  type SbxError,
  timingSafeEqual,
  type TransportLimits,
  validateContractIdentity,
  WireValidationError,
} from "../wire/contract.ts";
import {
  AuthenticationRejectedError,
  BootstrapGate,
  BootstrapRejectedError,
  BootstrapStateError,
} from "../wire/bootstrap_gate.ts";
import {
  validateBridgeRequest,
  validateLaunchRequest,
  validateSupervisorCredential,
} from "../wire/supervisor.ts";
import { FirecrackerAdapterError } from "./firecracker/errors.ts";
import type {
  SupervisorApi,
  SupervisorBridgeGrant,
  SupervisorBridgeRequest,
  SupervisorErrorCode,
  SupervisorHealth,
  SupervisorMachineStatus,
  SupervisorMachineUsage,
  SupervisorReconcileSummary,
} from "./supervisor_core_api.ts";
import { SupervisorError } from "./supervisor_core_api.ts";

/** Feature bits the supervisor plane offers/accepts (DESIGN.md §4). */
export const SUPERVISOR_FEATURE_BITS: bigint = FEATURE.typedErrors |
  FEATURE.boundedStreams |
  FEATURE.rootSupervisor;

const MAX_ERROR_MESSAGE_LENGTH = 512;
const SESSION_ID_BYTES = 16;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// Contract identity: compat/wire.json + capnp runtime identity
// ---------------------------------------------------------------------------

/**
 * The subset of `compat/wire.json` the supervisor identity is derived from.
 * `schemaSha256` is the canonical five-schema bundle hash; `codegen.version`
 * pins the published `@nullstyle/capnp` runtime the bindings were generated
 * against.
 */
export interface SupervisorCompatIdentitySource {
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly schemaSha256: string;
  readonly codegen: { readonly version: string };
}

/**
 * Optional overrides for {@linkcode buildSupervisorContractIdentity}. Every
 * digest that lacks a real pin today defaults to a deterministic label
 * digest, so any two peers using this builder against the same
 * `compat/wire.json` produce matching identities. The real pins land later:
 * `artifactHash` with the M4/M5 manifest plumbing, the firecracker
 * package/binary pins with M5, and the WASM ABI/hash when capnp-deno
 * publishes them.
 */
export interface SupervisorIdentityOptions {
  readonly buildId: string;
  readonly featureBits?: bigint;
  readonly wasmAbi?: number;
  readonly wasmSha256?: Uint8Array;
  readonly artifactHash?: Uint8Array;
  readonly firecrackerPackage?: string;
  readonly firecrackerSha256?: Uint8Array;
  readonly firecrackerPinned?: string;
  readonly firecrackerMin?: string;
}

/**
 * Build the supervisor plane's {@linkcode ContractIdentity} from the parsed
 * `compat/wire.json` (the REAL schema bundle hash) plus the capnp runtime
 * identity. See {@linkcode SupervisorIdentityOptions} for the placeholder
 * digest policy.
 */
export async function buildSupervisorContractIdentity(
  compat: SupervisorCompatIdentitySource,
  options: SupervisorIdentityOptions,
): Promise<ContractIdentity> {
  const capnpDenoVersion = compat.codegen.version;
  const firecrackerPackage = options.firecrackerPackage ??
    "@nullstyle/firecracker@^0.2";
  const identity: ContractIdentity = Object.freeze({
    protocol: Object.freeze({
      major: compat.protocol.major,
      minor: compat.protocol.minor,
    }),
    featureBits: options.featureBits ?? SUPERVISOR_FEATURE_BITS,
    schemaHash: hexToBytes(compat.schemaSha256, "schemaSha256"),
    capnpDenoVersion,
    wasmAbi: options.wasmAbi ?? 1,
    wasmSha256: options.wasmSha256 ??
      await sha256Utf8(`@nullstyle/capnp@${capnpDenoVersion}/wasm`),
    buildId: options.buildId,
    artifactHash: options.artifactHash ??
      await sha256Utf8("studiobox-artifact:unpinned"),
    firecrackerPackage,
    firecrackerSha256: options.firecrackerSha256 ??
      await sha256Utf8(firecrackerPackage),
    firecrackerPinned: options.firecrackerPinned ?? "unpinned",
    firecrackerMin: options.firecrackerMin ?? "unpinned",
  });
  validateContractIdentity(identity);
  return identity;
}

function hexToBytes(hex: string, field: string): Uint8Array {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/u.test(hex)) {
    throw new WireValidationError(
      `${field} must be 64 hexadecimal characters`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Utf8(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return new Uint8Array(digest);
}

// ---------------------------------------------------------------------------
// contract.ts <-> generated common.capnp conversions
// ---------------------------------------------------------------------------

/** Encode a validated local identity for the wire. */
export function contractIdentityToWire(
  identity: ContractIdentity,
): WireContractIdentity {
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

/**
 * Decode a peer identity from the wire. Shape-only: semantic validation is
 * {@linkcode negotiateProtocol}'s job.
 */
export function contractIdentityFromWire(
  value: WireContractIdentity,
): ContractIdentity {
  return {
    protocol: { major: value.protocol.major, minor: value.protocol.minor },
    featureBits: value.featureBits,
    schemaHash: value.schemaHash,
    capnpDenoVersion: value.capnpDenoVersion,
    wasmAbi: value.wasmAbi,
    wasmSha256: value.wasmSha256,
    buildId: value.buildId,
    artifactHash: value.artifactHash,
    firecrackerPackage: value.firecrackerPackage,
    firecrackerSha256: value.firecrackerSha256,
    firecrackerPinned: value.firecrackerPinned,
    firecrackerMin: value.firecrackerMin,
  };
}

/** Encode transport limits for the wire (`maxTraversalWords` widens). */
export function transportLimitsToWire(
  limits: TransportLimits,
): WireTransportLimits {
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

/** Decode peer transport limits (hostile boundary: bounded narrowing). */
export function transportLimitsFromWire(
  value: WireTransportLimits,
): TransportLimits {
  return {
    maxFrameBytes: value.maxFrameBytes,
    maxSegments: value.maxSegments,
    maxNestingDepth: value.maxNestingDepth,
    maxTraversalWords: bigintToSafeNumber(
      value.maxTraversalWords,
      "maxTraversalWords",
    ),
    maxQueuedFrames: value.maxQueuedFrames,
    maxQueuedBytes: value.maxQueuedBytes,
    maxInFlightCalls: value.maxInFlightCalls,
    maxExports: value.maxExports,
    maxCompletedAnswers: value.maxCompletedAnswers,
    maxChunkBytes: value.maxChunkBytes,
    maxChunksInFlight: value.maxChunksInFlight,
  };
}

/** Encode a local {@linkcode ProtocolOffer} for `negotiate` (client side). */
export function protocolOfferToWire(offer: ProtocolOffer): WireProtocolOffer {
  return {
    identity: contractIdentityToWire(offer.identity),
    limits: transportLimitsToWire(offer.limits),
    requiredFeatureBits: offer.requiredFeatureBits,
  };
}

function protocolOfferFromWire(value: WireProtocolOffer): ProtocolOffer {
  return {
    identity: contractIdentityFromWire(value.identity),
    limits: transportLimitsFromWire(value.limits),
    requiredFeatureBits: value.requiredFeatureBits,
  };
}

function negotiatedContractToWire(
  value: NegotiatedContract,
): WireNegotiatedContract {
  return {
    identity: contractIdentityToWire(value.identity),
    limits: transportLimitsToWire(value.limits),
    selectedFeatureBits: value.selectedFeatureBits,
  };
}

function bigintToSafeNumber(value: bigint, field: string): number {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SAFE_BIGINT) {
    throw new WireValidationError(
      `${field} must be an unsigned safe integer`,
    );
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// Fault mapping: domain errors -> SbxError
// ---------------------------------------------------------------------------

const SUPERVISOR_CODE_MAP: Readonly<
  Record<SupervisorErrorCode, { code: WireErrorCode; retryable: boolean }>
> = Object.freeze({
  SBX_SUP_VALIDATION: { code: "invalidArgument", retryable: false },
  SBX_SUP_DUPLICATE: { code: "alreadyExists", retryable: false },
  SBX_SUP_NOT_FOUND: { code: "notFound", retryable: false },
  SBX_SUP_STATE: { code: "failedPrecondition", retryable: false },
  SBX_SUP_STALE: { code: "conflict", retryable: false },
  SBX_SUP_UNAVAILABLE: { code: "unavailable", retryable: true },
});

const FIRECRACKER_CODE_MAP: Readonly<Record<string, WireErrorCode>> = Object
  .freeze({
    SBX_FC_TIMEOUT: "deadlineExceeded",
    SBX_FC_CLEANUP: "cleanupIncomplete",
    SBX_FC_VMM_EXITED: "sandboxTerminated",
    SBX_FC_EXECUTION_CONFLICT: "conflict",
    SBX_FC_STATE: "failedPrecondition",
  });

function wireError(
  code: WireErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    operationId?: string;
    sandboxId?: string;
    details?: ReadonlyArray<{ key: string; value: string }>;
  } = {},
): WireSbxError {
  return {
    code,
    message: truncateMessage(message),
    retryable: options.retryable ?? false,
    operationId: options.operationId ?? "",
    sandboxId: options.sandboxId ?? "",
    details: (options.details ?? []).map((entry) => ({ ...entry })),
  };
}

/** Convert a `contract.ts` `SbxError` (negotiation) to its wire twin. */
function contractErrorToWire(error: SbxError): WireSbxError {
  return wireError(error.code, error.message, {
    retryable: error.retryable,
    operationId: error.operationId,
    sandboxId: error.sandboxId,
    details: Object.entries(error.details).map(([key, value]) => ({
      key,
      value,
    })),
  });
}

/**
 * Map one adapter-layer fault onto the schema's `SbxError`. Domain errors
 * carry redacted, logical-id-only messages by contract, so their text rides
 * through (bounded); anything unrecognized is fully redacted to a generic
 * internal failure.
 */
export function supervisorFaultToWire(error: unknown): WireSbxError {
  if (error instanceof SupervisorError) {
    const mapped = SUPERVISOR_CODE_MAP[error.code];
    return wireError(mapped.code, error.message, {
      retryable: mapped.retryable,
      details: [{ key: "supervisorCode", value: error.code }],
    });
  }
  if (error instanceof FirecrackerAdapterError) {
    return wireError(
      FIRECRACKER_CODE_MAP[error.code] ?? "internal",
      error.message,
      {
        retryable: error.retryable,
        details: [{ key: "firecrackerCode", value: error.code }],
      },
    );
  }
  if (error instanceof WireValidationError) {
    return wireError("invalidArgument", error.message);
  }
  if (error instanceof BootstrapStateError) {
    return wireError("permissionDenied", error.message);
  }
  return wireError("internal", "internal supervisor failure");
}

function truncateMessage(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : text;
}

// ---------------------------------------------------------------------------
// Domain -> generated supervisor.capnp conversions
// ---------------------------------------------------------------------------

function machineStatusToWire(
  status: SupervisorMachineStatus,
): WireMachineStatus {
  return {
    sandboxId: status.sandboxId,
    executionId: status.executionId,
    state: status.state,
    pid: status.pid ?? 0,
    exitCode: status.exitCode ?? 0,
    exitedAtUnixMs: BigInt(status.exitedAtUnixMs ?? 0),
    reason: status.reason ?? "",
  };
}

function machineUsageToWire(usage: SupervisorMachineUsage): WireMachineUsage {
  return {
    cpuTimeMicros: BigInt(usage.cpuTimeMicros),
    memoryCurrentBytes: BigInt(usage.memoryCurrentBytes),
    memoryPeakBytes: BigInt(usage.memoryPeakBytes),
    diskBytes: BigInt(usage.diskBytes),
    rxBytes: BigInt(usage.rxBytes),
    txBytes: BigInt(usage.txBytes),
  };
}

function healthToWire(health: SupervisorHealth): WireHealth {
  return {
    buildId: health.buildId,
    startedAtUnixMs: BigInt(health.startedAtUnixMs),
    activeMachines: health.activeMachines,
    activeBridges: health.activeBridges,
    reconciling: health.reconciling,
  };
}

function reconcileSummaryToWire(
  summary: SupervisorReconcileSummary,
): WireReconcileSummary {
  return {
    examined: summary.examined,
    killed: summary.killed,
    reclaimed: summary.reclaimed,
    quarantined: summary.quarantined,
    failures: summary.failures.map((failure) =>
      wireError("internal", failure.detail, {
        sandboxId: failure.sandboxId ?? "",
        operationId: failure.executionId ?? "",
      })
    ),
  };
}

function bridgeGrantToWire(grant: SupervisorBridgeGrant): {
  bridgeId: string;
  socketPath: string;
  bridgeCredential: Uint8Array;
  agentCredential: Uint8Array;
  expiresAtUnixMs: bigint;
} {
  return {
    bridgeId: grant.bridgeId,
    socketPath: grant.socketPath,
    bridgeCredential: grant.bridgeCredential.slice(),
    agentCredential: grant.agentCredential.slice(),
    expiresAtUnixMs: BigInt(grant.expiresAtUnixMs),
  };
}

function launchRequestFromWire(value: WireLaunchRequest): WireLaunchRequest {
  // The wire and domain launch shapes are field-identical; re-projecting to
  // exactly the schema fields keeps the validator's exact-keys check honest
  // against decoder shape drift.
  return {
    sandboxId: value.sandboxId,
    executionId: value.executionId,
    artifactId: value.artifactId,
    allocationId: value.allocationId,
    bootNonce: value.bootNonce,
    idempotencyKey: value.idempotencyKey,
  };
}

function bridgeRequestFromWire(
  value: WireBridgeRequest,
): SupervisorBridgeRequest {
  return {
    sandboxId: value.sandboxId,
    executionId: value.executionId,
    leaseId: value.leaseId,
    leaseGeneration: bigintToSafeNumber(
      value.leaseGeneration,
      "leaseGeneration",
    ),
    tunnelNonce: value.tunnelNonce,
    expiresAtUnixMs: bigintToSafeNumber(
      value.expiresAtUnixMs,
      "expiresAtUnixMs",
    ),
  };
}

/**
 * Bounded pre-core check for bare execution-id parameters. The strict
 * logical-id pattern is enforced by the core (`SBX_SUP_VALIDATION`); this
 * refuses unbounded/garbage text at the wire boundary first.
 */
function requireBoundedExecutionId(executionId: string): string {
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    executionId.length > 64
  ) {
    throw new WireValidationError(
      "executionId must be 1..64 characters",
    );
  }
  return executionId;
}

// ---------------------------------------------------------------------------
// The wire services
// ---------------------------------------------------------------------------

/** Configuration shared by every supervisor wire connection. */
export interface SupervisorWireOptions {
  /** The domain core every RPC method delegates to. */
  readonly api: SupervisorApi;
  /** The local identity offered/enforced during negotiation. */
  readonly identity: ContractIdentity;
  /** The expected 32-byte bootstrap credential (constant-time compared). */
  readonly credential: Uint8Array;
  /** Feature bits the peer must support (defaults to the plane's own). */
  readonly requiredPeerFeatureBits?: bigint;
  /** Local transport-limit ceiling (defaults to the shared defaults). */
  readonly limitsCeiling?: TransportLimits;
  /** Admitted cross-version schema pairs (two-minor compat policy). */
  readonly knownSchemaPairs?: readonly KnownSchemaPair[];
  /** Admitted cross-version runtime pairs. */
  readonly knownRuntimePairs?: readonly KnownRuntimePair[];
  /** Auth failure budget before the gate closes (default 3). */
  readonly maxAuthenticationFailures?: number;
}

/**
 * Build the `Supervisor` service for ONE authenticated connection. Every
 * method re-asserts the gate (defense in depth beyond the capability
 * handout), validates at the wire boundary, then delegates to the core.
 */
export function createSupervisorWireAdapter(
  api: SupervisorApi,
  gate: BootstrapGate,
): Supervisor {
  return {
    launch: async (request): Promise<LaunchResults["result"]> => {
      try {
        gate.assertAuthorized();
        const validated = validateLaunchRequest(launchRequestFromWire(request));
        const status = await api.launch(validated);
        return { which: "status", status: machineStatusToWire(status) };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    status: async (executionId): Promise<StatusResults["result"]> => {
      try {
        gate.assertAuthorized();
        const status = await api.status(
          requireBoundedExecutionId(executionId),
        );
        return { which: "status", status: machineStatusToWire(status) };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    usage: async (executionId): Promise<UsageResults["result"]> => {
      try {
        gate.assertAuthorized();
        const usage = await api.usage(requireBoundedExecutionId(executionId));
        return { which: "usage", usage: machineUsageToWire(usage) };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    probeAgent: async (executionId): Promise<ProbeAgentResults["result"]> => {
      try {
        gate.assertAuthorized();
        await api.probeAgent(requireBoundedExecutionId(executionId));
        return { which: "ready" };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    openBridge: async (request): Promise<OpenBridgeResults["result"]> => {
      try {
        gate.assertAuthorized();
        const validated = validateBridgeRequest(bridgeRequestFromWire(request));
        const grant = await api.openBridge(validated);
        return { which: "grant", grant: bridgeGrantToWire(grant) };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    shutdown: async (executionId): Promise<WireEmptyResult> => {
      try {
        gate.assertAuthorized();
        await api.shutdown(requireBoundedExecutionId(executionId));
        return { which: "ok", ok: {} };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    kill: async (executionId): Promise<WireEmptyResult> => {
      try {
        gate.assertAuthorized();
        await api.kill(requireBoundedExecutionId(executionId));
        return { which: "ok", ok: {} };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    reconcile: async (): Promise<ReconcileResults["result"]> => {
      try {
        gate.assertAuthorized();
        const summary = await api.reconcile();
        return { which: "summary", summary: reconcileSummaryToWire(summary) };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    health: async (): Promise<HealthResults["result"]> => {
      try {
        gate.assertAuthorized();
        return { which: "health", health: healthToWire(await api.health()) };
      } catch (error) {
        return { which: "error", error: supervisorFaultToWire(error) };
      }
    },
    ping: async (nonce): Promise<bigint> => {
      // `ping` carries no result union: gate/validation failures surface as
      // typed RPC exceptions instead of an SbxError arm. The `UInt64` nonce
      // rides as `bigint` unchanged — never through a JS number (would
      // corrupt nonces above 2^53).
      gate.assertAuthorized();
      return await api.ping(nonce);
    },
  };
}

/** Everything one accepted transport serves, sharing one gate. */
export interface SupervisorWireConnection {
  /** The bootstrap plane — register as the connection's root capability. */
  readonly bootstrap: SupervisorBootstrap;
  /**
   * The gated Supervisor service `bootstrap.supervisor()` hands out (a
   * fresh wire-managed export per call, all wrapping this one instance).
   */
  readonly supervisor: Supervisor;
  /** Connection-local phase gate (close it when the transport dies). */
  readonly gate: BootstrapGate;
}

/**
 * Build the wire services for ONE transport. The `gate` parameter is
 * exposed so the accept loop can fail the connection closed when its
 * transport dies (`gate.close()`); omit it to let the connection own a
 * private gate.
 */
export function createSupervisorWireConnection(
  options: SupervisorWireOptions,
  gate: BootstrapGate = new BootstrapGate(
    options.maxAuthenticationFailures ?? 3,
  ),
): SupervisorWireConnection {
  validateSupervisorCredential(options.credential);
  const expectedCredential = options.credential.slice();
  const supervisor = createSupervisorWireAdapter(options.api, gate);

  const bootstrap: SupervisorBootstrap = {
    negotiate: (offer): Promise<WireHandshakeResult> => {
      let decoded: ProtocolOffer;
      try {
        decoded = protocolOfferFromWire(offer);
      } catch (error) {
        gate.close();
        return Promise.resolve({
          which: "error",
          error: supervisorFaultToWire(error),
        });
      }
      try {
        const negotiated = gate.acceptNegotiation(
          negotiateProtocol(decoded, {
            identity: options.identity,
            ...(options.limitsCeiling === undefined
              ? {}
              : { ceiling: options.limitsCeiling }),
            requiredPeerFeatureBits: options.requiredPeerFeatureBits ??
              SUPERVISOR_FEATURE_BITS,
            ...(options.knownSchemaPairs === undefined
              ? {}
              : { knownSchemaPairs: options.knownSchemaPairs }),
            ...(options.knownRuntimePairs === undefined
              ? {}
              : { knownRuntimePairs: options.knownRuntimePairs }),
          }),
        );
        return Promise.resolve({
          which: "accepted",
          accepted: negotiatedContractToWire(negotiated),
        });
      } catch (error) {
        if (error instanceof BootstrapRejectedError) {
          return Promise.resolve({
            which: "error",
            error: contractErrorToWire(error.error),
          });
        }
        if (error instanceof BootstrapStateError) {
          return Promise.resolve({
            which: "error",
            error: wireError("failedPrecondition", error.message),
          });
        }
        throw error;
      }
    },

    authenticate: (credential): Promise<WireAuthResult> => {
      // The compare runs unconditionally and in constant time; only the
      // gate decides whether the result may transition the phase.
      let verified = false;
      try {
        validateSupervisorCredential(credential);
        verified = timingSafeEqual(credential, expectedCredential);
      } catch {
        verified = false;
      }
      try {
        gate.recordAuthentication(verified);
      } catch (error) {
        if (error instanceof AuthenticationRejectedError) {
          return Promise.resolve({
            which: "error",
            error: wireError(
              "unauthenticated",
              error.connectionClosed
                ? "authentication failed; the connection is closed"
                : "authentication failed",
              { retryable: !error.connectionClosed },
            ),
          });
        }
        if (error instanceof BootstrapStateError) {
          return Promise.resolve({
            which: "error",
            error: wireError("failedPrecondition", error.message),
          });
        }
        throw error;
      }
      return Promise.resolve({
        which: "accepted",
        accepted: {
          sessionId: crypto.getRandomValues(
            new Uint8Array(SESSION_ID_BYTES),
          ),
          // No wire-level session expiry yet: the session lives exactly as
          // long as the authenticated transport (M6 leases add real TTLs).
          expiresAtUnixMs: 0n,
        },
      });
    },

    supervisor: (): Promise<RpcStub<Supervisor>> => {
      // No error arm on this method: a pre-auth request fails closed as a
      // typed RPC exception and the gate latches shut.
      gate.assertAuthorized();
      // Return the service implementation itself: the generated wrapper
      // exports it through the call context as a FRESH wire-managed
      // capability per call (no `referenceCount` — the Return frame mints
      // the peer's reference and Release frames drain it). Releasing a
      // handout drops only its own export, never the bootstrap root.
      return Promise.resolve(supervisor as unknown as RpcStub<Supervisor>);
    },
  };

  return { bootstrap, supervisor, gate };
}
