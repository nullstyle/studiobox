/**
 * The {@linkcode ReclaimHook} that tears a sandbox's egress table down when its
 * record reaches a terminal phase — the concrete, ready-to-register integration
 * point for the egress module.
 *
 * ## Integration point (left for M6/M10 convergence — NOT wired yet)
 *
 * This hook is intentionally *not* registered on the {@linkcode
 * import("../supervisor_core.ts").SupervisorCore} from `launch_planner.ts` yet
 * (that wiring lands when the M6 control plane and M10 Tier-B emulation meet on
 * the main line). When it does, the integration is:
 *
 * 1. During launch, after the TAP / netns are created, call
 *    `EgressController.applyAllowNet(options.allowNet, handle)` and journal the
 *    `tapName` / `netnsPath` onto `SandboxRecord.resources`. Treat an
 *    {@linkcode import("./apply.ts").EgressApplyError} as fatal: abort the boot
 *    and reclaim the TAP (the ruleset already fails closed / sealed).
 * 2. Register `new EgressReclaimHook(controller, { netnsFor }).hook` in the
 *    `SupervisorCore` `reclaimHooks` array, alongside the artifact reclaim hook,
 *    so it runs on every terminate and during composed reconciliation.
 *
 * The hook derives the table name from the record's own id (matching what
 * `apply` installed) and removes it by exact name — never a wildcard sweep of
 * shared nft state (DESIGN.md §8).
 *
 * @module
 */

import type { SandboxRecord } from "../../state/model.ts";
import type { ReclaimHook } from "../supervisor_core.ts";
import type { EgressController } from "./apply.ts";
import {
  type SubnetAllocation,
  type SubnetAllocator,
  subnetForSlot,
  TAP_NAME_PREFIX,
} from "./allocator.ts";
import type { NetworkController } from "./dataplane.ts";
import type { DnsmasqController } from "./dnsmasq.ts";
import type { PortForwardController } from "./port_forward.ts";

export interface EgressReclaimHookOptions {
  /**
   * Map a record to the network namespace name its egress table lives in, or
   * `undefined` for the host namespace. The netns naming convention is owned by
   * the (not-yet-built) launch integration, so this is injected rather than
   * guessed. Defaults to the host namespace.
   */
  readonly netnsFor?: (record: SandboxRecord) => string | undefined;
}

/**
 * Bridges {@linkcode EgressController.reclaim} into the supervisor's
 * {@linkcode ReclaimHook} seam. A throwing reclaim parks the record in
 * `quarantined` (the supervisor's contract), which is correct: a leaked egress
 * chain must be surfaced, never silently dropped.
 */
export class EgressReclaimHook implements ReclaimHook {
  readonly name = "egress-nftables";
  readonly #controller: EgressController;
  readonly #netnsFor: (record: SandboxRecord) => string | undefined;

  constructor(
    controller: EgressController,
    options: EgressReclaimHookOptions = {},
  ) {
    this.#controller = controller;
    this.#netnsFor = options.netnsFor ?? (() => undefined);
  }

  async reclaim(record: SandboxRecord): Promise<void> {
    // No TAP was ever journaled ⇒ this sandbox never had an egress table.
    if (record.resources.tapName === undefined) return;
    const netns = this.#netnsFor(record);
    await this.#controller.reclaim({
      sandboxId: record.id,
      ...(netns === undefined ? {} : { netns }),
    });
  }
}

/**
 * Parse the allocation slot out of a `sbxtap<slot>` TAP device name (§2). The
 * slot is the natural teardown / reuse key: it rebuilds the
 * {@linkcode SubnetAllocation} handle {@linkcode NetworkController.teardown}
 * needs and is the argument to {@linkcode SubnetAllocator.release}.
 *
 * @throws {RangeError} when `tapName` is not a well-formed `sbxtap<slot>` name.
 */
export function slotOfTapName(tapName: string): number {
  if (!tapName.startsWith(TAP_NAME_PREFIX)) {
    throw new RangeError(
      `tap device ${tapName} is not a ${TAP_NAME_PREFIX}<slot>`,
    );
  }
  const suffix = tapName.slice(TAP_NAME_PREFIX.length);
  const slot = Number(suffix);
  if (!/^[0-9]+$/.test(suffix) || !Number.isInteger(slot)) {
    throw new RangeError(`tap device ${tapName} has no valid slot`);
  }
  return slot;
}

