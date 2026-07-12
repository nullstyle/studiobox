/**
 * The studiobox-hostd control-plane DOMAIN core (PLAN.md §M6; DESIGN.md
 * §3 hostd role, §5 timeout/region rows, §9 resource accounting).
 *
 * {@linkcode HostControlCore} is a transport-free composition of the three M6
 * domain units — the {@linkcode CapacityLedger} (host budget), the
 * {@linkcode LeaseManager} (session/duration timeout clocks), and the
 * {@linkcode SingleUseTicketStore} (tunnel tickets) — over a
 * {@linkcode RootdGateway} (the hostd -> rootd supervisor client). The
 * `host_control.capnp` wire adapter in `./service.ts` is a thin layer over
 * this surface; nothing here imports generated bindings.
 *
 * Lifecycle, single kill path: every sandbox owns exactly one live lease from
 * `create`. A duration deadline firing on the injected clock, the creating
 * connection closing (a `"session"` lease), an explicit `Lease.release`, and an
 * explicit `HostSandbox.kill` ALL funnel through the lease manager's single
 * `onExpire(sandboxId)` hook, which drives the sandbox terminal: reclaim its
 * capacity reservation, revoke its tunnel tickets, and ask rootd to
 * `kill` the execution. `revokeAll` (hostd restart) is the ONE exception — it
 * drops leases and tickets SILENTLY (no rootd kills), because rootd's
 * destructive reconcile reclaims the orphaned executions on hostd's next start
 * (DESIGN.md §6).
 *
 * Studiobox widens the wire `Region` enum to admit `"loc"` (DESIGN.md §5): the
 * region is accepted, recorded as metadata, and otherwise ignored.
 *
 * @module
 */

import { HostCapacityError } from "../api/errors.ts";
import {
  CapacityLedger,
  type CapacityReport,
  type Reservation,
} from "./capacity.ts";
import {
  type Clock,
  type Lease as LeaseRecord,
  LeaseManager,
  type LeaseRenewal,
  type LeaseTimeout,
  systemClock,
} from "./leases.ts";
import { SingleUseTicketStore } from "../security/tickets.ts";
import type { RootdGateway } from "./supervisor_client.ts";
import type { SupervisorMachineUsage } from "../rootd/supervisor_core_api.ts";
import {
  type PrivilegedBridgeFactory,
  TunnelAuthorizer,
} from "./tunnel_authorizer.ts";
import {
  DEFAULT_TUNNEL_DIAL_BUDGET_MS,
  TunnelServer,
} from "./tunnel_server.ts";
import type { TunnelEndpoint } from "../transports/tunnel_client.ts";
import { DEFAULT_AGENT_VSOCK_PORT } from "../rootd/launch_planner.ts";

/** Studiobox-widened region set: the wire `"ord"`/`"ams"` plus local `"loc"`. */
export type HostRegion = "ord" | "ams" | "loc";

const MIB = 1024 * 1024;
/** DESIGN.md §5: default guest memory when the client leaves it unset. */
export const DEFAULT_MEMORY_MIB = 1280;
/** Per-sandbox overlay-disk reservation against the ledger (DESIGN.md §9). */
export const DEFAULT_OVERLAY_DISK_BYTES = 2 * 1024 * MIB;
/** Sandbox-id suffix grammar: Crockford-ish, excludes i/l/o (DESIGN.md §5). */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstuvwxyz";
const ID_SUFFIX_LEN = 20;
const OWNER_SECRET_BYTES = 32;
const BOOT_NONCE_BYTES = 32;
const IDEMPOTENCY_KEY_BYTES = 16;

/** One label pair (mirrors the wire `KeyValue`). */
export interface Label {
  readonly key: string;
  readonly value: string;
}

/** A key/value pair carried by the `RootdGateway` launch (logical ids only). */
export interface CreateSandboxInput {
  /** Session vs. absolute-duration timeout regime. */
  readonly timeout: LeaseTimeout;
  /** Requested guest memory in MiB; `0`/unset -> {@link DEFAULT_MEMORY_MIB}. */
  readonly memoryMiB: number;
  /** Recorded-as-metadata region (widened to admit `"loc"`). */
  readonly region: HostRegion;
  /** Labels (recorded as metadata). */
  readonly labels: readonly Label[];
  /** Idempotency key the client supplied (>=16 bytes; else minted). */
  readonly idempotencyKey: Uint8Array;
}

