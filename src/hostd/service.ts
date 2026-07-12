/**
 * The studiobox-hostd capnp WIRE adapter — `schema/host_control.capnp`'s
 * `HostBootstrap` -> `HostControl` -> `HostSandbox` / `Lease` services as a
 * thin layer over the {@linkcode HostControlCore} domain (DESIGN.md §3 hostd
 * role, §4 host_control plane; PLAN.md §M6).
 *
 * Layering contract (mirrors `src/rootd/service.ts`):
 *
 * - the connection lifecycle is the fail-closed
 *   `connected -> negotiated -> authenticated -> closed` gate from
 *   `src/wire/bootstrap_gate.ts`: `negotiate` runs {@linkcode negotiateProtocol}
 *   against the host plane's real {@linkcode ContractIdentity} (schema-bundle
 *   hash from `compat/wire.json`), `authenticate` compares the 32-byte
 *   credential in constant time and is rate-limited by the gate, and the
 *   `HostControl` capability (plus every method on it and on the handed-out
 *   `HostSandbox`/`Lease`, defense in depth) refuses until `authenticated`;
 * - every RPC method validates at the wire boundary, delegates to the same
 *   {@linkcode HostControlCore} method, and encodes the result / `SbxError`
 *   union — no domain logic lives here;
 * - thrown {@linkcode HostControlError} / {@linkcode HostCapacityError} /
 *   `SupervisorError` / `WireValidationError` / `BootstrapStateError` values map
 *   onto the schema's `SbxError` arms via {@linkcode hostFaultToWire}.
 *
 * One {@linkcode createHostControlWireConnection} instance serves exactly one
 * transport: the gate AND the session-liveness {@link AbortController} are
 * connection-local. The accept loop in `src/hostd/main.ts` closes the gate and
 * aborts the controller the moment the transport dies — which settles every
 * `"session"` lease created over that connection (DESIGN.md §5).
 *
 * ## Capability handout (capnp 0.3.0+, schema-pure)
 *
 * `HostBootstrap.host`, `HostControl.sandbox`, and `HostSandbox.lease` each
 * return a FRESH wire-managed export per call (the generated service wrapper
 * exports host-minted server objects through the call context). Every method on
 * a handed-out stub re-asserts the connection gate, so a stub outlives its
 * usefulness the moment the gate latches closed. Clients over `RpcWireClient`
 * must acquire these with `finish: { releaseResultCaps: false }` and release
 * them via the stub's lifecycle `close()` (the upstream stub default eagerly
 * releases result caps; see the CLIENT CONTRACT note in `src/rootd/service.ts`).
 *
 * @module
 */

