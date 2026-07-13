/** Base class for errors raised by the sandbox API. */
export abstract class SandboxSdkError extends Error {}

export class ConnectionEstablishmentError extends SandboxSdkError {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public traceId: string | undefined = undefined,
  ) {
    super(
      `${message} (status: ${status}, code: ${code}${
        traceId ? `, traceId: ${traceId}` : ""
      })`,
    );
    this.name = "ConnectionEstablishmentError";
  }
}

export class RpcError extends SandboxSdkError {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class ConnectionClosedError extends SandboxSdkError {
  constructor(
    public code: number | undefined = undefined,
    public reason: string | undefined = undefined,
  ) {
    super(
      code === undefined
        ? "Connection to the sandbox was already closed"
        : `Connection closed (code: ${code}${
          reason ? `, reason: ${reason}` : ""
        })`,
    );
    this.name = "ConnectionClosedError";
  }
}

export class SandboxCommandError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = "SandboxCommandError";
  }
}

export class InvalidTimeoutError extends SandboxSdkError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTimeoutError";
  }
}

export class InvalidMemoryError extends SandboxSdkError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryError";
  }
}

/** Exported for upstream type compatibility; Studiobox never requires a token. */
export class MissingTokenError extends SandboxSdkError {
  constructor() {
    super("An access token is required to create a sandbox.");
    this.name = "MissingTokenError";
  }
}

/** Exported for upstream type compatibility; Studiobox never validates a cloud token. */
export class InvalidTokenError extends SandboxSdkError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export class SandboxKillError extends SandboxSdkError {
  constructor(
    public status: number,
    public response: string,
  ) {
    super(`Failed to kill sandbox: ${status} ${response}`);
    this.name = "SandboxKillError";
  }
}

export class NetworkError extends SandboxSdkError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/** Exported for upstream type compatibility; Studiobox does not use the cloud API. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public traceId?: string,
  ) {
    super(traceId ? `${message} (Trace ID: ${traceId})` : message);
    this.name = "ClientError";
  }
}

/** Raised by intentionally unsupported Tier C surface area. */
export class UnsupportedFeatureError extends SandboxSdkError {
  constructor(public readonly feature: string) {
    super(`${feature} is not supported by Studiobox 1.0`);
    this.name = "UnsupportedFeatureError";
  }
}

/** Raised when a specific SDK feature is not yet implemented by this backend. */
export class ImplementationPendingError extends SandboxSdkError {
  constructor(public readonly feature: string) {
    super(`${feature} is not wired to a Studiobox runtime`);
    this.name = "ImplementationPendingError";
  }
}

/**
 * Raised by `Sandbox.create`/`connect`/`list` when no sandbox provider is
 * installed and one could not be auto-wired from the environment.
 *
 * This is a CONFIGURATION error — the SDK was never pointed at a host — and is
 * deliberately distinct from {@linkcode ImplementationPendingError} (a specific
 * feature is unimplemented). The message is actionable because hitting it means
 * the caller has a working import but nothing behind `Sandbox.create()`.
 */
export class ProviderNotInstalledError extends SandboxSdkError {
  constructor(cause?: unknown) {
    super(
      [
        "No Studiobox sandbox provider is installed.",
        "",
        "Start a host and export its environment — then `Sandbox.create()` connects automatically:",
        "  deno run -A jsr:@nullstyle/studiobox/cli host up   # prints STUDIOBOX_HOST / STUDIOBOX_TUNNEL to export",
        "",
        "Or wire a provider explicitly:",
        '  import { installStudiobox } from "@nullstyle/studiobox/sdk";',
        "  using _ = installStudiobox();",
        "",
        "For tests, install the in-process fake (no VM):",
        '  import { FakeSandboxHost } from "@nullstyle/studiobox/testing";',
        "  using _ = FakeSandboxHost.install();",
        cause instanceof Error ? `\n(cause: ${cause.message})` : "",
      ].join("\n"),
      cause instanceof Error ? { cause } : undefined,
    );
    this.name = "ProviderNotInstalledError";
  }
}

/** Raised before launch when the shared Firecracker host cannot admit a VM. */
export class HostCapacityError extends SandboxSdkError {
  constructor(message: string) {
    super(message);
    this.name = "HostCapacityError";
  }
}
