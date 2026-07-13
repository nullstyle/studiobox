import { assertBoundedText, WireValidationError } from "./contract.ts";
import type { LaunchRequest as WireLaunchRequest } from "./generated/supervisor_types.ts";

export const SUPERVISOR_CREDENTIAL_BYTES = 32;
export const BOOT_NONCE_BYTES = 32;
export const TUNNEL_NONCE_BYTES = 32;
export const MAX_BRIDGE_TTL_MS = 15_000;
export const BRIDGE_SOCKET_ROOT = "/run/studiobox/b/";
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;
/** Most `allowNet` patterns a launch may carry (mirrors `network/spec.ts` MAX_ENTRIES). */
export const MAX_ALLOW_NET_ENTRIES = 1024;
/** Widest single `allowNet` pattern (mirrors `network/spec.ts` MAX_ENTRY_BYTES). */
export const MAX_ALLOW_NET_ENTRY_BYTES = 300;
/** vCPU ceiling accepted at the boundary (defence against garbage; wire is UInt16). */
/** Firecracker caps `vcpu_count` at 32 and requires 1 or an even number. */
export const MAX_LAUNCH_VCPUS = 32;

export interface SupervisorLaunchRequest {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly artifactId: string;
  readonly allocationId: string;
  readonly bootNonce: Uint8Array;
  readonly idempotencyKey: Uint8Array;
  /**
   * Logical egress policy resolved by rootd's nftables engine at launch.
   * `undefined` ⇒ UNRESTRICTED (full internet, the upstream default); `[]` ⇒
   * RESTRICTED deny-all; a non-empty list ⇒ RESTRICTED to those host/IP
   * patterns. The presence bit survives the flat capnp codec (which would
   * decode an absent `List(Text)` to `[]`) via the `allowNetSet` wire companion
   * — see {@link launchRequestToWire} / {@link launchRequestFromWire}.
   */
  readonly allowNet?: readonly string[];
  /** No network at all (overrides {@link allowNet}). Absent ⇒ not netless. */
  readonly netless?: boolean;
  /** Requested guest vCPUs (small integer). Absent ⇒ the planner's default. */
  readonly vcpus?: number;
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

const LAUNCH_REQUIRED_KEYS = [
  "sandboxId",
  "executionId",
  "artifactId",
  "allocationId",
  "bootNonce",
  "idempotencyKey",
] as const;
const LAUNCH_OPTIONAL_KEYS = ["allowNet", "netless", "vcpus"] as const;

export function validateLaunchRequest(
  value: SupervisorLaunchRequest,
): SupervisorLaunchRequest {
  assertKeys(value, LAUNCH_REQUIRED_KEYS, LAUNCH_OPTIONAL_KEYS);
  assertPattern(value.sandboxId, SANDBOX_ID, "sandboxId");
  assertPattern(value.executionId, EXECUTION_ID, "executionId");
  assertPattern(value.artifactId, LOGICAL_ID, "artifactId");
  assertPattern(value.allocationId, LOGICAL_ID, "allocationId");
  assertExactBytes(value.bootNonce, BOOT_NONCE_BYTES, "bootNonce");
  assertByteRange(value.idempotencyKey, 16, 64, "idempotencyKey");
  const allowNet = validateAllowNet(value.allowNet);
  const netless = validateNetless(value.netless);
  const vcpus = validateVcpus(value.vcpus);
  return Object.freeze({
    sandboxId: value.sandboxId,
    executionId: value.executionId,
    artifactId: value.artifactId,
    allocationId: value.allocationId,
    bootNonce: value.bootNonce.slice(),
    idempotencyKey: value.idempotencyKey.slice(),
    // Preserve presence: an absent `allowNet` (unrestricted) must NOT be
    // reconstructed as `[]` (deny-all) — keep the key out entirely.
    ...(allowNet === undefined ? {} : { allowNet }),
    ...(netless === undefined ? {} : { netless }),
    ...(vcpus === undefined ? {} : { vcpus }),
  });
}

/**
 * Project a validated domain {@link SupervisorLaunchRequest} onto the flat wire
 * `LaunchRequest`, encoding the `allowNet` presence bit into `allowNetSet`:
 * an absent `allowNet` (unrestricted) ⇒ `allowNetSet = false, allowNet = []`;
 * a present `allowNet` (possibly `[]`) ⇒ `allowNetSet = true`. Round-trips
 * losslessly with {@link launchRequestFromWire}.
 */
export function launchRequestToWire(
  request: SupervisorLaunchRequest,
): WireLaunchRequest {
  return {
    sandboxId: request.sandboxId,
    executionId: request.executionId,
    artifactId: request.artifactId,
    allocationId: request.allocationId,
    bootNonce: request.bootNonce.slice(),
    idempotencyKey: request.idempotencyKey.slice(),
    allowNet: request.allowNet === undefined ? [] : [...request.allowNet],
    allowNetSet: request.allowNet !== undefined,
    netless: request.netless ?? false,
    vcpus: request.vcpus ?? 0,
  };
}

/**
 * Decode the flat wire `LaunchRequest` back into the domain shape, collapsing
 * the `allowNetSet` companion: `allowNetSet === false` ⇒ `allowNet` undefined
 * (unrestricted); `allowNetSet === true` ⇒ the (possibly empty) list. A wire
 * `netless`/`vcpus` of `false`/`0` decodes to absent so the round-trip is
 * lossless against {@link launchRequestToWire}.
 */
export function launchRequestFromWire(
  wire: WireLaunchRequest,
): SupervisorLaunchRequest {
  return {
    sandboxId: wire.sandboxId,
    executionId: wire.executionId,
    artifactId: wire.artifactId,
    allocationId: wire.allocationId,
    bootNonce: wire.bootNonce,
    idempotencyKey: wire.idempotencyKey,
    ...(wire.allowNetSet ? { allowNet: [...wire.allowNet] } : {}),
    ...(wire.netless ? { netless: true } : {}),
    ...(wire.vcpus > 0 ? { vcpus: wire.vcpus } : {}),
  };
}

function validateAllowNet(
  allowNet: readonly string[] | undefined,
): readonly string[] | undefined {
  if (allowNet === undefined) return undefined;
  if (!Array.isArray(allowNet)) {
    throw new WireValidationError("allowNet must be an array of strings");
  }
  if (allowNet.length > MAX_ALLOW_NET_ENTRIES) {
    throw new WireValidationError(
      `allowNet must have at most ${MAX_ALLOW_NET_ENTRIES} entries`,
    );
  }
  for (const entry of allowNet) {
    assertBoundedText(entry, 1, MAX_ALLOW_NET_ENTRY_BYTES, "allowNet entry");
  }
  return allowNet.slice();
}

function validateNetless(netless: boolean | undefined): boolean | undefined {
  if (netless === undefined) return undefined;
  if (typeof netless !== "boolean") {
    throw new WireValidationError("netless must be a boolean");
  }
  return netless;
}

function validateVcpus(vcpus: number | undefined): number | undefined {
  if (vcpus === undefined) return undefined;
  // Firecracker's machine config accepts only 1 or an even count, up to 32;
  // an odd/over-cap value would pass a naive bound but fail at boot AFTER the
  // dataplane is provisioned, so reject it at the wire boundary.
  if (!Number.isSafeInteger(vcpus) || vcpus < 1 || vcpus > MAX_LAUNCH_VCPUS) {
    throw new WireValidationError(
      `vcpus must be an integer in 1..${MAX_LAUNCH_VCPUS}`,
    );
  }
  if (vcpus > 1 && vcpus % 2 !== 0) {
    throw new WireValidationError(
      "vcpus must be 1 or an even number (Firecracker constraint)",
    );
  }
  return vcpus;
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

/**
 * Like {@link assertExactKeys} but with a set of OPTIONAL keys that may be
 * present or absent. Every `required` key must be present; every present key
 * must be `required` or `optional`; unknown keys still fail closed.
 */
function assertKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): void {
  if (value === null || typeof value !== "object") {
    throw new WireValidationError("supervisor request must be an object");
  }
  const allowedSet = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new WireValidationError(`unexpected supervisor field: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new WireValidationError(`missing supervisor field: ${key}`);
    }
  }
}
