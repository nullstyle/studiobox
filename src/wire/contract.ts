/** Binding-independent protocol negotiation and hostile-boundary validation. */

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const SHA256_BYTES = 32;

export const FEATURE = Object.freeze({
  typedErrors: 1n << 0n,
  boundedStreams: 1n << 1n,
  durableLeases: 1n << 2n,
  rawAgentTunnel: 1n << 3n,
  rootSupervisor: 1n << 4n,
  httpExposure: 1n << 5n,
});

export type FeatureBit = (typeof FEATURE)[keyof typeof FEATURE];

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export interface ContractIdentity {
  readonly protocol: ProtocolVersion;
  readonly featureBits: bigint;
  readonly schemaHash: Uint8Array;
  readonly capnpDenoVersion: string;
  readonly wasmAbi: number;
  readonly wasmSha256: Uint8Array;
  readonly buildId: string;
  readonly artifactHash: Uint8Array;
  readonly firecrackerPackage: string;
  readonly firecrackerSha256: Uint8Array;
  readonly firecrackerPinned: string;
  readonly firecrackerMin: string;
}

export interface TransportLimits {
  readonly maxFrameBytes: number;
  readonly maxSegments: number;
  readonly maxNestingDepth: number;
  readonly maxTraversalWords: number;
  readonly maxQueuedFrames: number;
  readonly maxQueuedBytes: number;
  readonly maxInFlightCalls: number;
  readonly maxExports: number;
  readonly maxCompletedAnswers: number;
  readonly maxChunkBytes: number;
  readonly maxChunksInFlight: number;
}

export const DEFAULT_TRANSPORT_LIMITS: Readonly<TransportLimits> = Object
  .freeze(
    {
      maxFrameBytes: 1024 * 1024,
      maxSegments: 64,
      maxNestingDepth: 32,
      maxTraversalWords: 128 * 1024,
      maxQueuedFrames: 32,
      maxQueuedBytes: 4 * 1024 * 1024,
      maxInFlightCalls: 128,
      maxExports: 1024,
      maxCompletedAnswers: 1024,
      maxChunkBytes: 64 * 1024,
      maxChunksInFlight: 4,
    },
  );

export interface ProtocolOffer {
  readonly identity: ContractIdentity;
  readonly limits: TransportLimits;
  readonly requiredFeatureBits: bigint;
}

export interface NegotiatedContract {
  readonly identity: ContractIdentity;
  readonly limits: TransportLimits;
  readonly selectedFeatureBits: bigint;
}

export type SbxErrorCode =
  | "unknown"
  | "invalidArgument"
  | "unauthenticated"
  | "permissionDenied"
  | "notFound"
  | "alreadyExists"
  | "failedPrecondition"
  | "resourceExhausted"
  | "aborted"
  | "deadlineExceeded"
  | "unavailable"
  | "internal"
  | "incompatibleProtocol"
  | "incompatibleSchema"
  | "incompatibleRuntime"
  | "hostCapacity"
  | "sandboxTerminated"
  | "unsupportedFeature"
  | "conflict"
  | "cleanupIncomplete";

export interface SbxError {
  readonly code: SbxErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly operationId: string;
  readonly sandboxId: string;
  readonly details: Readonly<Record<string, string>>;
}

export interface KnownSchemaPair {
  /** The hash offered by the remote peer. */
  readonly remoteSchemaHash: Uint8Array;
  /** The local schema hash accepting that peer. */
  readonly localSchemaHash: Uint8Array;
  /** Features that make the additive difference safe to use. */
  readonly requiredFeatureBits: bigint;
}

export interface KnownRuntimePair {
  readonly remoteVersion: string;
  readonly remoteWasmAbi: number;
  readonly remoteWasmSha256: Uint8Array;
}

export interface NegotiationPolicy {
  readonly identity: ContractIdentity;
  readonly ceiling?: TransportLimits;
  readonly requiredPeerFeatureBits?: bigint;
  readonly knownSchemaPairs?: readonly KnownSchemaPair[];
  readonly knownRuntimePairs?: readonly KnownRuntimePair[];
}

export type NegotiationResult =
  | { readonly ok: true; readonly value: NegotiatedContract }
  | { readonly ok: false; readonly error: SbxError };

export class WireValidationError extends Error {
  override readonly name = "WireValidationError";

  constructor(message: string) {
    super(message);
  }
}

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;
const textEncoder = new TextEncoder();

export function validateContractIdentity(identity: ContractIdentity): void {
  assertUnsignedInteger(identity.protocol.major, UINT16_MAX, "protocol.major");
  assertUnsignedInteger(identity.protocol.minor, UINT16_MAX, "protocol.minor");
  assertUInt64(identity.featureBits, "featureBits");
  assertDigest(identity.schemaHash, "schemaHash");
  assertBoundedText(identity.capnpDenoVersion, 1, 64, "capnpDenoVersion");
  assertUnsignedInteger(identity.wasmAbi, UINT32_MAX, "wasmAbi");
  assertDigest(identity.wasmSha256, "wasmSha256");
  assertBoundedText(identity.buildId, 1, 128, "buildId");
  assertDigest(identity.artifactHash, "artifactHash");
  assertBoundedText(identity.firecrackerPackage, 1, 128, "firecrackerPackage");
  assertDigest(identity.firecrackerSha256, "firecrackerSha256");
  assertBoundedText(identity.firecrackerPinned, 1, 32, "firecrackerPinned");
  assertBoundedText(identity.firecrackerMin, 1, 32, "firecrackerMin");
}

