/**
 * The real {@linkcode HostProbe}: a bounded HostControl client that `host
 * doctor` dials against the forwarded control port (PLAN.md §M9; DESIGN.md §11).
 *
 * This CONSUMES the committed hostd wire surface read-only — the generated
 * `HostBootstrap`/`HostControl` client plus `buildHostContractIdentity`,
 * `HOST_FEATURE_BITS`, and `protocolOfferToWire` — exactly as
 * `src/hostd/supervisor_client.ts` consumes rootd's. It owns none of the hostd
 * daemon; it only drives it like any client would.
 *
 * The bounded-ownership contract from `src/hostd/supervisor_client.ts` /
 * `src/rootd/agent_dialer.ts` applies: the transport `onClose`/`onError` both
 * drive the wire client's `close()`, every call is timeout-bounded, and a failed
 * handshake tears the local session down before rethrowing — so a wedged or
 * silent hostd surfaces PROMPTLY as a `negotiate` check failure, never a hang.
 *
 * The session is lazy: {@linkcode HostProbe.negotiate} performs the TCP connect
 * + handshake, so a refused connection, a rejected negotiation, a rejected
 * authentication, or a stall ALL surface through the doctor's `negotiate` check
 * ("detect a wedged daemon"). Later checks reuse the established control stub.
 *
 * @module
 */

import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";
import { HostBootstrap } from "../wire/generated/host_control_types.ts";
import type {
  CreateParams,
  HostControl,
} from "../wire/generated/host_control_types.ts";
import {
  type ContractIdentity,
  DEFAULT_TRANSPORT_LIMITS,
} from "../wire/contract.ts";
import { protocolOfferToWire } from "../rootd/service.ts";
import { HOST_FEATURE_BITS } from "../hostd/service.ts";
import type {
  HostCapacitySnapshot,
  HostProbe,
  QuarantinedRecord,
} from "./doctor.ts";

/** Default bound for the connect, each handshake step, and each domain call. */
export const DEFAULT_HOST_PROBE_TIMEOUT_MS = 15_000;
/** Duration a doctor canary is allowed to live if kill somehow never lands. */
const CANARY_TTL_MS = 60_000;

/** Where + how the probe dials hostd. */
export interface HostProbeOptions {
  /** The forwarded control endpoint (default `127.0.0.1:40000`). */
  readonly hostname?: string;
  readonly port: number;
  /** Local identity offered to hostd's `negotiate`. */
  readonly identity: ContractIdentity;
  /** The 32-byte bootstrap credential presented to `authenticate`. */
  readonly credential: Uint8Array;
  /** Bound (ms) for connect + each handshake/domain call. */
  readonly timeoutMs?: number;
  /** Feature bits hostd must support (defaults to the host plane's). */
  readonly requiredFeatureBits?: bigint;
}

/** Options for a call whose RESULT retains a capability (CLIENT CONTRACT). */
function capCall(timeoutMs: number) {
  return { timeoutMs, finish: { releaseResultCaps: false } } as const;
}

/** A quarantined record shows a quarantine/host-restart termination reason. */
function isQuarantineReason(reason: string): boolean {
  return /quarantin|host-restart/i.test(reason);
}

/** Best-effort release of a handed-out capability stub. */
async function releaseStub(stub: unknown): Promise<void> {
  const closer = (stub as { close?: () => unknown } | null)?.close;
  if (typeof closer === "function") {
    await Promise.resolve(closer.call(stub)).catch(() => {});
  }
}

/**
 * Build the lazy HostControl probe the doctor drives. Construction is cheap;
 * {@linkcode HostProbe.negotiate} performs the connect + handshake.
 */