import type {
  AuthResult as WireAuthResult,
  ContractIdentity as WireContractIdentity,
  EmptyResult as WireEmptyResult,
  ErrorCode as WireErrorCode,
  HandshakeResult as WireHandshakeResult,
  NegotiatedContract as WireNegotiatedContract,
  ProtocolOffer as WireProtocolOffer,
  SbxError as WireSbxError,
} from "../wire/generated/common_types.ts";
import type {
  AttachParams,
  AttachResult as WireAttachResult,
  CapacityResult as WireCapacityResult,
  CreateParams,
  CreateResult as WireCreateResult,
  DeadlineResult as WireDeadlineResult,
  ExposureResult as WireExposureResult,
  HostControl,
  HostSandbox,
  Lease as WireLease,
  LeaseInfo as WireLeaseInfo,
  LeaseRenewResult as WireLeaseRenewResult,
  ListResult as WireListResult,
  MetadataResult as WireMetadataResult,
  Region as WireRegion,
  ResumeResult as WireResumeResult,
  RpcStub,
  SandboxMetadata as WireSandboxMetadata,
  TimeoutSpec as WireTimeoutSpec,
  TunnelGrantResult as WireTunnelGrantResult,
  UsageResult as WireUsageResult,
} from "../wire/generated/host_control_types.ts";
import type { HostBootstrap } from "../wire/generated/host_control_types.ts";
import {
  type ContractIdentity,
  FEATURE,
  type KnownRuntimePair,
  type KnownSchemaPair,
  type NegotiatedContract,
  negotiateProtocol,
  type ProtocolOffer,
  type SbxError,
  timingSafeEqual,
  type TransportLimits,
  WireValidationError,
} from "../wire/contract.ts";
import {
  AuthenticationRejectedError,
  BootstrapGate,
  BootstrapRejectedError,
  BootstrapStateError,
} from "../wire/bootstrap_gate.ts";
import {
  buildSupervisorContractIdentity,
  contractIdentityFromWire,
  contractIdentityToWire,
  type SupervisorCompatIdentitySource,
  type SupervisorIdentityOptions,
  transportLimitsFromWire,
  transportLimitsToWire,
} from "../rootd/service.ts";
import { validateSupervisorCredential } from "../wire/supervisor.ts";
import { SupervisorError } from "../rootd/supervisor_core_api.ts";
import {
  type CreateSandboxInput,
  HostCapacityError,
  type HostControlCore,
  HostControlError,
  type HostRegion,
  type LeaseSnapshot,
  type SandboxSnapshot,
} from "./control_core.ts";
import type { LeaseTimeout } from "./leases.ts";
import { HostCapacityExhaustedError } from "./capacity.ts";

/** Feature bits the host control plane offers/requires (DESIGN.md §4/§5). */
export const HOST_FEATURE_BITS: bigint = FEATURE.typedErrors |
  FEATURE.durableLeases |
  FEATURE.rawAgentTunnel |
  FEATURE.httpExposure;

const MAX_ERROR_MESSAGE_LENGTH = 512;
const SESSION_ID_BYTES = 16;

// ---------------------------------------------------------------------------
// Contract identity (shared compat/wire.json bundle, host feature bits)
// ---------------------------------------------------------------------------

export type { SupervisorCompatIdentitySource as HostCompatIdentitySource };

/** Options for {@linkcode buildHostContractIdentity}. */
export type HostIdentityOptions = SupervisorIdentityOptions;

/**
 * Build the host plane's {@linkcode ContractIdentity} from the parsed
 * `compat/wire.json` (the REAL schema bundle hash) plus the capnp runtime
 * identity — identical to the supervisor plane's builder but defaulting to the
 * host plane's {@link HOST_FEATURE_BITS}.
 */
export function buildHostContractIdentity(
  compat: SupervisorCompatIdentitySource,
  options: HostIdentityOptions,
): Promise<ContractIdentity> {
  return buildSupervisorContractIdentity(compat, {
    ...options,
    featureBits: options.featureBits ?? HOST_FEATURE_BITS,
  });
}

// ---------------------------------------------------------------------------
// contract.ts <-> generated common.capnp conversions (host-plane locals)
// ---------------------------------------------------------------------------

function protocolOfferFromWire(value: WireProtocolOffer): ProtocolOffer {
  return {
    identity: contractIdentityFromWire(value.identity as WireContractIdentity),
    limits: transportLimitsFromWire(value.limits),
    requiredFeatureBits: value.requiredFeatureBits,
  };
}

function negotiatedContractToWire(
  value: NegotiatedContract,
): WireNegotiatedContract {
  return {
    identity: contractIdentityToWire(value.identity),
    limits: transportLimitsToWire(value.limits),
    selectedFeatureBits: value.selectedFeatureBits,
  };
}

// ---------------------------------------------------------------------------
// Fault mapping: domain errors -> SbxError
// ---------------------------------------------------------------------------

const HOST_CODE_MAP: Readonly<
  Record<string, { code: WireErrorCode; retryable: boolean }>
