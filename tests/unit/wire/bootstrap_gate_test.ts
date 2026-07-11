import { assertEquals, assertThrows } from "@std/assert";
import {
  AuthenticationRejectedError,
  BootstrapGate,
  BootstrapRejectedError,
  BootstrapStateError,
} from "../../../src/wire/bootstrap_gate.ts";
import type {
  ContractIdentity,
  NegotiatedContract,
  NegotiationResult,
} from "../../../src/wire/contract.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../../src/wire/contract.ts";

function negotiated(): NegotiatedContract {
  const identity: ContractIdentity = {
    protocol: { major: 1, minor: 0 },
    featureBits: 1n,
    schemaHash: new Uint8Array(32),
    capnpDenoVersion: "0.1.0",
    wasmAbi: 1,
    wasmSha256: new Uint8Array(32),
    buildId: "test",
    artifactHash: new Uint8Array(32),
    firecrackerPackage: "@nullstyle/firecracker@0.2.0",
    firecrackerSha256: new Uint8Array(32),
    firecrackerPinned: "v1.16.1",
    firecrackerMin: "v1.15.0",
  };
  return {
    identity,
    limits: DEFAULT_TRANSPORT_LIMITS,
    selectedFeatureBits: 1n,
  };
}

Deno.test("bootstrap capability remains closed until negotiation and auth", () => {
  const gate = new BootstrapGate();
  const contract = negotiated();
  gate.acceptNegotiation({ ok: true, value: contract });
  assertEquals(gate.phase, "negotiated");
  gate.recordAuthentication(true);
  gate.assertAuthorized();
  assertEquals(gate.phase, "authenticated");
  assertEquals(gate.contract, contract);
});

Deno.test("requesting the service capability early fails closed", () => {
  const gate = new BootstrapGate();
  assertThrows(() => gate.assertAuthorized(), BootstrapStateError);
  assertEquals(gate.phase, "closed");
});

Deno.test("incompatible negotiation closes the bootstrap", () => {
  const gate = new BootstrapGate();
  const rejected: NegotiationResult = {
    ok: false,
    error: {
      code: "incompatibleSchema",
      message: "schema mismatch",
      retryable: false,
      operationId: "",
      sandboxId: "",
      details: {},
    },
  };
  assertThrows(
    () => gate.acceptNegotiation(rejected),
    BootstrapRejectedError,
  );
  assertEquals(gate.phase, "closed");
});

Deno.test("authentication attempts are bounded", () => {
  const gate = new BootstrapGate(2);
  gate.acceptNegotiation({ ok: true, value: negotiated() });

  const first = assertThrows(
    () => gate.recordAuthentication(false),
    AuthenticationRejectedError,
  );
  assertEquals(first.connectionClosed, false);
  assertEquals(gate.phase, "negotiated");

  const second = assertThrows(
    () => gate.recordAuthentication(false),
    AuthenticationRejectedError,
  );
  assertEquals(second.connectionClosed, true);
  assertEquals(gate.phase, "closed");
});

Deno.test("repeated negotiation is treated as a state violation", () => {
  const gate = new BootstrapGate();
  const result: NegotiationResult = { ok: true, value: negotiated() };
  gate.acceptNegotiation(result);
  assertThrows(() => gate.acceptNegotiation(result), BootstrapStateError);
  assertEquals(gate.phase, "closed");
});