/** Extra create-time wiring the wire adapter supplies. */
export interface CreateSandboxContext {
  /**
   * Connection-liveness signal for a `"session"` timeout — the wire layer
   * aborts it when the creating transport closes. Ignored for `"duration"`.
   */
  readonly connectionSignal?: AbortSignal;
}

/** Immutable snapshot of one sandbox (maps to the wire `SandboxMetadata`). */
export interface SandboxSnapshot {
  readonly id: string;
  readonly state: SandboxState;
  readonly createdAtUnixMs: number;
  /** Absolute deadline for a duration timeout; `0` for a session sandbox. */
  readonly deadlineUnixMs: number;
  readonly labels: readonly Label[];
  readonly region: HostRegion;
  readonly bootNonce: Uint8Array;
  readonly liveLeases: number;
  readonly terminationReason: string;
}

/** Immutable snapshot of one lease (maps to the wire `LeaseInfo`). */
export interface LeaseSnapshot {
  readonly id: string;
  readonly generation: number;
  /** Resume secret (owner-only); empty for a non-owning `attach`. */
  readonly resumeSecret: Uint8Array;
  /** Absolute expiry for a duration lease; `0` for a session lease. */
  readonly expiresAtUnixMs: number;
  readonly timeout: LeaseTimeout;
}

/** Result of {@linkcode HostControlCore.create}. */
export interface CreateSandboxResult {
  readonly sandbox: SandboxSnapshot;
  /** Secret the client presents to later `attach`/`resumeLease`. */
  readonly ownerSecret: Uint8Array;
  readonly lease: LeaseSnapshot;
}

/** Result of {@linkcode HostControlCore.attach}. */
export interface AttachSandboxResult {
  readonly sandbox: SandboxSnapshot;
  readonly lease: LeaseSnapshot;
}

/**
 * Result of {@linkcode HostControlCore.openTunnel}: the single-use ticket, the
 * loopback endpoint it is spent against, and the binding the client echoes
 * back to the guest agent. The client dials `endpoint`, sends the `SBXTUN1`
 * preface carrying `ticket`, and — on `SBXACK1(Ok)` — speaks the capnp
 * `SandboxAgent` plane over the spliced connection (DESIGN.md §4).
 */
export interface TunnelGrant {
  /** The per-tunnel loopback endpoint the client presents its preface to. */
  readonly endpoint: TunnelEndpoint;
  /** The 32-byte single-use ticket (15s TTL, 10s dial budget). */
  readonly ticket: Uint8Array;
  /** Guest AF_VSOCK port the bridge dials (studioboxd's listener). */
  readonly guestPort: number;
  /** Absolute ticket expiry (unix ms). */
  readonly expiresAtUnixMs: number;
  /** The sandbox the tunnel reaches (public `sbx_loc_…` id). */
  readonly sandboxId: string;
  /** Per-boot nonce, echoed to the guest agent's authenticate. */
  readonly bootNonce: Uint8Array;
  /** The lease the tunnel is bound to (revoked with it). */
  readonly leaseId: string;
  /** The lease generation at issue (the ticket binding). */
  readonly leaseGeneration: number;
}

/** The wire `SandboxState` mirror (upstream lifecycle). */
export type SandboxState =
  | "creating"
  | "running"
  | "stopping"
  | "terminated"
  | "cleanupPending";

export type HostControlErrorCode =
  /** No sandbox/lease resolves the given id. */
  | "SBX_HOST_NOT_FOUND"
  /** The presented owner/resume secret did not match. */
  | "SBX_HOST_PERMISSION"
  /** A request failed a create-time invariant. */
  | "SBX_HOST_VALIDATION"
  /** The operation is invalid for the sandbox's current phase. */
  | "SBX_HOST_STATE"
  /** The surface is scaffolded but not yet wired (M7/M10). */
  | "SBX_HOST_UNIMPLEMENTED";

/** Typed host-plane domain error; becomes `SbxError` on the wire adapter. */
export class HostControlError extends Error {
  readonly code: HostControlErrorCode;

  constructor(code: HostControlErrorCode, message: string) {
    super(message);
    this.name = "HostControlError";
    this.code = code;
  }
}