export function validateTransportLimits(limits: TransportLimits): void {
  assertPositiveInteger(limits.maxFrameBytes, UINT32_MAX, "maxFrameBytes");
  assertPositiveInteger(limits.maxSegments, UINT16_MAX, "maxSegments");
  assertPositiveInteger(
    limits.maxNestingDepth,
    UINT16_MAX,
    "maxNestingDepth",
  );
  assertPositiveSafeInteger(limits.maxTraversalWords, "maxTraversalWords");
  assertPositiveInteger(limits.maxQueuedFrames, UINT16_MAX, "maxQueuedFrames");
  assertPositiveInteger(limits.maxQueuedBytes, UINT32_MAX, "maxQueuedBytes");
  assertPositiveInteger(
    limits.maxInFlightCalls,
    UINT16_MAX,
    "maxInFlightCalls",
  );
  assertPositiveInteger(limits.maxExports, UINT16_MAX, "maxExports");
  assertPositiveInteger(
    limits.maxCompletedAnswers,
    UINT16_MAX,
    "maxCompletedAnswers",
  );
  assertPositiveInteger(limits.maxChunkBytes, UINT32_MAX, "maxChunkBytes");
  assertPositiveInteger(
    limits.maxChunksInFlight,
    UINT16_MAX,
    "maxChunksInFlight",
  );

  if (limits.maxChunkBytes > limits.maxFrameBytes) {
    throw new WireValidationError(
      "maxChunkBytes must not exceed maxFrameBytes",
    );
  }
  if (limits.maxQueuedBytes < limits.maxFrameBytes) {
    throw new WireValidationError(
      "maxQueuedBytes must hold at least one maximum-sized frame",
    );
  }
  if (limits.maxChunksInFlight > limits.maxInFlightCalls) {
    throw new WireValidationError(
      "maxChunksInFlight must not exceed maxInFlightCalls",
    );
  }
}

export function negotiateProtocol(
  offer: ProtocolOffer,
  policy: NegotiationPolicy,
): NegotiationResult {
  try {
    validateContractIdentity(offer.identity);
    validateContractIdentity(policy.identity);
    validateTransportLimits(offer.limits);
    validateTransportLimits(policy.ceiling ?? DEFAULT_TRANSPORT_LIMITS);
    assertUInt64(offer.requiredFeatureBits, "requiredFeatureBits");
    assertUInt64(
      policy.requiredPeerFeatureBits ?? 0n,
      "requiredPeerFeatureBits",
    );
  } catch (error) {
    return rejected(
      "invalidArgument",
      error instanceof Error ? error.message : "invalid protocol offer",
    );
  }

  const remote = offer.identity;
  const local = policy.identity;
  if (remote.protocol.major !== local.protocol.major) {
    return rejected(
      "incompatibleProtocol",
      `protocol major ${remote.protocol.major} is incompatible with ${local.protocol.major}`,
    );
  }

  const selectedFeatures = remote.featureBits & local.featureBits;
  if (
    (offer.requiredFeatureBits & selectedFeatures) !== offer.requiredFeatureBits
  ) {
    return rejected(
      "unsupportedFeature",
      "required peer features are unavailable",
    );
  }
  const requiredPeer = policy.requiredPeerFeatureBits ?? 0n;
  if ((requiredPeer & selectedFeatures) !== requiredPeer) {
    return rejected(
      "unsupportedFeature",
      "required local features are unavailable",
    );
  }

  if (!runtimeCompatible(remote, local, policy.knownRuntimePairs ?? [])) {
    return rejected(
      "incompatibleRuntime",
      "capnp-deno version, WASM ABI, or WASM hash is incompatible",
    );
  }

  if (
    !schemaCompatible(
      remote,
      local,
      selectedFeatures,
      policy.knownSchemaPairs ?? [],
    )
  ) {
    return rejected(
      "incompatibleSchema",
      "schema hash is not an admitted contract",
    );
  }

  if (
    !timingSafeEqual(remote.artifactHash, local.artifactHash) ||
    remote.firecrackerPackage !== local.firecrackerPackage ||
    !timingSafeEqual(remote.firecrackerSha256, local.firecrackerSha256) ||
    remote.firecrackerPinned !== local.firecrackerPinned ||
    remote.firecrackerMin !== local.firecrackerMin
  ) {
    return rejected(
      "incompatibleRuntime",
      "artifact or Firecracker compatibility identity differs",
    );
  }

  const selectedMinor = Math.min(remote.protocol.minor, local.protocol.minor);
  const limits = intersectLimits(
    offer.limits,
    policy.ceiling ?? DEFAULT_TRANSPORT_LIMITS,
  );

  return {
    ok: true,
    value: {
      identity: cloneIdentity({
        ...local,
        protocol: { major: local.protocol.major, minor: selectedMinor },
        featureBits: selectedFeatures,
      }),
      limits,
      selectedFeatureBits: selectedFeatures,
    },
  };
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function assertDigest(value: Uint8Array, field: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== SHA256_BYTES) {
    throw new WireValidationError(
      `${field} must be exactly ${SHA256_BYTES} bytes`,
    );
  }
}

