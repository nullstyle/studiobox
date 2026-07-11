@0xe15ad398fd2840cf;

# Shared, append-only protocol vocabulary. Size and text bounds are enforced by
# the transport-facing validators before values reach a service implementation.

struct ProtocolVersion {
  major @0 :UInt16;
  minor @1 :UInt16;
}

struct ContractIdentity {
  protocol @0 :ProtocolVersion;
  featureBits @1 :UInt64;
  schemaHash @2 :Data;
  capnpDenoVersion @3 :Text;
  wasmAbi @4 :UInt32;
  wasmSha256 @5 :Data;
  buildId @6 :Text;
  artifactHash @7 :Data;
  firecrackerPackage @8 :Text;
  firecrackerSha256 @9 :Data;
  firecrackerPinned @10 :Text;
  firecrackerMin @11 :Text;
}

struct TransportLimits {
  maxFrameBytes @0 :UInt32;
  maxSegments @1 :UInt16;
  maxNestingDepth @2 :UInt16;
  maxTraversalWords @3 :UInt64;
  maxQueuedFrames @4 :UInt16;
  maxQueuedBytes @5 :UInt32;
  maxInFlightCalls @6 :UInt16;
  maxExports @7 :UInt16;
  maxCompletedAnswers @8 :UInt16;
  maxChunkBytes @9 :UInt32;
  maxChunksInFlight @10 :UInt16;
}

struct ProtocolOffer {
  identity @0 :ContractIdentity;
  limits @1 :TransportLimits;
  requiredFeatureBits @2 :UInt64;
}

struct NegotiatedContract {
  identity @0 :ContractIdentity;
  limits @1 :TransportLimits;
  selectedFeatureBits @2 :UInt64;
}

enum ErrorCode {
  unknown @0;
  invalidArgument @1;
  unauthenticated @2;
  permissionDenied @3;
  notFound @4;
  alreadyExists @5;
  failedPrecondition @6;
  resourceExhausted @7;
  aborted @8;
  deadlineExceeded @9;
  unavailable @10;
  internal @11;
  incompatibleProtocol @12;
  incompatibleSchema @13;
  incompatibleRuntime @14;
  hostCapacity @15;
  sandboxTerminated @16;
  unsupportedFeature @17;
  conflict @18;
  cleanupIncomplete @19;
}

struct ErrorDetail {
  key @0 :Text;
  value @1 :Text;
}

struct SbxError {
  code @0 :ErrorCode;
  message @1 :Text;
  retryable @2 :Bool;
  operationId @3 :Text;
  sandboxId @4 :Text;
  details @5 :List(ErrorDetail);
}

struct HandshakeResult {
  union {
    accepted @0 :NegotiatedContract;
    error @1 :SbxError;
  }
}

struct AuthSession {
  sessionId @0 :Data;
  expiresAtUnixMs @1 :UInt64;
}

struct AuthResult {
  union {
    accepted @0 :AuthSession;
    error @1 :SbxError;
  }
}

struct Empty {}

struct EmptyResult {
  union {
    ok @0 :Empty;
    error @1 :SbxError;
  }
}

struct KeyValue {
  key @0 :Text;
  value @1 :Text;
}
