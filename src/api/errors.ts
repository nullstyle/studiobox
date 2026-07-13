/** Base class for errors raised by the sandbox API. */
export abstract class SandboxSdkError extends Error {}

/** Raised when the initial handshake to a sandbox fails (bad status/code from
 * the host while establishing the session). */
export class ConnectionEstablishmentError extends SandboxSdkError {
  /** Builds the error from the failing HTTP `status`, host `code`, `message`,
   * and optional `traceId`. */
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

/** Raised when the agent returns an error over the RPC channel, carrying the
 * protocol `code` and optional payload. */
export class RpcError extends SandboxSdkError {
  /** Builds the error from the RPC `code`, `message`, and optional `data`. */
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Raised when an operation is attempted on a sandbox whose connection has
 * already closed (or the socket closed mid-flight). */
export class ConnectionClosedError extends SandboxSdkError {
  /** Builds the error from the optional WebSocket close `code` and `reason`. */
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

/** Thrown by the `sh` builder when a command exits nonzero. Note it extends
 * `Error`, not {@linkcode SandboxSdkError} — an upstream quirk reproduced
 * faithfully. The message omits the command text. */
export class SandboxCommandError extends Error {
  /** Builds the error from the failure `message` and the process exit `code`. */
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = "SandboxCommandError";
  }
}

/** Raised when a sandbox `timeout` value is malformed or out of range. */
export class InvalidTimeoutError extends SandboxSdkError {
  /** Builds the error from a human-readable `message`. */
  constructor(message: string) {
    super(message);
    this.name = "InvalidTimeoutError";
  }
}

/** Raised when a `memory` value is malformed or outside the 768–4096 MiB
 * contract (see `parseMemory` in `memory.ts`). */
export class InvalidMemoryError extends SandboxSdkError {
  /** Builds the error from a human-readable `message`. */
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
  /** Builds the error from a human-readable `message`. */
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

/** Raised when a `kill()` request to the host is rejected. */
export class SandboxKillError extends SandboxSdkError {
  /** Builds the error from the host's HTTP `status` and `response` body. */
  constructor(
    public status: number,
    public response: string,
  ) {
    super(`Failed to kill sandbox: ${status} ${response}`);
    this.name = "SandboxKillError";
  }
}

/** Raised when transport to the host fails (DNS, connect, socket, TLS). */
export class NetworkError extends SandboxSdkError {
  /** Builds the error from a `message` and an optional underlying `cause`. */
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/** Exported for upstream type compatibility; Studiobox does not use the cloud API. */
export class ApiError extends Error {
  /** Builds the error from the cloud API `status`, `code`, `message`, and
   * optional `traceId`. */
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
  /** Builds the error, tagging it with the `feature` name that is unsupported. */
  constructor(public readonly feature: string) {
    super(`${feature} is not supported by Studiobox 1.0`);
    this.name = "UnsupportedFeatureError";
  }
}

/** Raised when a specific SDK feature is not yet implemented by this backend. */
export class ImplementationPendingError extends SandboxSdkError {
  /** Builds the error, tagging it with the `feature` name that is unimplemented. */
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
  /** Builds the actionable error, chaining the optional underlying `cause`
   * from the failed auto-wire attempt. */
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
  /** Builds the error from a human-readable `message`. */
  constructor(message: string) {
    super(message);
    this.name = "HostCapacityError";
  }
}