export function assertBoundedText(
  value: string,
  minBytes: number,
  maxBytes: number,
  field: string,
): void {
  if (typeof value !== "string") {
    throw new WireValidationError(`${field} must be text`);
  }
  const size = textEncoder.encode(value).byteLength;
  if (size < minBytes || size > maxBytes || containsAsciiControl(value)) {
    throw new WireValidationError(
      `${field} must be ${minBytes}..${maxBytes} UTF-8 bytes without control characters`,
    );
  }
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function schemaCompatible(
  remote: ContractIdentity,
  local: ContractIdentity,
  selectedFeatures: bigint,
  pairs: readonly KnownSchemaPair[],
): boolean {
  if (timingSafeEqual(remote.schemaHash, local.schemaHash)) return true;
  return pairs.some((pair) =>
    timingSafeEqual(remote.schemaHash, pair.remoteSchemaHash) &&
    timingSafeEqual(local.schemaHash, pair.localSchemaHash) &&
    (pair.requiredFeatureBits & selectedFeatures) === pair.requiredFeatureBits
  );
}

function runtimeCompatible(
  remote: ContractIdentity,
  local: ContractIdentity,
  pairs: readonly KnownRuntimePair[],
): boolean {
  if (
    remote.capnpDenoVersion === local.capnpDenoVersion &&
    remote.wasmAbi === local.wasmAbi &&
    timingSafeEqual(remote.wasmSha256, local.wasmSha256)
  ) {
    return true;
  }
  return pairs.some((pair) =>
    pair.remoteVersion === remote.capnpDenoVersion &&
    pair.remoteWasmAbi === remote.wasmAbi &&
    timingSafeEqual(pair.remoteWasmSha256, remote.wasmSha256)
  );
}

function intersectLimits(
  offered: TransportLimits,
  ceiling: TransportLimits,
): TransportLimits {
  return Object.freeze({
    maxFrameBytes: Math.min(offered.maxFrameBytes, ceiling.maxFrameBytes),
    maxSegments: Math.min(offered.maxSegments, ceiling.maxSegments),
    maxNestingDepth: Math.min(
      offered.maxNestingDepth,
      ceiling.maxNestingDepth,
    ),
    maxTraversalWords: Math.min(
      offered.maxTraversalWords,
      ceiling.maxTraversalWords,
    ),
    maxQueuedFrames: Math.min(
      offered.maxQueuedFrames,
      ceiling.maxQueuedFrames,
    ),
    maxQueuedBytes: Math.min(offered.maxQueuedBytes, ceiling.maxQueuedBytes),
    maxInFlightCalls: Math.min(
      offered.maxInFlightCalls,
      ceiling.maxInFlightCalls,
    ),
    maxExports: Math.min(offered.maxExports, ceiling.maxExports),
    maxCompletedAnswers: Math.min(
      offered.maxCompletedAnswers,
      ceiling.maxCompletedAnswers,
    ),
    maxChunkBytes: Math.min(offered.maxChunkBytes, ceiling.maxChunkBytes),
    maxChunksInFlight: Math.min(
      offered.maxChunksInFlight,
      ceiling.maxChunksInFlight,
    ),
  });
}

function cloneIdentity(identity: ContractIdentity): ContractIdentity {
  return Object.freeze({
    ...identity,
    protocol: Object.freeze({ ...identity.protocol }),
    schemaHash: identity.schemaHash.slice(),
    wasmSha256: identity.wasmSha256.slice(),
    artifactHash: identity.artifactHash.slice(),
    firecrackerSha256: identity.firecrackerSha256.slice(),
  });
}

function rejected(code: SbxErrorCode, message: string): NegotiationResult {
  return {
    ok: false,
    error: Object.freeze({
      code,
      message: message.slice(0, 512),
      retryable: false,
      operationId: "",
      sandboxId: "",
      details: Object.freeze({}),
    }),
  };
}

function assertUnsignedInteger(
  value: number,
  max: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new WireValidationError(
      `${field} must be an unsigned integer <= ${max}`,
    );
  }
}

function assertPositiveInteger(
  value: number,
  max: number,
  field: string,
): void {
  assertUnsignedInteger(value, max, field);
  if (value === 0) throw new WireValidationError(`${field} must be positive`);
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WireValidationError(`${field} must be a positive safe integer`);
  }
}

function assertUInt64(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new WireValidationError(`${field} must fit UInt64`);
  }
}
