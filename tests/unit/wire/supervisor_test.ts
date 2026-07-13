import { assertEquals, assertThrows } from "@std/assert";
import { WireValidationError } from "../../../src/wire/contract.ts";
import {
  BRIDGE_SOCKET_ROOT,
  launchRequestFromWire,
  launchRequestToWire,
  MAX_ALLOW_NET_ENTRIES,
  type SupervisorBridgeGrant,
  type SupervisorBridgeRequest,
  type SupervisorLaunchRequest,
  validateBridgeGrant,
  validateBridgeRequest,
  validateBridgeSocketPath,
  validateLaunchRequest,
  validateSupervisorCredential,
} from "../../../src/wire/supervisor.ts";
import { LaunchRequestCodec } from "../../../src/wire/generated/supervisor_types.ts";

function bytes(size: number, fill = 7): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function launchRequest(): SupervisorLaunchRequest {
  return {
    sandboxId: "sbx-01JTEST",
    executionId: "exec-01JTEST",
    artifactId: "artifact:sha256:abc123",
    allocationId: "allocation-01JTEST",
    bootNonce: bytes(32),
    idempotencyKey: bytes(32, 8),
  };
}

Deno.test("supervisor launch accepts only bounded logical identifiers", () => {
  const request = launchRequest();
  const validated = validateLaunchRequest(request);

  assertEquals(validated.sandboxId, request.sandboxId);
  assertEquals(validated.bootNonce, request.bootNonce);

  assertThrows(
    () => validateLaunchRequest({ ...request, artifactId: "/srv/rootfs" }),
    WireValidationError,
  );
  assertThrows(
    () => validateLaunchRequest({ ...request, allocationId: "../../escape" }),
    WireValidationError,
  );
  assertThrows(
    () =>
      validateLaunchRequest({
        ...request,
        bootNonce: bytes(31),
      }),
    WireValidationError,
  );
});

Deno.test("supervisor launch rejects fields outside the root boundary", () => {
  const request = {
    ...launchRequest(),
    argv: ["sh", "-c", "id"],
  } as SupervisorLaunchRequest;

  assertThrows(
    () => validateLaunchRequest(request),
    WireValidationError,
    "unexpected supervisor field",
  );
});

Deno.test("supervisor launch validates the optional network policy bounds", () => {
  const base = launchRequest();

  // allowNet=[] (deny-all) and vcpus in range are accepted and carried.
  const validated = validateLaunchRequest({
    ...base,
    allowNet: ["example.com", "*.github.com:443"],
    netless: false,
    vcpus: 4,
  });
  assertEquals(validated.allowNet, ["example.com", "*.github.com:443"]);
  assertEquals(validated.vcpus, 4);

  // Unset allowNet stays UNSET (undefined), never coerced to [] (deny-all).
  assertEquals(validateLaunchRequest(base).allowNet, undefined);
  assertEquals(validateLaunchRequest({ ...base, allowNet: [] }).allowNet, []);

  assertThrows(
    () => validateLaunchRequest({ ...base, vcpus: 0 }),
    WireValidationError,
  );
  assertThrows(
    () => validateLaunchRequest({ ...base, vcpus: 1_000 }),
    WireValidationError,
  );
  // Firecracker requires 1 or an even count, capped at 32.
  assertEquals(validateLaunchRequest({ ...base, vcpus: 1 }).vcpus, 1);
  assertEquals(validateLaunchRequest({ ...base, vcpus: 32 }).vcpus, 32);
  assertThrows(
    () => validateLaunchRequest({ ...base, vcpus: 3 }), // odd > 1
    WireValidationError,
  );
  assertThrows(
    () => validateLaunchRequest({ ...base, vcpus: 34 }), // over the 32 cap
    WireValidationError,
  );
  assertThrows(
    () =>
      validateLaunchRequest({
        ...base,
        allowNet: Array.from({ length: MAX_ALLOW_NET_ENTRIES + 1 }, () => "a"),
      }),
    WireValidationError,
  );
  assertThrows(
    () => validateLaunchRequest({ ...base, allowNet: [""] }),
    WireValidationError,
  );
});