/** The controllers a {@linkcode NetworkReclaimHook} composes (§8). */
export interface NetworkReclaimHookDeps {
  /** Releases the freed slot back to the pool. */
  readonly allocator: SubnetAllocator;
  /** Tears the TAP down (removes addr + link atomically). */
  readonly network: NetworkController;
  /** Reaps the per-sandbox dnsmasq from its journaled pidfile. */
  readonly dnsmasq: DnsmasqController;
  /** Removes the per-sandbox nftables egress table by exact name. */
  readonly egress: EgressController;
  /**
   * Removes the per-sandbox exposeHttp forward table (`sbx_pf_<id>`) by exact
   * name (§6, §8 step 3). Absent when the dataplane predates M10 W6 wiring;
   * then the port-forward step is skipped (a sandbox with no exposeHttp never
   * installed one, so this is a clean nothing-to-do).
   */
  readonly portForward?: PortForwardController;
}

/**
 * The composed Tier-B {@linkcode ReclaimHook} (§8). Keyed off the journaled
 * `resources.tapName` (a no-op when unset — netless / never-provisioned), it
 * reclaims the whole dataplane in order, each step gone-tolerant inside its
 * controller:
 *
 * 1. reap the per-sandbox dnsmasq (`resources.dnsmasqPidfile`);
 * 2. remove the nftables egress table (`sbx_eg_<id>`, derived from `record.id`);
 * 3. remove the exposeHttp forward table (`sbx_pf_<id>`, id-derived — reaped
 *    unconditionally: an id owns its whole `sbx_pf_` namespace whether or not a
 *    forward was ever installed, and the reclaim is gone-tolerant, §6);
 * 4. tear the TAP down (slot parsed from `resources.tapName`);
 * 5. release the allocation slot.
 *
 * It reclaims from the JOURNAL alone — no live in-memory map — so a cold
 * reconcile after a supervisor crash reaps fully. A throw (a genuine, not
 * "already gone", controller failure) parks the record `quarantined`, which is
 * correct: a leaked TAP / table must surface, never be blind-swept.
 */
export class NetworkReclaimHook implements ReclaimHook {
  readonly name = "network-dataplane";
  readonly #allocator: SubnetAllocator;
  readonly #network: NetworkController;
  readonly #dnsmasq: DnsmasqController;
  readonly #egress: EgressController;
  readonly #portForward: PortForwardController | undefined;

  constructor(deps: NetworkReclaimHookDeps) {
    this.#allocator = deps.allocator;
    this.#network = deps.network;
    this.#dnsmasq = deps.dnsmasq;
    this.#egress = deps.egress;
    this.#portForward = deps.portForward;
  }

  async reclaim(record: SandboxRecord): Promise<void> {
    const tapName = record.resources.tapName;
    // No TAP journaled ⇒ netless / never provisioned: a clean nothing-to-do.
    if (tapName === undefined) return;
    const slot = slotOfTapName(tapName);
    const alloc: SubnetAllocation = subnetForSlot(slot);

    // 1. dnsmasq: kill the pid from the journaled pidfile, unlink pid + conf.
    if (record.resources.dnsmasqPidfile !== undefined) {
      await this.#dnsmasq.reap(record.resources.dnsmasqPidfile);
    }
    // 2. egress table: delete `sbx_eg_<idtoken>` by exact name (id-derived).
    await this.#egress.reclaim({ sandboxId: record.id });
    // 3. port-forward table: delete `sbx_pf_<idtoken>` by exact name so an
    //    exposeHttp forward is reaped on terminate + cold reconcile (§6, §8).
    if (this.#portForward !== undefined) {
      await this.#portForward.reclaim(record.id);
    }
    // 4. TAP: `ip link del dev sbxtap<slot>` (removes addr + link).
    await this.#network.teardown(alloc);
    // 5. slot: return it to the pool for reuse (idempotent).
    this.#allocator.release(slot);
  }
}