export interface HostControlCoreOptions {
  /** The hostd -> rootd supervisor client (or a fake in-process gateway). */
  readonly gateway: RootdGateway;
  /** The host capacity ledger (defaults to a fresh {@link CapacityLedger}). */
  readonly capacity?: CapacityLedger;
  /** The single-use tunnel-ticket store (defaults to a fresh store). */
  readonly tickets?: SingleUseTicketStore;
  /** Injected time source; defaults to {@link systemClock}. */
  readonly clock?: Clock;
  /** Sandbox-id suffix source (default: 20 random Crockford-ish chars). */
  readonly idFactory?: () => string;
  /** Secret source for owner/resume secrets (default: 32 random bytes). */
  readonly secretFactory?: () => Uint8Array;
  /** Boot-nonce source (default: 32 random bytes). */
  readonly bootNonceFactory?: () => Uint8Array;
  /** Per-sandbox overlay-disk reservation (default {@link DEFAULT_OVERLAY_DISK_BYTES}). */
  readonly overlayDiskBytes?: number;
  /**
   * Dials the guest-agent bridge for a burned ticket (studiobox-rootd's
   * `openBridge` splice, or a fake UDS conn in tests). When absent,
   * {@linkcode HostControlCore.openTunnel} fails typed-unimplemented.
   */
  readonly bridgeFactory?: PrivilegedBridgeFactory<Deno.Conn>;
  /**
   * Directory the per-tunnel UDS endpoints are bound under. A fresh temp dir
   * is created lazily when omitted; keep it short (`sun_path` ~104B).
   */
  readonly tunnelSocketDir?: string;
  /** Dial budget for a valid preface. @default {@link DEFAULT_TUNNEL_DIAL_BUDGET_MS} */
  readonly tunnelDialBudgetMs?: number;
  /** Guest AF_VSOCK port the bridge dials. @default {@link DEFAULT_AGENT_VSOCK_PORT} */
  readonly agentVsockPort?: number;
}

interface SandboxEntry {
  readonly id: string;
  /** rootd sandbox id (hyphen grammar) bound to this local sandbox. */
  readonly rootdSandboxId: string;
  /** rootd execution id driven by the gateway. */
  readonly executionId: string;
  state: SandboxState;
  readonly createdAtUnixMs: number;
  readonly labels: readonly Label[];
  readonly region: HostRegion;
  readonly bootNonce: Uint8Array;
  readonly reservation: Reservation;
  readonly ownerSecret: Uint8Array;
  currentLeaseId: string;
  liveLeases: number;
  readonly timeout: LeaseTimeout;
  terminationReason: string;
}

/**
 * Composes the capacity ledger, lease manager, ticket store, and rootd gateway
 * into the host control plane. Transport-free: `./service.ts` adapts it onto
 * `host_control.capnp`.
 */
export class HostControlCore {
  readonly #gateway: RootdGateway;
  readonly #capacity: CapacityLedger;
  readonly #tickets: SingleUseTicketStore;
  readonly #clock: Clock;
  readonly #leases: LeaseManager;
  readonly #idFactory: () => string;
  readonly #secretFactory: () => Uint8Array;
  readonly #bootNonceFactory: () => Uint8Array;
  readonly #overlayDiskBytes: number;
  readonly #bridgeFactory: PrivilegedBridgeFactory<Deno.Conn> | undefined;
  readonly #tunnelDialBudgetMs: number;
  readonly #agentVsockPort: number;
  #tunnelSocketDir: string | undefined;
  #tunnelSocketDirOwned = false;
  /** Live per-tunnel endpoints per sandbox id, closed on lease expiry / restart. */
  readonly #tunnels = new Map<string, Set<TunnelServer>>();
  readonly #sandboxes = new Map<string, SandboxEntry>();
  /** Lease id -> sandbox id, so a Lease capability resolves its sandbox. */
  readonly #leaseToSandbox = new Map<string, string>();
  /** In-flight terminal-reclaim promises, awaitable via {@link drain}. */
  readonly #pending = new Set<Promise<void>>();
  /**
   * Restart epoch (DESIGN.md §6). Bumped by every {@link revokeAll}; a `create`
   * captures it up front and rolls back if it changes across an await, so a
   * hostd restart landing mid-create never leaves a live lease (whose timer
   * would later fire a forbidden rootd kill) or a committed reservation behind.
   */
  #epoch = 0;

