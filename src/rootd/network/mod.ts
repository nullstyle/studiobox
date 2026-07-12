/**
 * Per-sandbox egress networking for studiobox-rootd — the rootd-side
 * implementation of `@deno/sandbox`'s `allowNet` option (DESIGN.md §5 Tier B,
 * §8, §9; PLAN.md §M10).
 *
 * The pipeline is a pure core wrapped in a thin imperative shell:
 *
 * ```text
 * allowNet: string[] | undefined
 *   ├─ parseAllowNet ─────────▶ EgressSpec        (spec.ts,     pure)
 *   ├─ resolveSpec ───────────▶ ResolvedEgress    (resolver.ts, injected DNS)
 *   ├─ generateRuleset ───────▶ NftRuleset        (ruleset.ts,  pure)
 *   ├─ renderApplyScript ─────▶ nft -f script     (ruleset.ts,  pure)
 *   └─ EgressController.apply ▶ live nftables      (apply.ts,    injected exec)
 * ```
 *
 * `EgressReclaimHook` is the ready-to-register {@linkcode
 * import("../supervisor_core.ts").ReclaimHook} that removes a sandbox's table by
 * exact name on terminate — see its module doc for the launch_planner
 * integration point (deliberately not wired yet).
 *
 * @module
 */

export {
  type EgressPattern,
  type EgressSpec,
  EgressSpecError,
  type EgressSpecErrorCode,
  type HostPattern,
  type IpPattern,
  parseAllowNet,
  parseEntry,
  parseIpLiteral,
} from "./spec.ts";

export {
  DenoHostResolver,
  EgressResolveError,
  type HostResolver,
  type ResolvedAddresses,
  type ResolvedEgress,
  type ResolvedWildcard,
  type ResolveOptions,
  resolveSpec,
} from "./resolver.ts";

export {
  EgressRulesetError,
  type EgressRulesetOptions,
  egressTableName,
  generateRuleset,
  generateSealRuleset,
  type NftRuleset,
  type NftSet,
  renderApplyScript,
  renderDnsmasqFragment,
  renderNftScript,
  renderReclaimScript,
  type SandboxNetworkHandle,
} from "./ruleset.ts";

export {
  type CommandRunner,
  DenoCommandRunner,
  type EgressApplied,
  EgressApplyError,
  type EgressApplyOptions,
  type EgressCommandResult,
  EgressController,
  type EgressControllerOptions,
  EgressReclaimError,
  type EgressReclaimTarget,
} from "./apply.ts";

export {
  EgressReclaimHook,
  type EgressReclaimHookOptions,
} from "./reclaim_hook.ts";