// Encode the domain request through the GENERATED flat capnp codec and decode
// it back: this is the real path the launch takes over the wire, and it proves
// the flat `List(Text)` codec (which decodes an absent list to `[]`) cannot
// collapse the unrestricted/deny-all distinction, because `allowNetSet` carries
// the presence bit.
function roundTrip(
  request: SupervisorLaunchRequest,
): SupervisorLaunchRequest {
  const wire = launchRequestToWire(request);
  const decodedWire = LaunchRequestCodec.decode(
    LaunchRequestCodec.encode(wire),
  );
  return launchRequestFromWire(decodedWire);
}

Deno.test("supervisor launch round-trips the three egress modes + netless", () => {
  const base = launchRequest();

  // UNRESTRICTED: allowNet undefined must survive the flat codec as undefined
  // (allowNetSet=false), NOT reappear as [] (which would be deny-all).
  const unrestrictedWire = launchRequestToWire(base);
  assertEquals(unrestrictedWire.allowNetSet, false);
  assertEquals(unrestrictedWire.allowNet, []);
  assertEquals(roundTrip(base).allowNet, undefined);

  // RESTRICTED deny-all: allowNet [] must survive as [] (allowNetSet=true).
  const denyAll = { ...base, allowNet: [] };
  assertEquals(launchRequestToWire(denyAll).allowNetSet, true);
  assertEquals(roundTrip(denyAll).allowNet, []);

  // RESTRICTED to patterns.
  const restricted = { ...base, allowNet: ["example.com", "*.github.com:443"] };
  assertEquals(roundTrip(restricted).allowNet, [
    "example.com",
    "*.github.com:443",
  ]);

  // NETLESS overrides allowNet; it survives as true with allowNet absent.
  const netless = { ...base, netless: true, vcpus: 2 };
  const netlessRt = roundTrip(netless);
  assertEquals(netlessRt.netless, true);
  assertEquals(netlessRt.allowNet, undefined);
  assertEquals(netlessRt.vcpus, 2);
});

Deno.test("bridge requests are short-lived and nonce-bound", () => {
  const now = 1_900_000_000_000;
  const request: SupervisorBridgeRequest = {
    sandboxId: "sbx-01JTEST",
    executionId: "exec-01JTEST",
    leaseId: "lease-01JTEST",
    leaseGeneration: 4,
    tunnelNonce: bytes(32),
    expiresAtUnixMs: now + 12_000,
  };
  assertEquals(validateBridgeRequest(request, now).leaseGeneration, 4);

  assertThrows(
    () => validateBridgeRequest({ ...request, expiresAtUnixMs: now }, now),
    WireValidationError,
  );
  assertThrows(
    () =>
      validateBridgeRequest({ ...request, expiresAtUnixMs: now + 15_001 }, now),
    WireValidationError,
  );
  assertThrows(
    () => validateBridgeRequest({ ...request, tunnelNonce: bytes(31) }, now),
    WireValidationError,
  );
});

Deno.test("bridge grants stay inside the one-shot socket directory", () => {
  const now = 1_900_000_000_000;
  const grant: SupervisorBridgeGrant = {
    bridgeId: "bridge-01JTEST",
    socketPath: `${BRIDGE_SOCKET_ROOT}bridge-01JTEST`,
    bridgeCredential: bytes(32),
    agentCredential: bytes(96),
    expiresAtUnixMs: now + 5_000,
  };
  assertEquals(validateBridgeGrant(grant, now).socketPath, grant.socketPath);

  assertThrows(
    () => validateBridgeSocketPath("/tmp/bridge-01JTEST"),
    WireValidationError,
  );
  assertThrows(
    () => validateBridgeSocketPath(`${BRIDGE_SOCKET_ROOT}nested/bridge`),
    WireValidationError,
  );
  assertThrows(
    () => validateBridgeSocketPath(`${BRIDGE_SOCKET_ROOT}../supervisor.sock`),
    WireValidationError,
  );
});

Deno.test("supervisor bootstrap credential is exactly 32 bytes", () => {
  validateSupervisorCredential(bytes(32));
  assertThrows(
    () => validateSupervisorCredential(bytes(31)),
    WireValidationError,
  );
  assertThrows(
    () => validateSupervisorCredential(bytes(33)),
    WireValidationError,
  );
});
