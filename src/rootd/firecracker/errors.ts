/** Stable, redacted errors emitted by the Studiobox Firecracker boundary. */

export type FirecrackerAdapterErrorCode =
  | "SBX_FC_API"
  | "SBX_FC_CANCELED"
  | "SBX_FC_CLEANUP"
  | "SBX_FC_EXECUTION_CONFLICT"
  | "SBX_FC_HOST"
  | "SBX_FC_JAILER"
  | "SBX_FC_SHUTDOWN"
  | "SBX_FC_STATE"
  | "SBX_FC_TIMEOUT"
  | "SBX_FC_TRANSPORT"
  | "SBX_FC_VMM_EXITED"
  | "SBX_FC_VSOCK_DIAL";

export interface FirecrackerErrorDetails {
  readonly dependencyCode?: string;
  readonly status?: number;
  readonly reason?: string;
  readonly attempts?: number;
  readonly failureCount?: number;
  readonly leakedPathCount?: number;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly observedVia?: string;
}

/**
 * The internal supervisor error contract. Dependency messages and host paths
 * are deliberately not copied into `message` or `details`.
 */
export class FirecrackerAdapterError extends Error {
  readonly code: FirecrackerAdapterErrorCode;
  readonly operation: string;
  readonly retryable: boolean;
  readonly details: Readonly<FirecrackerErrorDetails>;

  constructor(options: {
    code: FirecrackerAdapterErrorCode;
    operation: string;
    message: string;
    retryable: boolean;
    details?: FirecrackerErrorDetails;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "FirecrackerAdapterError";
    this.code = options.code;
    this.operation = options.operation;
    this.retryable = options.retryable;
    this.details = Object.freeze({ ...options.details });
  }
}

export class ExecutionIdConflictError extends FirecrackerAdapterError {
  readonly executionId: string;

  constructor(executionId: string, cause?: unknown) {
    super({
      code: "SBX_FC_EXECUTION_CONFLICT",
      operation: "journal execution",
      message: "the Firecracker execution id is already journaled",
      retryable: false,
      cause,
    });
    this.name = "ExecutionIdConflictError";
    this.executionId = executionId;
  }
}

export class StaleExecutionIdError extends FirecrackerAdapterError {
  readonly executionId: string;

