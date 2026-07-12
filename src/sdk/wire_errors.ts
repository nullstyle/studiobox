/**
 * Wire-fault → carried-SDK-error mapping for the Studiobox provider
 * (`src/sdk/`). The agent and host planes return a `common.capnp`
 * `SbxError` union arm (`{ which: "error", error }`) on failure, and the
 * transport can also THROW (a closed connection, a timeout). Both are
 * normalized here onto the carried `src/api/errors.ts` taxonomy so a
 * studiobox consumer catches the SAME error classes it would against the
 * real `@deno/sandbox`.
 *
 * Filesystem faults follow the upstream contract: `fs.*` mirrors `Deno.*`,
 * so `notFound`/`alreadyExists`/`permissionDenied` surface as the matching
 * `Deno.errors.*` (the SDK maps them 1:1); everything else becomes a typed
 * SDK error.
 *
 * @module
 */

import type { SbxError } from "../wire/generated/common_types.ts";
import {
  ConnectionClosedError,
  RpcError,
  UnsupportedFeatureError,
} from "../api/errors.ts";

/** A wire-plane error that has no closer carried-SDK twin. */
export class SandboxAgentError extends Error {
  readonly code: string;
  constructor(error: SbxError) {
    super(error.message || `sandbox agent error (${error.code})`);
    this.name = "SandboxAgentError";
    this.code = error.code;
  }
}

/**
 * Convert a wire `SbxError` to the carried-SDK error it should surface as.
 * `notFound`/`alreadyExists`/`permissionDenied` become the matching
 * `Deno.errors.*` (upstream `fs.*`↔`Deno.*` fidelity); connection-fatal
 * codes become {@link ConnectionClosedError}; `unsupportedFeature` becomes
 * {@link UnsupportedFeatureError}; the rest fall back to
 * {@link SandboxAgentError}.
 */
export function sbxErrorToSdk(error: SbxError): Error {
  switch (error.code) {
    case "notFound":
      return new Deno.errors.NotFound(error.message);
    case "alreadyExists":
      return new Deno.errors.AlreadyExists(error.message);
    case "permissionDenied":
      return new Deno.errors.PermissionDenied(error.message);
    case "unsupportedFeature":
      return new UnsupportedFeatureError(error.message || "operation");
    case "sandboxTerminated":
    case "unavailable":
    case "aborted":
      return new ConnectionClosedError(undefined, error.message);
    case "invalidArgument":
    case "failedPrecondition":
      return new RpcError(0, error.message, { code: error.code });
    default:
      return new SandboxAgentError(error);
  }
}

/** Throw the carried-SDK twin of a wire `SbxError`. */
export function throwSbxError(error: SbxError): never {
  throw sbxErrorToSdk(error);
}

/**
 * A generic result-union arm holder: `{ which, error? }`. Every agent/host
 * result struct has an `error` arm carrying an `SbxError`.
 */
interface WireResult {
  readonly which?: string;
  readonly error?: SbxError;
}

/**
 * Assert a result union landed on its success arm; otherwise throw the
 * mapped error. Returns the result narrowed (the caller reads the success
 * field it expects).
 */
export function expectArm<T extends WireResult>(result: T, arm: string): T {
  if (result.which === arm) return result;
  if (result.error !== undefined) throwSbxError(result.error);
  throw new SandboxAgentError({
    code: "unknown",
    message: `expected result arm "${arm}", got "${result.which}"`,
    retryable: false,
    operationId: "",
    sandboxId: "",
    details: [],
  });
}

/**
 * Normalize a THROWN transport/RPC failure. A dropped connection during a
 * call surfaces as {@link ConnectionClosedError}; anything else rides
 * through unchanged.
 */
export function normalizeThrown(error: unknown): unknown {
  if (error instanceof Deno.errors.BadResource) {
    return new ConnectionClosedError();
  }
  if (
    error instanceof Deno.errors.BrokenPipe ||
    error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.NotConnected
  ) {
    return new ConnectionClosedError();
  }
  return error;
}
