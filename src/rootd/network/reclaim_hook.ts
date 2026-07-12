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
