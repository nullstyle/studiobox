/**
 * The host-side studioboxd dialer (PLAN.md §M5; DEFECT A, dial leg).
 *
 * {@linkcode SupervisorCore.connectAgent} returns a raw byte stream (a
 * `@nullstyle/firecracker` `VsockConn`, structurally a `Deno.Conn`). This
 * module wraps that stream in the `sandbox_agent.capnp` client and runs
 * the fail-closed `negotiate -> authenticate -> agent()` handshake — the
 * bootstrap the supervisor's host peer needs to drive the guest.
 *
 * DEFECT A (availability, dial side): a peer that accepts the vsock and
 * then sends a malformed/oversized/incomplete TRANSPORT frame — or simply
 * goes silent — must NOT hang the host dialer forever, and must not leak
 * the local wire session. The published `@nullstyle/capnp` `connect()`
 * helper does NOT auto-wire remote-EOF teardown, and an in-flight call
 * hangs indefinitely unless the caller bounds it (pinned in
 * `tests/unit/rpc_conformance/transport_close_ownership_test.ts`). So this
 * dialer, mirroring the serving side (`src/agent/main.ts`):
 *
 *   - wires the transport `onClose` to the wire-client `close()` (a peer
 *     EOF / RST surfaces every in-flight call as a typed error), and
 *     `onError` likewise, so an out-of-band failure tears the local
 *     session down instead of escaping as an unhandled rejection;
 *   - bounds every step — bootstrap acquisition, `negotiate`,
 *     `authenticate`, `agent()`, and the wire client's default — with an
 *     explicit timeout, so a silent or garbage-spewing peer surfaces a
 *     {@linkcode SupervisorError} PROMPTLY (never a hang); and
 *   - closes the wire client + transport on any failure before rethrowing,
 *     so a failed dial leaks nothing.
 *
 * @module
 */

