import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type ContractIdentity,
  DEFAULT_TRANSPORT_LIMITS,
  FEATURE,
  negotiateProtocol,
  type ProtocolOffer,
  timingSafeEqual,
  type TransportLimits,
} from "../../../src/wire/contract.ts";

const FEATURES = FEATURE.typedErrors |
  FEATURE.boundedStreams |
  FEATURE.durableLeases |
  FEATURE.rawAgentTunnel |
  FEATURE.rootSupervisor;

function digest(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function identity(
  overrides: Partial<ContractIdentity> = {},
): ContractIdentity {
  return {
    protocol: { major: 1, minor: 0 },
    featureBits: FEATURES,
    schemaHash: digest(1),
    capnpDenoVersion: "0.1.0",
    wasmAbi: 1,
    wasmSha256: digest(2),
    buildId: "studiobox-test",
    artifactHash: digest(3),
    firecrackerPackage: "@nullstyle/firecracker@0.2.0",
    firecrackerSha256: digest(4),
    firecrackerPinned: "v1.16.1",
    firecrackerMin: "v1.15.0",
    ...overrides,
  };
}

function offer(
  remoteIdentity = identity(),
  limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS,
): ProtocolOffer {
  return {
    identity: remoteIdentity,
    limits,
    requiredFeatureBits: FEATURE.typedErrors | FEATURE.boundedStreams,
  };
}

Deno.test("negotiation accepts an exact contract and clamps peer limits", () => {
  const remoteLimits: TransportLimits = {
    ...DEFAULT_TRANSPORT_LIMITS,
    maxFrameBytes: 2 * 1024 * 1024,
    maxQueuedBytes: 8 * 1024 * 1024,
    maxChunkBytes: 128 * 1024,
    maxExports: 2048,
  };
  const result = negotiateProtocol(offer(identity(), remoteLimits), {
    identity: identity(),
  });

  assert(result.ok);
  assertEquals(result.value.identity.protocol, { major: 1, minor: 0 });
  assertEquals(result.value.selectedFeatureBits, FEATURES);
  assertEquals(result.value.limits, DEFAULT_TRANSPORT_LIMITS);
});

Deno.test("negotiation fails closed on a protocol-major difference", () => {
  const result = negotiateProtocol(
    offer(identity({ protocol: { major: 2, minor: 0 } })),
    { identity: identity() },
  );

  assertFalse(result.ok);
  assertEquals(result.error.code, "incompatibleProtocol");
});

Deno.test("negotiation rejects an unknown schema hash", () => {
  const result = negotiateProtocol(
    offer(identity({ schemaHash: digest(9) })),
    { identity: identity() },
  );

  assertFalse(result.ok);
  assertEquals(result.error.code, "incompatibleSchema");
});

Deno.test("a directional additive schema pair requires its feature bits", () => {
  const remoteSchemaHash = digest(9);
  const local = identity();
  const admitted = negotiateProtocol(
    offer(identity({ schemaHash: remoteSchemaHash })),
    {
      identity: local,
      knownSchemaPairs: [{
        remoteSchemaHash,
        localSchemaHash: local.schemaHash,
        requiredFeatureBits: FEATURE.durableLeases,
      }],
    },
  );
  assert(admitted.ok);

  const rejected = negotiateProtocol(
    offer(identity({ schemaHash: remoteSchemaHash, featureBits: FEATURES })),
    {
      identity: identity({
        featureBits: FEATURES & ~FEATURE.durableLeases,
      }),
      knownSchemaPairs: [{
        remoteSchemaHash,
        localSchemaHash: local.schemaHash,
        requiredFeatureBits: FEATURE.durableLeases,
      }],
    },
  );
  assertFalse(rejected.ok);
  assertEquals(rejected.error.code, "incompatibleSchema");
});

Deno.test("negotiation rejects required features and runtime skew", () => {
  const missingFeature = negotiateProtocol({
    ...offer(identity({ featureBits: FEATURE.typedErrors })),
    requiredFeatureBits: FEATURE.boundedStreams,
  }, { identity: identity() });
  assertFalse(missingFeature.ok);
  assertEquals(missingFeature.error.code, "unsupportedFeature");

  const wrongWasm = negotiateProtocol(
    offer(identity({ wasmSha256: digest(8) })),
    { identity: identity() },
  );
  assertFalse(wrongWasm.ok);
  assertEquals(wrongWasm.error.code, "incompatibleRuntime");
});

Deno.test("malformed hashes become bounded invalid-argument errors", () => {
  const result = negotiateProtocol(
    offer(identity({ schemaHash: new Uint8Array(31) })),
    { identity: identity() },
  );

  assertFalse(result.ok);
  assertEquals(result.error.code, "invalidArgument");
  assert(result.error.message.length <= 512);
});

Deno.test("byte comparison accounts for both value and length", () => {
  assert(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
  assertFalse(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])));
  assertFalse(
    timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0])),
  );
});