  constructor(executionId: string, operation = "update execution journal") {
    super({
      code: "SBX_FC_STATE",
      operation,
      message: `${operation} was invalid for the current VMM state`,
      retryable: false,
    });
    this.name = "StaleExecutionIdError";
    this.executionId = executionId;
  }
}

export interface NormalizeFirecrackerErrorOptions {
  readonly operation: string;
  readonly signal?: AbortSignal;
  readonly deadlineExpired?: boolean;
  readonly cleanupIncomplete?: boolean;
}

/** Normalize package errors and native host failures at the root boundary. */
export function normalizeFirecrackerError(
  error: unknown,
  options: NormalizeFirecrackerErrorOptions,
): FirecrackerAdapterError {
  if (error instanceof FirecrackerAdapterError) return error;

  // Cleanup is the stronger condition: cancellation must never hide a
  // journal/resource leak that still needs reconciliation.
  if (options.cleanupIncomplete === true) {
    return adapterError("SBX_FC_CLEANUP", options.operation, true, error);
  }
  if (options.signal?.aborted === true) {
    return adapterError(
      "SBX_FC_CANCELED",
      options.operation,
      false,
      error,
    );
  }
  if (options.deadlineExpired === true) {
    return adapterError("SBX_FC_TIMEOUT", options.operation, true, error);
  }
  const value = asRecord(error) ?? {};
  const dependencyCode = typeof value.code === "string"
    ? value.code
    : undefined;
  if (dependencyCode === undefined) {
    return adapterError("SBX_FC_HOST", options.operation, false, error);
  }
  const mapped = DEPENDENCY_CODE_MAP[dependencyCode];
  if (mapped === undefined) {
    return adapterError("SBX_FC_HOST", options.operation, false, error);
  }

  const details: FirecrackerErrorDetails = {
    dependencyCode,
    ...safeDependencyDetails(dependencyCode, value),
  };
  return new FirecrackerAdapterError({
    code: mapped.code,
    operation: options.operation,
    message: messageFor(mapped.code, options.operation),
    retryable: mapped.retryable,
    details,
    cause: error,
  });
}

const DEPENDENCY_CODE_MAP: Readonly<
  Record<string, { code: FirecrackerAdapterErrorCode; retryable: boolean }>
> = Object.freeze({
  FC_API: { code: "SBX_FC_API", retryable: false },
  FC_TRANSPORT: { code: "SBX_FC_TRANSPORT", retryable: true },
  FC_VMM_EXITED: { code: "SBX_FC_VMM_EXITED", retryable: false },
  FC_TIMEOUT: { code: "SBX_FC_TIMEOUT", retryable: true },
  FC_SHUTDOWN: { code: "SBX_FC_SHUTDOWN", retryable: true },
  FC_VSOCK_DIAL: { code: "SBX_FC_VSOCK_DIAL", retryable: true },
  FC_JAILER: { code: "SBX_FC_JAILER", retryable: false },
  FC_STATE: { code: "SBX_FC_STATE", retryable: false },
  FC_CLEANUP: { code: "SBX_FC_CLEANUP", retryable: true },
});

function adapterError(
  code: FirecrackerAdapterErrorCode,
  operation: string,
  retryable: boolean,
  cause: unknown,
): FirecrackerAdapterError {
  return new FirecrackerAdapterError({
    code,
    operation,
    message: messageFor(code, operation),
    retryable,
    cause,
  });
}

function messageFor(
  code: FirecrackerAdapterErrorCode,
  operation: string,
): string {
  const suffix: Readonly<Record<FirecrackerAdapterErrorCode, string>> = {
    SBX_FC_API: "was rejected by the VMM",
    SBX_FC_CANCELED: "was canceled",
    SBX_FC_CLEANUP: "left resources requiring reconciliation",
    SBX_FC_EXECUTION_CONFLICT: "used a duplicate execution id",
    SBX_FC_HOST: "failed at the host boundary",
    SBX_FC_JAILER: "failed jail validation or staging",
    SBX_FC_SHUTDOWN: "did not stop the VMM cleanly",
    SBX_FC_STATE: "was invalid for the current VMM state",
    SBX_FC_TIMEOUT: "exceeded its deadline",
    SBX_FC_TRANSPORT: "could not reach the VMM API",
    SBX_FC_VMM_EXITED: "was interrupted by VMM exit",
    SBX_FC_VSOCK_DIAL: "could not connect to the guest agent",
  };
  return `${operation} ${suffix[code]}`;
}

function safeDependencyDetails(
  code: string,
  value: Record<string, unknown>,
): FirecrackerErrorDetails {
  if (code === "FC_API") {
    return typeof value.status === "number" ? { status: value.status } : {};
  }
  if (code === "FC_VSOCK_DIAL") {
    return {
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(typeof value.attempts === "number"
        ? { attempts: value.attempts }
        : {}),
    };
  }
  if (code === "FC_CLEANUP") {
    return {
      ...(Array.isArray(value.failures)
        ? { failureCount: value.failures.length }
        : {}),
      ...(Array.isArray(value.leaked)
        ? { leakedPathCount: value.leaked.length }
        : {}),
    };
  }
  if (code === "FC_VMM_EXITED") {
    const exit = asRecord(value.exit);
    if (exit === undefined) return {};
    return {
      ...(typeof exit.code === "number" || exit.code === null
        ? { exitCode: exit.code as number | null }
        : {}),
      ...(typeof exit.signal === "string" || exit.signal === null
        ? { exitSignal: exit.signal as string | null }
        : {}),
      ...(typeof exit.observedVia === "string"
        ? { observedVia: exit.observedVia }
        : {}),
    };
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