> = {
  SBX_HOST_NOT_FOUND: { code: "notFound", retryable: false },
  SBX_HOST_PERMISSION: { code: "permissionDenied", retryable: false },
  SBX_HOST_VALIDATION: { code: "invalidArgument", retryable: false },
  SBX_HOST_STATE: { code: "failedPrecondition", retryable: false },
  SBX_HOST_UNIMPLEMENTED: { code: "unsupportedFeature", retryable: false },
};

function wireError(
  code: WireErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    sandboxId?: string;
    details?: ReadonlyArray<{ key: string; value: string }>;
  } = {},
): WireSbxError {
  return {
    code,
    message: truncateMessage(message),
    retryable: options.retryable ?? false,
    operationId: "",
    sandboxId: options.sandboxId ?? "",
    details: (options.details ?? []).map((entry) => ({ ...entry })),
  };
}

/** Convert a `contract.ts` negotiation `SbxError` to its wire twin. */
function contractErrorToWire(error: SbxError): WireSbxError {
  return wireError(error.code, error.message, {
    retryable: error.retryable,
    sandboxId: error.sandboxId,
    details: Object.entries(error.details).map(([key, value]) => ({
      key,
      value,
    })),
  });
}

/**
 * Map one host-plane fault onto the schema's `SbxError`. Domain errors carry
 * redacted, logical-id-only messages by contract, so their text rides through
 * (bounded); anything unrecognized is fully redacted to a generic internal
 * failure.
 */
export function hostFaultToWire(error: unknown): WireSbxError {
  if (error instanceof HostCapacityExhaustedError) {
    return wireError("hostCapacity", error.message, {
      retryable: false,
      details: [{ key: "capacityDimension", value: error.dimension }],
    });
  }
  if (error instanceof HostCapacityError) {
    return wireError("hostCapacity", error.message);
  }
  if (error instanceof HostControlError) {
    const mapped = HOST_CODE_MAP[error.code] ??
      { code: "internal" as WireErrorCode, retryable: false };
    return wireError(mapped.code, error.message, {
      retryable: mapped.retryable,
      details: [{ key: "hostCode", value: error.code }],
    });
  }
  if (error instanceof SupervisorError) {
    // rootd is unreachable / refused: surface a retryable unavailable so the
    // client can back off, tagged with the supervisor code for diagnostics.
    return wireError("unavailable", error.message, {
      retryable: error.code === "SBX_SUP_UNAVAILABLE",
      details: [{ key: "supervisorCode", value: error.code }],
    });
  }
  if (error instanceof WireValidationError) {
    return wireError("invalidArgument", error.message);
  }
  if (error instanceof BootstrapStateError) {
    return wireError("permissionDenied", error.message);
  }
  return wireError("internal", "internal host control failure");
}

function truncateMessage(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : text;
}

// ---------------------------------------------------------------------------
// Domain <-> generated host_control.capnp conversions
// ---------------------------------------------------------------------------

function timeoutFromWire(spec: WireTimeoutSpec): LeaseTimeout {
  if (spec.which === "durationMs") {
    const durationMs = spec.durationMs ?? 0n;
    return { kind: "duration", durationMs: Number(durationMs) };
  }
  return { kind: "session" };
}

function timeoutToWire(timeout: LeaseTimeout): WireTimeoutSpec {
  return timeout.kind === "duration"
    ? { which: "durationMs", durationMs: BigInt(timeout.durationMs) }
    : { which: "session", session: undefined };
}

/**
 * The wire `Region` enum is `"ord"`/`"ams"`; the host domain widens it to admit
 * `"loc"` (DESIGN.md §5). Until the schema is regenerated to carry `"loc"`, a
 * domain `"loc"` encodes back as `"ord"` on the wire and only the domain layer
 * observes the widened value.
 */
function regionFromWire(region: WireRegion): HostRegion {
  return region;
}

function regionToWire(region: HostRegion): WireRegion {
  return region === "loc" ? "ord" : region;
}