import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";
import {
  AGENT_PLANE_FEATURES,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../agent/service.ts";
import type { GuestNetworkConfig } from "../agent/personalize.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../wire/contract.ts";
import * as wire from "../wire/generated/sandbox_agent_types.ts";
import { SupervisorError } from "./supervisor_core_api.ts";

/** Default bound for each handshake step (bootstrap + per-call). */
export const DEFAULT_AGENT_DIAL_TIMEOUT_MS = 15_000;
/** Build id the host peer presents to studioboxd's `negotiate`. */
export const DEFAULT_HOST_DIAL_BUILD_ID = "studiobox-rootd/m5";

/** Everything a dial+handshake needs beyond the connected byte stream. */
export interface AgentDialOptions {
  /** Raw credential the launch minted; presented to `authenticate`. */
  readonly credential: Uint8Array;
  /** Sandbox id bound to the launch (checked by the guest if configured). */
  readonly sandboxId: string;
  /** Per-boot nonce bound to the launch (checked if configured). */
  readonly bootNonce: Uint8Array;
  /** Build id presented to `negotiate`. @default DEFAULT_HOST_DIAL_BUILD_ID */
  readonly callerBuildId?: string;
  /**
   * Bound (ms) for bootstrap acquisition and each handshake call, and the
   * wire client's default call timeout. @default DEFAULT_AGENT_DIAL_TIMEOUT_MS
   */
  readonly timeoutMs?: number;
}

/** A live, authenticated agent-plane session over one dialed connection. */
export interface AgentSession extends AsyncDisposable {
  /** The authenticated `SandboxAgent` root. */
  readonly agent: RpcStub<wire.SandboxAgent>;
  /** The wire client, for exporting client-hosted capabilities (sinks). */
  readonly wireClient: RpcWireClient;
}

/** Options for a call whose RESULT retains a capability (see agent tests). */
function capCall(timeoutMs: number) {
  return { timeoutMs, finish: { releaseResultCaps: false } } as const;
}

/**
 * Dial an established studioboxd byte stream: wrap it, run the bounded
 * fail-closed bootstrap, and return the authenticated agent plane. Rejects
 * with a typed {@linkcode SupervisorError} (`SBX_SUP_UNAVAILABLE`) — never
 * hangs — if the peer stalls, sends a malformed/over-limit frame, rejects
 * the handshake, or disconnects, and tears the local session down first.
 *
 * The caller owns `conn`'s lifetime only until this resolves; on success
 * the returned session's `Symbol.asyncDispose` closes the wire client and
 * transport (which closes `conn`). On rejection this closes them itself.
 */
export async function openAgentSession(
  conn: Deno.Conn,
  options: AgentDialOptions,
): Promise<AgentSession> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_DIAL_TIMEOUT_MS;
  const buildId = options.callerBuildId ?? DEFAULT_HOST_DIAL_BUILD_ID;

  let wireClient: RpcWireClient | null = null;
  // Close-ownership contract: bind teardown to BOTH lifecycle edges so a
  // peer EOF/RST or an out-of-band transport fault surfaces every pending
  // call as a typed error and releases the local session (rather than
  // hanging or leaking). See the module doc.
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: timeoutMs,
    frameLimits: { maxFrameBytes: DEFAULT_TRANSPORT_LIMITS.maxFrameBytes },
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => void wireClient?.close().catch(() => {}),
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: timeoutMs });
  const client = wireClient;

  try {
    const bootstrap = await wire.AgentBootstrap.bootstrapClient(client, {
      timeoutMs,
    });
    const handshake = await bootstrap.negotiate({
      identity: identityToWire(m3AgentContractIdentity(buildId)),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs });
    if (handshake.which !== "accepted") {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `studioboxd rejected negotiation: ${
          handshake.error?.message ?? "unknown"
        }`,
      );
    }
    const auth = await bootstrap.authenticate({
      credential: options.credential,
      sandboxId: options.sandboxId,
      bootNonce: options.bootNonce,
    }, { timeoutMs });
    if (auth.which !== "accepted") {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `studioboxd rejected authentication: ${
          auth.error?.message ?? "unknown"
        }`,
      );
    }
    const agent = await bootstrap.agent(capCall(timeoutMs));
    return {
      agent,
      wireClient: client,
      async [Symbol.asyncDispose]() {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      },
    };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    if (error instanceof SupervisorError) throw error;
    // A timeout, a transport/session error, or a peer disconnect: normalize
    // to the supervisor's typed "agent not reachable/healthy" surface so a
    // caller never has to hang or reason about capnp internals.
    throw new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      `studioboxd handshake failed or timed out: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

/** Everything the one-shot restore `personalize` step needs (snapshot-restore §2.3). */
export interface PersonalizeDialOptions {
  /** Per-restore credential the later `authenticate` must present (32 bytes). */
  readonly credential: Uint8Array;
  /** Per-restore boot nonce bound on the guest (checked at `authenticate`). */
  readonly bootNonce: Uint8Array;
  /** Sandbox id bound on the guest (checked at `authenticate`). */
  readonly sandboxId: string;
  /** In-band NIC config (empty `guestCidr` ⇒ netless: the guest leaves eth0 down). */
  readonly network: GuestNetworkConfig;
  /** Build id presented to `negotiate`. @default DEFAULT_HOST_DIAL_BUILD_ID */
  readonly callerBuildId?: string;
  /** Bound (ms) for bootstrap acquisition and each call. @default DEFAULT_AGENT_DIAL_TIMEOUT_MS */
  readonly timeoutMs?: number;
}

/** What a successful restore `personalize` reports back for logging. */
export interface PersonalizeSessionOutcome {
  /** studioboxd buildId echoed by the guest. */
  readonly buildId: string;
  /** The guest CIDR the guest applied; empty when netless. */
  readonly appliedCidr: string;
}

/**
 * Dial a restored studioboxd byte stream and inject its per-restore identity
 * (snapshot-restore §2.3, §4 step 4): wrap the stream, run the bounded
 * fail-closed `negotiate` (verifying the guest's `ContractIdentity` matches, so
 * caller and guest agree on the exact schema build), then call the pre-auth
 * `personalize @3` with `{credential, bootNonce, sandboxId, network}`. On
 * success the guest sets the credential a later `authenticate` must present and
 * reconfigures `eth0` in-band; `personalize` is then rejected as already done.
 *
 * `personalize` is ONE-SHOT — there is no retained session — so this closes the
 * wire client + transport (which closes `conn`) on BOTH success and failure.
 * Rejects with a typed {@linkcode SupervisorError} (`SBX_SUP_UNAVAILABLE`) —
 * never hangs — if the peer stalls, sends a malformed/over-limit frame, rejects
 * the handshake or personalize, or disconnects. The core maps that typed
 * failure to its cold fallback (§5.3), so a template problem never fails a
 * create.
 */
export async function openPersonalizeSession(
  conn: Deno.Conn,
  options: PersonalizeDialOptions,
): Promise<PersonalizeSessionOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_DIAL_TIMEOUT_MS;
  const buildId = options.callerBuildId ?? DEFAULT_HOST_DIAL_BUILD_ID;

  let wireClient: RpcWireClient | null = null;
  // Same close-ownership contract as openAgentSession: bind teardown to both
  // lifecycle edges so a peer EOF/RST or an out-of-band transport fault
  // surfaces every pending call as a typed error and releases the session.
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: timeoutMs,
    frameLimits: { maxFrameBytes: DEFAULT_TRANSPORT_LIMITS.maxFrameBytes },
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => void wireClient?.close().catch(() => {}),
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: timeoutMs });
  const client = wireClient;

  try {
    const bootstrap = await wire.AgentBootstrap.bootstrapClient(client, {
      timeoutMs,
    });
    const handshake = await bootstrap.negotiate({
      identity: identityToWire(m3AgentContractIdentity(buildId)),
      limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
      requiredFeatureBits: AGENT_PLANE_FEATURES,
    }, { timeoutMs });
    if (handshake.which !== "accepted") {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `studioboxd rejected negotiation: ${
          handshake.error?.message ?? "unknown"
        }`,
      );
    }
    const result = await bootstrap.personalize({
      credential: options.credential,
      bootNonce: options.bootNonce,
      sandboxId: options.sandboxId,
      network: {
        guestCidr: options.network.guestCidr,
        gateway: options.network.gateway,
        dns: options.network.dns,
        iface: options.network.iface,
      },
    }, { timeoutMs });
    if (result.which !== "ok") {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `studioboxd rejected personalize: ${
          result.error?.message ?? "unknown"
        }`,
      );
    }
    return {
      buildId: result.ok?.buildId ?? "",
      appliedCidr: result.ok?.appliedCidr ?? "",
    };
  } catch (error) {
    if (error instanceof SupervisorError) throw error;
    // A timeout, a transport/session error, or a peer disconnect: normalize to
    // the typed "restore not personalizable" surface the core's fallback
    // catches (§5.3) so a caller never has to hang or reason about capnp.
    throw new SupervisorError(
      "SBX_SUP_UNAVAILABLE",
      `studioboxd personalize failed or timed out: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  } finally {
    // One-shot: always tear the local session down (closes conn), success or not.
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
