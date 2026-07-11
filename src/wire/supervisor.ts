import { assertBoundedText, WireValidationError } from "./contract.ts";

export const SUPERVISOR_CREDENTIAL_BYTES = 32;
export const BOOT_NONCE_BYTES = 32;
export const TUNNEL_NONCE_BYTES = 32;
export const MAX_BRIDGE_TTL_MS = 15_000;
export const BRIDGE_SOCKET_ROOT = "/run/studiobox/b/";
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;

export interface SupervisorLaunchRequest {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly artifactId: string;
  readonly allocationId: string;
  readonly bootNonce: Uint8Array;
  readonly idempotencyKey: Uint8Array;
}

export interface SupervisorBridgeRequest {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly tunnelNonce: Uint8Array;
  readonly expiresAtUnixMs: number;
}

export interface SupervisorBridgeGrant {
  readonly bridgeId: string;
  readonly socketPath: string;
  readonly bridgeCredential: Uint8Array;
  readonly agentCredential: Uint8Array;
  readonly expiresAtUnixMs: number;
}

const SANDBOX_ID = /^sbx-[A-Za-z0-9][A-Za-z0-9-]{0,59}$/u;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BRIDGE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const textEncoder = new TextEncoder();

export function validateSupervisorCredential(credential: Uint8Array): void {
  assertExactBytes(
    credential,
    SUPERVISOR_CREDENTIAL_BYTES,
    "supervisor credential",
  );
}

export function validateLaunchRequest(
  value: SupervisorLaunchRequest,
): SupervisorLaunchRequest {
  assertExactKeys(value, [
    "sandboxId",
    "executionId",
    "artifactId",
    "allocationId",
    "bootNonce",
    "idempotencyKey",
  ]);
  assertPattern(value.sandboxId, SANDBOX_ID, "sandboxId");
  assertPattern(value.executionId, EXECUTION_ID, "executionId");
  assertPattern(value.artifactId, LOGICAL_ID, "artifactId");
  assertPattern(value.allocationId, LOGICAL_ID, "allocationId");
  assertExactBytes(value.bootNonce, BOOT_NONCE_BYTES, "bootNonce");
  assertByteRange(value.idempotencyKey, 16, 64, "idempotencyKey");
  return Object.freeze({
    ...value,
    bootNonce: value.bootNonce.slice(),
    idempotencyKey: value.idempotencyKey.slice(),
  });
}

export function validateBridgeRequest(
  value: SupervisorBridgeRequest,
  nowUnixMs = Date.now(),
): SupervisorBridgeRequest {
  assertExactKeys(value, [
    "sandboxId",
    "executionId",
    "leaseId",
    "leaseGeneration",
    "tunnelNonce",
    "expiresAtUnixMs",
  ]);
  assertPattern(value.sandboxId, SANDBOX_ID, "sandboxId");
  assertPattern(value.executionId, EXECUTION_ID, "executionId");
  assertPattern(value.leaseId, LOGICAL_ID, "leaseId");
  assertPositiveSafeInteger(value.leaseGeneration, "leaseGeneration");
  assertExactBytes(value.tunnelNonce, TUNNEL_NONCE_BYTES, "tunnelNonce");
  assertSafeTimestamp(value.expiresAtUnixMs, "expiresAtUnixMs");
  if (
    value.expiresAtUnixMs <= nowUnixMs ||
    value.expiresAtUnixMs > nowUnixMs + MAX_BRIDGE_TTL_MS
  ) {
    throw new WireValidationError(
      `expiresAtUnixMs must be within the next ${MAX_BRIDGE_TTL_MS}ms`,
    );
  }
  return Object.freeze({ ...value, tunnelNonce: value.tunnelNonce.slice() });
}

export function validateBridgeGrant(
  value: SupervisorBridgeGrant,
  nowUnixMs = Date.now(),
): SupervisorBridgeGrant {
  assertExactKeys(value, [
    "bridgeId",
    "socketPath",
    "bridgeCredential",
    "agentCredential",
    "expiresAtUnixMs",
  ]);
  assertPattern(value.bridgeId, BRIDGE_ID, "bridgeId");
  validateBridgeSocketPath(value.socketPath);
  assertExactBytes(value.bridgeCredential, 32, "bridgeCredential");
  assertByteRange(value.agentCredential, 32, 512, "agentCredential");
  assertSafeTimestamp(value.expiresAtUnixMs, "expiresAtUnixMs");
  if (
    value.expiresAtUnixMs <= nowUnixMs ||
    value.expiresAtUnixMs > nowUnixMs + MAX_BRIDGE_TTL_MS
  ) {
    throw new WireValidationError(
      `expiresAtUnixMs must be within the next ${MAX_BRIDGE_TTL_MS}ms`,
    );
  }
  return Object.freeze({
    ...value,
    bridgeCredential: value.bridgeCredential.slice(),
    agentCredential: value.agentCredential.slice(),
  });
}

export function validateBridgeSocketPath(path: string): void {
  assertBoundedText(path, 1, UNIX_SOCKET_PATH_MAX_BYTES, "socketPath");
  if (!path.startsWith(BRIDGE_SOCKET_ROOT)) {
    throw new WireValidationError(
      `socketPath must be beneath ${BRIDGE_SOCKET_ROOT}`,
    );
  }
  const basename = path.slice(BRIDGE_SOCKET_ROOT.length);
  if (!BRIDGE_ID.test(basename) || basename.includes("/")) {
    throw new WireValidationError(
      "socketPath must name one direct bridge socket",
    );
  }
  if (textEncoder.encode(path).byteLength > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new WireValidationError(
      "socketPath exceeds the Unix socket path budget",
    );
  }
}

function assertPattern(value: string, pattern: RegExp, field: string): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new WireValidationError(`${field} is not a valid logical identifier`);
  }
}

function assertExactBytes(
  value: Uint8Array,
  size: number,
  field: string,
): void {
  assertByteRange(value, size, size, field);
}

function assertByteRange(
  value: Uint8Array,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new WireValidationError(
      `${field} must be ${minimum}..${maximum} bytes`,
    );
  }
}

function assertSafeTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WireValidationError(`${field} must be an unsigned safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WireValidationError(`${field} must be a positive safe integer`);
  }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  if (value === null || typeof value !== "object") {
    throw new WireValidationError("supervisor request must be an object");
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new WireValidationError(`unexpected supervisor field: ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw new WireValidationError(`missing supervisor field: ${key}`);
    }
  }
}