  constructor(options: HostControlCoreOptions) {
    this.#gateway = options.gateway;
    this.#capacity = options.capacity ?? new CapacityLedger();
    this.#tickets = options.tickets ?? new SingleUseTicketStore();
    this.#clock = options.clock ?? systemClock;
    this.#idFactory = options.idFactory ?? defaultIdSuffix;
    this.#secretFactory = options.secretFactory ??
      (() => crypto.getRandomValues(new Uint8Array(OWNER_SECRET_BYTES)));
    this.#bootNonceFactory = options.bootNonceFactory ??
      (() => crypto.getRandomValues(new Uint8Array(BOOT_NONCE_BYTES)));
    this.#overlayDiskBytes = options.overlayDiskBytes ??
      DEFAULT_OVERLAY_DISK_BYTES;
    this.#bridgeFactory = options.bridgeFactory;
    this.#tunnelSocketDir = options.tunnelSocketDir;
    this.#tunnelDialBudgetMs = options.tunnelDialBudgetMs ??
      DEFAULT_TUNNEL_DIAL_BUDGET_MS;
    this.#agentVsockPort = options.agentVsockPort ?? DEFAULT_AGENT_VSOCK_PORT;
    this.#leases = new LeaseManager({
      clock: this.#clock,
      onExpire: (sandboxId) => this.#onLeaseExpire(sandboxId),
    });
  }

  /** Live lease count (hostd-restart revocation assertion seam). */
  get leaseCount(): number {
    return this.#leases.size;
  }

  /** Outstanding tunnel-ticket count (hostd-restart revocation assertion seam). */
  get ticketCount(): number {
    return this.#tickets.size;
  }

  /**
   * Reserve capacity, launch via rootd, and issue the creating lease. On ANY
   * failure after the reservation is taken the reservation is rolled back and
   * (if the launch already reached rootd) the execution is killed, so a failed
   * create leaks neither budget nor a live VM.
   */
  async create(
    input: CreateSandboxInput,
    context: CreateSandboxContext = {},
  ): Promise<CreateSandboxResult> {
    validateTimeout(input.timeout);
    if (
      input.timeout.kind === "session" && context.connectionSignal === undefined
    ) {
      throw new HostControlError(
        "SBX_HOST_VALIDATION",
        "a session-timeout sandbox requires a live creating connection",
      );
    }
    const memoryMiB = input.memoryMiB > 0
      ? input.memoryMiB
      : DEFAULT_MEMORY_MIB;

    // 1) Mint ids/nonce BEFORE reserving budget. These call injectable
    // factories; running them ahead of the reservation means a factory throw
    // fails the create with nothing committed to leak (there is no reservation
    // to roll back yet).
    const suffix = this.#idFactory();
    const id = `sbx_loc_${suffix}`;
    const rootdSandboxId = `sbx-loc-${suffix}`;
    const executionId = `exec-${suffix}`;
    const bootNonce = this.#bootNonceFactory();
    const idempotencyKey =
      input.idempotencyKey.byteLength >= IDEMPOTENCY_KEY_BYTES
        ? input.idempotencyKey.slice()
        : crypto.getRandomValues(new Uint8Array(IDEMPOTENCY_KEY_BYTES));

    // Capture the restart epoch before the first await. A revokeAll() landing
    // while this create is in flight bumps it; we detect that after each await
    // and roll back rather than register a lease that would survive the restart.
    const epoch = this.#epoch;

    // 2) Reserve host budget. A rejection here (over-capacity) fails fast with
    // HostCapacityError before anything is spawned.
    const reservation = await this.#capacity.reserve({
      memory: memoryMiB * MIB,
      diskBytes: this.#overlayDiskBytes,
    });

    let launched = false;
    try {
      // A revokeAll() that ran during reserve() means this create belongs to a
      // pre-restart epoch: roll back before launching anything.
      if (this.#epoch !== epoch) {
        throw new HostControlError(
          "SBX_HOST_STATE",
          "hostd restarted during create; sandbox rolled back",
        );
      }

      // 3) Ask rootd to launch (journal-before-spawn on the rootd side).
      await this.#gateway.launch({
        sandboxId: rootdSandboxId,
        executionId,
        artifactId: "artifact-loc",
        allocationId: `alloc-${suffix}`,
        bootNonce,
        idempotencyKey,
      });
      launched = true;

      // A revokeAll() that ran during launch() likewise belongs to the restart:
      // roll back WITHOUT arming a lease. The catch below deliberately fires no
      // rootd kill for a restart rollback — rootd's destructive reconcile
      // reclaims the orphaned execution on the next start (DESIGN.md §6).
      if (this.#epoch !== epoch) {
        throw new HostControlError(
          "SBX_HOST_STATE",
          "hostd restarted during create; sandbox rolled back",
        );
      }

      // 4) Issue the creating lease, bound to the timeout regime. onExpire is
      // the single kill path (see the module doc).
      const ownerSecret = this.#secretFactory();
      const createdAtUnixMs = this.#clock.now();
      const entry: SandboxEntry = {
        id,
        rootdSandboxId,
        executionId,
        state: "running",
        createdAtUnixMs,
        labels: input.labels.map((l) => ({ key: l.key, value: l.value })),
        region: input.region,
        bootNonce,
        reservation,
        ownerSecret,
        currentLeaseId: "",
        liveLeases: 1,
        timeout: input.timeout,
        terminationReason: "",
      };
      const lease = this.#leases.create({
        sandboxId: id,
        timeout: input.timeout,
        ...(context.connectionSignal === undefined
          ? {}
          : { connectionSignal: context.connectionSignal }),
      });
      entry.currentLeaseId = lease.id;
      this.#sandboxes.set(id, entry);
      this.#leaseToSandbox.set(lease.id, id);

      return {
        sandbox: snapshotSandbox(entry),
        ownerSecret: ownerSecret.slice(),
        lease: snapshotLease(lease, input.timeout, this.#secretFactory()),
      };
    } catch (error) {
      // Roll back: always release the reservation. A revokeAll() during this
      // create (epoch bumped) is a hostd restart — reclaim is rootd's job on
      // the next start, so fire NO kill and honor the "revokeAll fires no rootd
      // kills" invariant. For any other failure, if rootd already launched,
      // best-effort kill so no orphaned VM survives the failed create.
      const restarted = this.#epoch !== epoch;
      await this.#capacity.release(reservation).catch(() => {});
      if (launched && !restarted) {
        await this.#gateway.kill(executionId).catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Re-observe an existing sandbox from a second connection. Validates the
   * owner secret (constant time) and returns the sandbox metadata plus the
   * CURRENT lease's info — it does NOT mint a new lease (no `liveLeases` bump),
   * so an attach never extends the sandbox's lifetime. The returned lease
   * carries an empty resume secret (the attacher is not the lease owner).
   */
  attach(id: string, ownerSecret: Uint8Array): AttachSandboxResult {
    const entry = this.#requireEntry(id);
    if (!constantTimeEqual(ownerSecret, entry.ownerSecret)) {
      throw new HostControlError(
        "SBX_HOST_PERMISSION",
        "owner secret does not match",
      );
    }
    // A terminated sandbox keeps its entry (list/metadata still surface it), but
    // its lease is gone. Attaching to it must reject with a typed state error
    // rather than fabricate a phantom (detached) lease for a dead sandbox.
    if (isTerminal(entry.state)) {
      throw new HostControlError(
        "SBX_HOST_STATE",
        `sandbox ${id} is ${entry.state}`,
      );
    }
    // A live-state sandbox must have a live lease. If it doesn't, its lease was
    // revoked out from under it (e.g. revokeAll on a hostd restart, which leaves
    // state='running' while rootd reconciles the VM away) — reject rather than
    // fabricate a phantom lease carrying a deadline that will never fire.
    const lease = this.#leases.get(entry.currentLeaseId);
    if (lease === undefined) {
      throw new HostControlError(
        "SBX_HOST_STATE",
        `sandbox ${id} has no live lease`,
      );
    }
    return {
      sandbox: snapshotSandbox(entry),
      lease: snapshotLease(lease, entry.timeout, new Uint8Array(0)),
    };
  }

  /** Snapshots of every sandbox this hostd knows (including terminated). */
  list(): SandboxSnapshot[] {
    return Array.from(this.#sandboxes.values(), snapshotSandbox);
  }

  /** Host-wide committed-vs-total capacity snapshot. */
  capacity(): CapacityReport {
    return this.#capacity.capacity();
  }

  /** Metadata for one sandbox. */
  metadata(id: string): SandboxSnapshot {
    return snapshotSandbox(this.#requireEntry(id));
  }

  /** Live resource usage for one sandbox (delegates to rootd). */
  usage(id: string): Promise<SupervisorMachineUsage> {
    const entry = this.#requireEntry(id);
    return this.#gateway.usage(entry.executionId);
  }

  /**
   * Open a ticketed tunnel to the sandbox's guest agent (DESIGN.md §4; PLAN.md
   * §M7). Issues a single-use ticket bound to the sandbox + current lease,
   * stands up a per-tunnel loopback endpoint, and returns the {@link TunnelGrant}
   * the client dials. The ticket is BURNED by the endpoint's authorizer BEFORE
   * rootd's bridge is ever opened; the endpoint is freed when the authorized
   * splice ends, when the 10s dial budget lapses unused, or when the lease is
   * revoked (which also revokes the ticket).
   *
   * Rejects a sandbox with no live lease (`SBX_HOST_STATE`) and, until a bridge
   * factory is wired, fails typed-unimplemented (`SBX_HOST_UNIMPLEMENTED`).
   */
  async openTunnel(id: string): Promise<TunnelGrant> {
    const entry = this.#requireEntry(id);
    if (this.#bridgeFactory === undefined) {
      throw new HostControlError(
        "SBX_HOST_UNIMPLEMENTED",
        "openTunnel requires a rootd bridge factory",
      );
    }
    if (isTerminal(entry.state)) {
      throw new HostControlError(
        "SBX_HOST_STATE",
        `sandbox ${id} is terminated`,
      );
    }
    const lease = this.#leases.get(entry.currentLeaseId);
    if (lease === undefined) {
      throw new HostControlError(
        "SBX_HOST_STATE",
        `sandbox ${id} has no live lease to bind a tunnel to`,
      );
    }

    // The ticket binding and the bridge request both carry the PUBLIC id: the
    // authorizer requires request.sandboxId === binding.sandboxId, and the same
    // id keys ticket revocation (#onLeaseExpire / revokeAll). rootd resolves the
    // guest by executionId, so the public id never has to reach the wire.
    const binding = {
      sessionId: entry.currentLeaseId,
      sandboxId: entry.id,
      bootNonce: toHex(entry.bootNonce),
      leaseGeneration: lease.generation,
    };
    const issued = await this.#tickets.issue(binding);

    const authorizer = new TunnelAuthorizer(this.#tickets, this.#bridgeFactory);
    let server: TunnelServer;
    try {
      server = TunnelServer.open({
        authorizer,
        binding,
        bridgeRequest: {
          sandboxId: entry.id,
          executionId: entry.executionId,
          guestPort: this.#agentVsockPort,
        },
        listen: {
          transport: "unix",
          path: await this.#allocTunnelSocketPath(),
        },
        ttlMs: this.#tunnelDialBudgetMs,
      });
    } catch (error) {
      // Could not stand up the endpoint: revoke the just-issued ticket so it
      // cannot be spent against a bridge with no server in front of it.
      this.#tickets.revokeSandbox(entry.id);
      throw error;
    }
    this.#trackTunnel(entry.id, server);

    return {
      endpoint: server.endpoint,
      ticket: issued.ticket,
      guestPort: this.#agentVsockPort,
      expiresAtUnixMs: issued.expiresAt,
      sandboxId: entry.id,
      bootNonce: entry.bootNonce.slice(),
      leaseId: entry.currentLeaseId,
      leaseGeneration: lease.generation,
    };
  }

  /**
   * Extend a sandbox's duration deadline by up to the lease manager's per-call
   * cap, returning the actual new absolute deadline and the (unchanged) lease
   * generation. Rejects a session sandbox with `SBX_HOST_STATE`.
   */
  extendTimeout(
    id: string,
    milliseconds: number,
  ): { deadlineUnixMs: number; leaseGeneration: number } {
    const entry = this.#requireEntry(id);
    const deadlineUnixMs = mapLeaseError(() =>
      this.#leases.extendTimeout(entry.currentLeaseId, milliseconds)
    );
    const lease = this.#leases.get(entry.currentLeaseId);
    return {
      deadlineUnixMs,
      leaseGeneration: lease?.generation ?? 1,
    };
  }

  /** Renew a lease by its id, returning the bumped generation + new deadline. */
  renewLease(leaseId: string): { generation: number; expiresAtUnixMs: number } {
    const renewal: LeaseRenewal = mapLeaseError(() =>
      this.#leases.renew(leaseId, LEASE_RENEW_MS)
    );
    return {
      generation: renewal.generation,
      expiresAtUnixMs: renewal.deadlineUnixMs,
    };
  }

  /** Explicit lease release: settles the lease, killing its sandbox. */
  releaseLease(leaseId: string): void {
    const sandboxId = this.#leaseToSandbox.get(leaseId);
    if (sandboxId !== undefined) {
      const entry = this.#sandboxes.get(sandboxId);
      if (entry !== undefined && entry.terminationReason.length === 0) {
        entry.terminationReason = "released";
      }
    }
    this.#leases.release(leaseId);
  }

  /** Explicit kill: settles the current lease, killing the sandbox. */
  killSandbox(id: string): void {
    const entry = this.#requireEntry(id);
    if (isTerminal(entry.state)) return;
    if (entry.terminationReason.length === 0) {
      entry.terminationReason = "killed";
    }
    this.#leases.release(entry.currentLeaseId);
  }

  /** Whether the leaseId resolves a live sandbox (for the wire Lease handout). */
  leaseSandboxId(leaseId: string): string | undefined {
    return this.#leaseToSandbox.get(leaseId);
  }

  /** The current lease id of a sandbox (for the wire Lease handout). */
  currentLeaseId(id: string): string {
    return this.#requireEntry(id).currentLeaseId;
  }

  /**
   * hostd restart (DESIGN.md §6): drop every lease and tunnel ticket SILENTLY.
   * Fires no rootd kills — rootd's destructive reconcile reclaims the orphaned
   * executions on the next start.
   */
  revokeAll(): void {
    // Bump the epoch first so any create() currently parked at an await point
    // observes the restart and rolls back instead of registering a live lease.
    this.#epoch += 1;
    this.#leases.revokeAll();
    for (const entry of this.#sandboxes.values()) {
      this.#tickets.revokeSandbox(entry.id);
      this.#closeTunnels(entry.id);
    }
    this.#leaseToSandbox.clear();
  }

  /** Await every in-flight terminal reclaim (test determinism seam). */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }

  /**
   * The single kill path: a duration deadline, a session-connection close, an
   * explicit release, or an explicit kill all land here. Reclaim capacity,
   * revoke tickets, and ask rootd to kill the execution.
   */
  #onLeaseExpire(sandboxId: string): void {
    const entry = this.#sandboxes.get(sandboxId);
    if (entry === undefined || isTerminal(entry.state)) return;
    entry.state = "terminated";
    entry.liveLeases = 0;
    if (entry.terminationReason.length === 0) {
      entry.terminationReason = "lease-expired";
    }
    this.#leaseToSandbox.delete(entry.currentLeaseId);
    this.#tickets.revokeSandbox(entry.id);
    // Free every live tunnel endpoint: the ticket is gone, so an in-flight
    // splice is now unbound and must be torn down with the sandbox.
    this.#closeTunnels(entry.id);
    const reclaim = (async () => {
      await this.#capacity.release(entry.reservation).catch(() => {});
      await this.#gateway.kill(entry.executionId).catch(() => {});
    })();
    this.#pending.add(reclaim);
    void reclaim.finally(() => this.#pending.delete(reclaim));
  }

  #requireEntry(id: string): SandboxEntry {
    const entry = this.#sandboxes.get(id);
    if (entry === undefined) {
      throw new HostControlError("SBX_HOST_NOT_FOUND", `no sandbox ${id}`);
    }
    return entry;
  }

  /** Track a live tunnel endpoint; self-prune when its splice / ttl frees it. */
  #trackTunnel(sandboxId: string, server: TunnelServer): void {
    let set = this.#tunnels.get(sandboxId);
    if (set === undefined) {
      set = new Set();
      this.#tunnels.set(sandboxId, set);
    }
    set.add(server);
    const forget = (): void => {
      const current = this.#tunnels.get(sandboxId);
      if (current === undefined) return;
      current.delete(server);
      if (current.size === 0) this.#tunnels.delete(sandboxId);
    };
    // Both edges converge on forget(): finished resolves on natural teardown
    // (splice EOF / ttl lapse), and the reclaim path calls close() directly.
    void server.finished.then(forget);
  }

  /** Close (and free) every endpoint of one sandbox — a reclaim-path step. */
  #closeTunnels(sandboxId: string): void {
    const set = this.#tunnels.get(sandboxId);
    if (set === undefined) return;
    this.#tunnels.delete(sandboxId);
    for (const server of set) void server.close();
  }

  /** Allocate a short per-tunnel UDS path under the (lazily created) socket dir. */
  async #allocTunnelSocketPath(): Promise<string> {
    if (this.#tunnelSocketDir === undefined) {
      this.#tunnelSocketDir = await Deno.makeTempDir({ prefix: "sbx-tun-" });
      this.#tunnelSocketDirOwned = true;
    }
    const name = `t-${crypto.randomUUID().slice(0, 8)}.sock`;
    return `${this.#tunnelSocketDir}/${name}`;
  }

  /**
   * Close every live tunnel endpoint (hostd shutdown / test teardown) and
   * remove the owned socket directory. Idempotent; leaves no listener or
   * socket file behind.
   */
  async closeAllTunnels(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const set of this.#tunnels.values()) {
      for (const server of set) pending.push(server.close());
    }
    this.#tunnels.clear();
    await Promise.allSettled(pending);
    if (this.#tunnelSocketDirOwned && this.#tunnelSocketDir !== undefined) {
      await Deno.remove(this.#tunnelSocketDir, { recursive: true }).catch(
        () => {},
      );
      this.#tunnelSocketDir = undefined;
      this.#tunnelSocketDirOwned = false;
    }
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Per-call renew grant (matches the lease manager's default cap). */
const LEASE_RENEW_MS = 30 * 60_000;

function validateTimeout(timeout: LeaseTimeout): void {
  if (timeout.kind === "duration") {
    if (!Number.isSafeInteger(timeout.durationMs) || timeout.durationMs <= 0) {
      throw new HostControlError(
        "SBX_HOST_VALIDATION",
        "a duration timeout requires a positive integer of milliseconds",
      );
    }
  } else if (timeout.kind !== "session") {
    throw new HostControlError(
      "SBX_HOST_VALIDATION",
      "timeout must be session or duration",
    );
  }
}

function snapshotSandbox(entry: SandboxEntry): SandboxSnapshot {
  return {
    id: entry.id,
    state: entry.state,
    createdAtUnixMs: entry.createdAtUnixMs,
    deadlineUnixMs: deadlineOf(entry),
    labels: entry.labels,
    region: entry.region,
    bootNonce: entry.bootNonce.slice(),
    liveLeases: entry.liveLeases,
    terminationReason: entry.terminationReason,
  };
}

function deadlineOf(entry: SandboxEntry): number {
  return entry.timeout.kind === "duration"
    ? entry.createdAtUnixMs + entry.timeout.durationMs
    : 0;
}

function snapshotLease(
  lease: LeaseRecord,
  timeout: LeaseTimeout,
  resumeSecret: Uint8Array,
): LeaseSnapshot {
  return {
    id: lease.id,
    generation: lease.generation,
    resumeSecret: resumeSecret.slice(),
    expiresAtUnixMs: lease.deadlineUnixMs ?? 0,
    timeout,
  };
}

function isTerminal(state: SandboxState): boolean {
  return state === "terminated";
}

function defaultIdSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_SUFFIX_LEN));
  let out = "";
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Re-throw a lease-manager error as the host plane's typed error. */
function mapLeaseError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error) {
      const code = (error as { code: unknown }).code;
      if (code === "SBX_LEASE_NOT_FOUND") {
        throw new HostControlError("SBX_HOST_NOT_FOUND", errorMessage(error));
      }
      if (code === "SBX_LEASE_EXPIRED" || code === "SBX_LEASE_KIND") {
        throw new HostControlError("SBX_HOST_STATE", errorMessage(error));
      }
      if (code === "SBX_LEASE_INVALID") {
        throw new HostControlError("SBX_HOST_VALIDATION", errorMessage(error));
      }
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-export the capacity rejection so callers can catch a single type.
export { HostCapacityError };