export function createHostProbe(options: HostProbeOptions): HostProbe {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOST_PROBE_TIMEOUT_MS;
  const limits = DEFAULT_TRANSPORT_LIMITS;
  const requiredFeatureBits = options.requiredFeatureBits ?? HOST_FEATURE_BITS;

  let transport: TcpTransport | null = null;
  let client: RpcWireClient | null = null;
  let control: RpcStub<HostControl> | null = null;

  const closeLocal = async (): Promise<void> => {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    client = null;
    transport = null;
    control = null;
  };

  const requireControl = (): RpcStub<HostControl> => {
    if (control === null) {
      throw new Error("doctor probe not negotiated");
    }
    return control;
  };

  return {
    negotiate: async (): Promise<void> => {
      let conn: Deno.Conn;
      try {
        conn = await Deno.connect({ transport: "tcp", hostname, port });
      } catch (error) {
        throw new Error(
          `connect ${hostname}:${port} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      transport = new TcpTransport(conn, {
        closeTimeoutMs: timeoutMs,
        frameLimits: { maxFrameBytes: limits.maxFrameBytes },
        onClose: () => void client?.close().catch(() => {}),
        onError: () => void client?.close().catch(() => {}),
      });
      client = new RpcWireClient(transport, { defaultTimeoutMs: timeoutMs });
      try {
        const bootstrap = await HostBootstrap.bootstrapClient(client, {
          timeoutMs,
        });
        const handshake = await bootstrap.negotiate(
          protocolOfferToWire({
            identity: options.identity,
            limits,
            requiredFeatureBits,
          }),
          { timeoutMs },
        );
        if (handshake.which !== "accepted") {
          throw new Error(
            `hostd rejected negotiation: ${
              handshake.error?.message ?? "unknown"
            }`,
          );
        }
        const auth = await bootstrap.authenticate(options.credential.slice(), {
          timeoutMs,
        });
        if (auth.which !== "accepted") {
          throw new Error(
            `hostd rejected authentication: ${
              auth.error?.message ?? "unknown"
            }`,
          );
        }
        control = await bootstrap.host(capCall(timeoutMs));
      } catch (error) {
        await closeLocal();
        throw error;
      }
    },

    capacity: async (): Promise<HostCapacitySnapshot> => {
      const result = await requireControl().capacity({ timeoutMs });
      if (result.which !== "capacity" || result.capacity === undefined) {
        throw new Error(result.error?.message ?? "capacity() returned no data");
      }
      const c = result.capacity;
      return {
        memoryTotalMiB: Number(c.memoryTotalMiB),
        memoryCommittedMiB: Number(c.memoryCommittedMiB),
        vcpusTotal: c.vcpusTotal,
        vcpusCommitted: c.vcpusCommitted,
        sandboxLimit: c.sandboxLimit,
        sandboxCount: c.sandboxCount,
      };
    },

    createCanary: async (): Promise<string> => {
      const params: CreateParams = {
        options: {
          timeout: { which: "durationMs", durationMs: BigInt(CANARY_TTL_MS) },
          memoryMiB: 0,
          vcpus: 0,
          allowNet: [],
          labels: [{ key: "studiobox", value: "doctor-canary" }],
          region: "ord",
          netless: true,
          kernelArgs: [],
        },
        idempotencyKey: new Uint8Array(0),
      };
      const result = await requireControl().create(params, { timeoutMs });
      if (result.which !== "success" || result.success === undefined) {
        throw new Error(result.error?.message ?? "create returned no sandbox");
      }
      return result.success.sandbox.id;
    },

    killCanary: async (id: string): Promise<void> => {
      const sandbox = await requireControl().sandbox(id, capCall(timeoutMs));
      try {
        const result = await sandbox.kill({ timeoutMs });
        if (result.which !== "ok") {
          throw new Error(result.error?.message ?? "kill returned no ok");
        }
      } finally {
        await releaseStub(sandbox);
      }
    },

    listQuarantined: async (): Promise<readonly QuarantinedRecord[]> => {
      const result = await requireControl().list({ timeoutMs });
      if (result.which !== "success" || result.success === undefined) {
        throw new Error(result.error?.message ?? "list returned no sandboxes");
      }
      return result.success.sandboxes
        .filter((meta) => isQuarantineReason(meta.terminationReason))
        .map((meta) => ({ id: meta.id, reason: meta.terminationReason }));
    },

    close: closeLocal,
  };
}
