import { assertEquals, assertThrows } from "@std/assert";
import { WireValidationError } from "../../../src/wire/contract.ts";
import {
  BRIDGE_SOCKET_ROOT,
  type SupervisorBridgeGrant,
  type SupervisorBridgeRequest,
  type SupervisorLaunchRequest,
  validateBridgeGrant,
  validateBridgeRequest,
  validateBridgeSocketPath,
  validateLaunchRequest,
  validateSupervisorCredential,
} from "../../../src/wire/supervisor.ts";

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