function sandboxMetadataToWire(
  snapshot: SandboxSnapshot,
): WireSandboxMetadata {
  return {
    id: snapshot.id,
    state: snapshot.state,
    createdAtUnixMs: BigInt(snapshot.createdAtUnixMs),
    deadlineUnixMs: BigInt(snapshot.deadlineUnixMs),
    labels: snapshot.labels.map((l) => ({ key: l.key, value: l.value })),
    region: regionToWire(snapshot.region),
    bootNonce: snapshot.bootNonce.slice(),
    liveLeases: snapshot.liveLeases,
    terminationReason: snapshot.terminationReason,
  };
}

function leaseInfoToWire(lease: LeaseSnapshot): WireLeaseInfo {
  return {
    id: lease.id,
    generation: BigInt(lease.generation),
    resumeSecret: lease.resumeSecret.slice(),
    expiresAtUnixMs: BigInt(lease.expiresAtUnixMs),
    timeout: timeoutToWire(lease.timeout),
  };
}

const MAX_LABELS = 5;
const MAX_LABEL_KEY_BYTES = 64;
const MAX_LABEL_VALUE_BYTES = 128;
const textEncoder = new TextEncoder();

function createInputFromWire(params: CreateParams): CreateSandboxInput {
  const options = params.options;
  if (options === undefined) {
    throw new WireValidationError("create requires options");
  }
  const labels = options.labels ?? [];
  if (labels.length > MAX_LABELS) {
    throw new WireValidationError(`at most ${MAX_LABELS} labels are allowed`);
  }
  for (const label of labels) {
    if (textEncoder.encode(label.key).byteLength > MAX_LABEL_KEY_BYTES) {
      throw new WireValidationError("label key exceeds 64 bytes");
    }
    if (textEncoder.encode(label.value).byteLength > MAX_LABEL_VALUE_BYTES) {
      throw new WireValidationError("label value exceeds 128 bytes");
    }
  }
  const memoryMiB = options.memoryMiB ?? 0;
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 0) {
    throw new WireValidationError("memoryMiB must be a non-negative integer");
  }
  return {
    timeout: timeoutFromWire(options.timeout ?? { which: "session" }),
    memoryMiB,
    region: regionFromWire(options.region ?? "ord"),
    labels: labels.map((l) => ({ key: l.key, value: l.value })),
    idempotencyKey: params.idempotencyKey ?? new Uint8Array(0),
  };
}

// ---------------------------------------------------------------------------
// Sub-capability factories (fresh wire-managed export per handout)
// ---------------------------------------------------------------------------

function createLeaseCapability(
  core: HostControlCore,
  gate: BootstrapGate,
  leaseId: string,
): WireLease {
  return {
    renew: (): Promise<WireLeaseRenewResult> => {
      try {
        gate.assertAuthorized();
        const renewal = core.renewLease(leaseId);
        return Promise.resolve({
          which: "renewal",
          renewal: {
            generation: BigInt(renewal.generation),
            expiresAtUnixMs: BigInt(renewal.expiresAtUnixMs),
          },
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    release: (): Promise<WireEmptyResult> => {
      try {
        gate.assertAuthorized();
        core.releaseLease(leaseId);
        return Promise.resolve({ which: "ok", ok: {} });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
  };
}

function createSandboxCapability(
  core: HostControlCore,
  gate: BootstrapGate,
  sandboxId: string,
): HostSandbox {
  return {
    metadata: (): Promise<WireMetadataResult> => {
      try {
        gate.assertAuthorized();
        return Promise.resolve({
          which: "metadata",
          metadata: sandboxMetadataToWire(core.metadata(sandboxId)),
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    lease: (): Promise<RpcStub<WireLease>> => {
      gate.assertAuthorized();
      const leaseId = core.currentLeaseId(sandboxId);
      return Promise.resolve(
        createLeaseCapability(core, gate, leaseId) as unknown as RpcStub<
          WireLease
        >,
      );
    },
    openTunnel: async (): Promise<WireTunnelGrantResult> => {
      try {
        gate.assertAuthorized();
        // Issue a single-use ticket + a per-tunnel endpoint, burning the ticket
        // before rootd's bridge is opened (M7; see control_core.openTunnel).
        // Without a wired bridge factory the core fails typed-unimplemented,
        // which maps to `unsupportedFeature` — the M6 behaviour is preserved.
        const grant = await core.openTunnel(sandboxId);
        // The loopback endpoint is not a wire field: the client dials the
        // statically forwarded tunnel port (the endpoint travels the E2E path).
        // `agentCredential` is the launch-scoped guest token the client presents
        // to `AgentBootstrap.authenticate` (PLAN.md §M8): rootd minted it at
        // launch, baked it into the guest, and surfaced it via the openBridge
        // grant that `openTunnel` reserved.
        return {
          which: "grant",
          grant: {
            ticket: grant.ticket.slice(),
            expiresAtUnixMs: BigInt(grant.expiresAtUnixMs),
            sandboxId: grant.sandboxId,
            bootNonce: grant.bootNonce.slice(),
            leaseId: grant.leaseId,
            leaseGeneration: BigInt(grant.leaseGeneration),
            tunnelNonce: new Uint8Array(0),
            agentCredential: grant.agentCredential.slice(),
          },
        };
      } catch (error) {
        return { which: "error", error: hostFaultToWire(error) };
      }
    },
    extendTimeout: (milliseconds): Promise<WireDeadlineResult> => {
      try {
        gate.assertAuthorized();
        const ms = Number(milliseconds);
        if (!Number.isSafeInteger(ms) || ms <= 0) {
          throw new WireValidationError(
            "milliseconds must be a positive integer",
          );
        }
        const deadline = core.extendTimeout(sandboxId, ms);
        return Promise.resolve({
          which: "deadline",
          deadline: {
            deadlineUnixMs: BigInt(deadline.deadlineUnixMs),
            leaseGeneration: BigInt(deadline.leaseGeneration),
          },
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    usage: async (): Promise<WireUsageResult> => {
      try {
        gate.assertAuthorized();
        const usage = await core.usage(sandboxId);
        return {
          which: "usage",
          usage: {
            cpuTimeMicros: BigInt(usage.cpuTimeMicros),
            memoryCurrentBytes: BigInt(usage.memoryCurrentBytes),
            memoryPeakBytes: BigInt(usage.memoryPeakBytes),
            diskBytes: BigInt(usage.diskBytes),
            rxBytes: BigInt(usage.rxBytes),
            txBytes: BigInt(usage.txBytes),
          },
        };
      } catch (error) {
        return { which: "error", error: hostFaultToWire(error) };
      }
    },
    exposeHttp: (): Promise<WireExposureResult> => {
      try {
        gate.assertAuthorized();
        // Port forwarding + nftables egress land with M10; fail typed.
        return Promise.resolve({
          which: "error",
          error: wireError(
            "unsupportedFeature",
            "exposeHttp is not yet wired (M10 egress path)",
          ),
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    kill: (): Promise<WireEmptyResult> => {
      try {
        gate.assertAuthorized();
        core.killSandbox(sandboxId);
        return Promise.resolve({ which: "ok", ok: {} });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The wire services
// ---------------------------------------------------------------------------

/** Configuration shared by every host control wire connection. */
export interface HostControlWireOptions {
  /** The domain core every RPC method delegates to. */
  readonly core: HostControlCore;
  /** The local identity offered/enforced during negotiation. */
  readonly identity: ContractIdentity;
  /** The expected 32-byte bootstrap credential (constant-time compared). */
  readonly credential: Uint8Array;
  /** Feature bits the peer must support (defaults to the plane's own). */
  readonly requiredPeerFeatureBits?: bigint;
  /** Local transport-limit ceiling (defaults to the shared defaults). */
  readonly limitsCeiling?: TransportLimits;
  /** Admitted cross-version schema pairs (two-minor compat policy). */
  readonly knownSchemaPairs?: readonly KnownSchemaPair[];
  /** Admitted cross-version runtime pairs. */
  readonly knownRuntimePairs?: readonly KnownRuntimePair[];
  /** Auth failure budget before the gate closes (default 3). */
  readonly maxAuthenticationFailures?: number;
}

/** Everything one accepted transport serves. */
export interface HostControlWireConnection {
  /** The bootstrap plane — register as the connection's root capability. */
  readonly bootstrap: HostBootstrap;
  /** The gated `HostControl` service `bootstrap.host()` hands out. */
  readonly control: HostControl;
  /** Connection-local phase gate (close it when the transport dies). */
  readonly gate: BootstrapGate;
  /**
   * Connection-liveness controller: the accept loop aborts it when the
   * transport closes, settling every `"session"` lease created over this
   * connection (DESIGN.md §5).
   */
  readonly connectionAbort: AbortController;
}

/**
 * Build the `HostControl` service for ONE authenticated connection. Every
 * method re-asserts the gate (defense in depth beyond the capability handout),
 * validates at the wire boundary, then delegates to the core. `create` binds a
 * `"session"` lease to `connectionSignal`.
 */
export function createHostControlAdapter(
  core: HostControlCore,
  gate: BootstrapGate,
  connectionSignal: AbortSignal,
): HostControl {
  return {
    create: async (params: CreateParams): Promise<WireCreateResult> => {
      try {
        gate.assertAuthorized();
        const input = createInputFromWire(params);
        const result = await core.create(input, { connectionSignal });
        return {
          which: "success",
          success: {
            sandbox: sandboxMetadataToWire(result.sandbox),
            ownerSecret: result.ownerSecret.slice(),
            lease: leaseInfoToWire(result.lease),
          },
        };
      } catch (error) {
        return { which: "error", error: hostFaultToWire(error) };
      }
    },
    attach: (params: AttachParams): Promise<WireAttachResult> => {
      try {
        gate.assertAuthorized();
        const id = requireBoundedId(params.id);
        const result = core.attach(id, params.ownerSecret ?? new Uint8Array(0));
        return Promise.resolve({
          which: "success",
          success: {
            sandbox: sandboxMetadataToWire(result.sandbox),
            lease: leaseInfoToWire(result.lease),
          },
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    sandbox: (id: string): Promise<RpcStub<HostSandbox>> => {
      gate.assertAuthorized();
      return Promise.resolve(
        createSandboxCapability(
          core,
          gate,
          requireBoundedId(id),
        ) as unknown as RpcStub<HostSandbox>,
      );
    },
    resumeLease: (): Promise<WireResumeResult> => {
      try {
        gate.assertAuthorized();
        // Durable-lease resume across a hostd restart lands post-M6; fail typed.
        return Promise.resolve({
          which: "error",
          error: wireError(
            "unsupportedFeature",
            "resumeLease is not yet wired (durable-lease resume)",
          ),
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    list: (): Promise<WireListResult> => {
      try {
        gate.assertAuthorized();
        return Promise.resolve({
          which: "success",
          success: { sandboxes: core.list().map(sandboxMetadataToWire) },
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    capacity: (): Promise<WireCapacityResult> => {
      try {
        gate.assertAuthorized();
        const report = core.capacity();
        return Promise.resolve({
          which: "capacity",
          capacity: {
            memoryTotalMiB: BigInt(report.memoryTotalMiB),
            memoryCommittedMiB: BigInt(report.memoryCommittedMiB),
            vcpusTotal: report.vcpusTotal,
            vcpusCommitted: report.vcpusCommitted,
            sandboxLimit: report.sandboxLimit,
            sandboxCount: report.sandboxCount,
          },
        });
      } catch (error) {
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
    },
    ping: (nonce: bigint): Promise<bigint> => {
      // `ping` carries no result union: a gate failure surfaces as a typed RPC
      // exception. The UInt64 nonce rides as `bigint` unchanged.
      gate.assertAuthorized();
      return Promise.resolve(nonce);
    },
  };
}

const MAX_ID_LENGTH = 64;

function requireBoundedId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new WireValidationError("sandbox id must be 1..64 characters");
  }
  return id;
}

/**
 * Build the wire services for ONE transport. The `gate` parameter is exposed so
 * the accept loop can fail the connection closed when its transport dies
 * (`gate.close()`); omit it to let the connection own a private gate.
 */
export function createHostControlWireConnection(
  options: HostControlWireOptions,
  gate: BootstrapGate = new BootstrapGate(
    options.maxAuthenticationFailures ?? 3,
  ),
): HostControlWireConnection {
  validateSupervisorCredential(options.credential);
  const expectedCredential = options.credential.slice();
  const connectionAbort = new AbortController();
  const control = createHostControlAdapter(
    options.core,
    gate,
    connectionAbort.signal,
  );

  const bootstrap: HostBootstrap = {
    negotiate: (offer): Promise<WireHandshakeResult> => {
      let decoded: ProtocolOffer;
      try {
        decoded = protocolOfferFromWire(offer);
      } catch (error) {
        gate.close();
        return Promise.resolve({
          which: "error",
          error: hostFaultToWire(error),
        });
      }
      try {
        const negotiated = gate.acceptNegotiation(
          negotiateProtocol(decoded, {
            identity: options.identity,
            ...(options.limitsCeiling === undefined
              ? {}
              : { ceiling: options.limitsCeiling }),
            requiredPeerFeatureBits: options.requiredPeerFeatureBits ??
              HOST_FEATURE_BITS,
            ...(options.knownSchemaPairs === undefined
              ? {}
              : { knownSchemaPairs: options.knownSchemaPairs }),
            ...(options.knownRuntimePairs === undefined
              ? {}
              : { knownRuntimePairs: options.knownRuntimePairs }),
          }),
        );
        return Promise.resolve({
          which: "accepted",
          accepted: negotiatedContractToWire(negotiated),
        });
      } catch (error) {
        if (error instanceof BootstrapRejectedError) {
          return Promise.resolve({
            which: "error",
            error: contractErrorToWire(error.error),
          });
        }
        if (error instanceof BootstrapStateError) {
          return Promise.resolve({
            which: "error",
            error: wireError("failedPrecondition", error.message),
          });
        }
        throw error;
      }
    },

    authenticate: (credential): Promise<WireAuthResult> => {
      // The compare runs unconditionally and in constant time; only the gate
      // decides whether the result may transition the phase.
      let verified = false;
      try {
        validateSupervisorCredential(credential);
        verified = timingSafeEqual(credential, expectedCredential);
      } catch {
        verified = false;
      }
      try {
        gate.recordAuthentication(verified);
      } catch (error) {
        if (error instanceof AuthenticationRejectedError) {
          return Promise.resolve({
            which: "error",
            error: wireError(
              "unauthenticated",
              error.connectionClosed
                ? "authentication failed; the connection is closed"
                : "authentication failed",
              { retryable: !error.connectionClosed },
            ),
          });
        }
        if (error instanceof BootstrapStateError) {
          return Promise.resolve({
            which: "error",
            error: wireError("failedPrecondition", error.message),
          });
        }
        throw error;
      }
      return Promise.resolve({
        which: "accepted",
        accepted: {
          sessionId: crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES)),
          // No wire-level session expiry: leases carry the real TTLs (M6).
          expiresAtUnixMs: 0n,
        },
      });
    },

    host: (): Promise<RpcStub<HostControl>> => {
      // No error arm: a pre-auth request fails closed as a typed RPC exception
      // and the gate latches shut.
      gate.assertAuthorized();
      return Promise.resolve(control as unknown as RpcStub<HostControl>);
    },
  };

  return { bootstrap, control, gate, connectionAbort };
}
