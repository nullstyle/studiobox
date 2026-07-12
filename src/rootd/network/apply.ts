/**
 * Apply and reclaim a sandbox's egress ruleset against the real `nft` binary.
 *
 * {@linkcode EgressController} is the imperative shell around the pure
 * `ruleset.ts` core: it resolves the spec (`resolver.ts`), renders the atomic
 * apply script, and pipes it to `nft -f -` (optionally inside the sandbox's
 * network namespace). Both the subprocess runner and the DNS resolver are
 * injected, so the whole controller can be exercised in tests with no host
 * mutation and no network.
 *
 * ## Fail-closed contract (DESIGN.md §8)
 *
 * `nft -f` is transactional, so an apply is all-or-nothing: a failed apply
 * installs *nothing* partial. On top of that, {@linkcode EgressController.apply}
 * goes further — if the real apply fails, it best-effort installs the deny-all
 * {@linkcode generateSealRuleset} so the sandbox's TAP cannot egress at all,
 * then throws {@linkcode EgressApplyError}. The caller MUST treat that error as
 * fatal to the launch (abort boot, then {@linkcode EgressController.reclaim}).
 * A sandbox therefore only ever runs with either the intended ruleset or a hard
 * seal — never a partial allow-list that could leak.
 *
 * @module
 */

import { type EgressSpec, parseAllowNet } from "./spec.ts";
import {
  DenoHostResolver,
  type HostResolver,
  resolveSpec,
} from "./resolver.ts";
import {
  egressTableName,
  generateRuleset,
  generateSealRuleset,
  type NftRuleset,
  renderApplyScript,
  renderDnsmasqFragment,
  renderReclaimScript,
  type SandboxNetworkHandle,
} from "./ruleset.ts";

/** Result of running one command. */
export interface EgressCommandResult {
  readonly success: boolean;
  readonly code: number;
  /** Captured stderr, bounded by the runner. */
  readonly stderr: string;
}

/** Injectable subprocess seam so tests never touch the host. */
export interface CommandRunner {
  run(
    bin: string,
    args: readonly string[],
    stdin: string,
  ): Promise<EgressCommandResult>;
}

/** Default runner backed by `Deno.Command` (needs `--allow-run=nft,ip`). */
export class DenoCommandRunner implements CommandRunner {
  async run(
    bin: string,
    args: readonly string[],
    stdin: string,
  ): Promise<EgressCommandResult> {
    const command = new Deno.Command(bin, {
      args: [...args],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    });
    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
    const { success, code, stderr } = await child.output();
    return {
      success,
      code,
      stderr: new TextDecoder().decode(stderr).slice(0, 4_096),
    };
  }
}

export interface EgressControllerOptions {
  readonly runner?: CommandRunner;
  readonly resolver?: HostResolver;
  /** Path to the `nft` binary. @default "nft" */
  readonly nftBin?: string;
  /** Path to the `ip` binary (for `ip netns exec`). @default "ip" */
  readonly ipBin?: string;
  /**
   * Resolver IPs a restricted sandbox may reach on port 53. Used when
   * {@linkcode EgressController.apply} is not given a per-call override.
   */
  readonly resolvers?: readonly string[];
  /**
   * When a hostname resolves to nothing: `true` (default) seals just that host
   * (fail closed, launch continues); `false` aborts the whole apply.
   */
  readonly tolerateEmptyResolution?: boolean;
}

/** What {@linkcode EgressController.apply} installed, for the journal / logs. */
export interface EgressApplied {
  readonly tableName: string;
  readonly ruleset: NftRuleset;
  /** dnsmasq fragment to write for wildcard sync, or "" when none. */
  readonly dnsmasqFragment: string;
}

/** Per-`apply` overrides. */
export interface EgressApplyOptions {
  readonly resolvers?: readonly string[];
}

/** Raised when the ruleset could not be installed. Fatal to the launch. */
export class EgressApplyError extends Error {
  /** True when the deny-all seal was successfully installed as a fallback. */
  readonly sealed: boolean;
  constructor(message: string, sealed: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EgressApplyError";
    this.sealed = sealed;
  }
}

/** Raised when a sandbox's egress table could not be removed. */
export class EgressReclaimError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EgressReclaimError";
  }
}

/** Minimal identity needed to reclaim a sandbox's egress table. */
export interface EgressReclaimTarget {
  readonly sandboxId: string;
  readonly netns?: string;
}

export class EgressController {
  readonly #runner: CommandRunner;
  readonly #resolver: HostResolver;
  readonly #nftBin: string;
  readonly #ipBin: string;
  readonly #resolvers: readonly string[];
  readonly #tolerateEmpty: boolean;

  constructor(options: EgressControllerOptions = {}) {
    this.#runner = options.runner ?? new DenoCommandRunner();
    this.#resolver = options.resolver ?? new DenoHostResolver();
    this.#nftBin = options.nftBin ?? "nft";
    this.#ipBin = options.ipBin ?? "ip";
    this.#resolvers = options.resolvers ?? [];
    this.#tolerateEmpty = options.tolerateEmptyResolution ?? true;
  }

  /**
   * Resolve, generate, and atomically install the sandbox's egress ruleset.
   * Returns what was installed. On any failure installs the deny-all seal
   * (best effort) and throws {@linkcode EgressApplyError}.
   */
  async apply(
    spec: EgressSpec,
    handle: SandboxNetworkHandle,
    options: EgressApplyOptions = {},
  ): Promise<EgressApplied> {
    const resolvers = options.resolvers ?? this.#resolvers;
    let ruleset: NftRuleset;
    let dnsmasqFragment = "";
    try {
      const resolved = await resolveSpec(spec, this.#resolver, {
        tolerateEmpty: this.#tolerateEmpty,
      });
      ruleset = generateRuleset(resolved, handle, { resolvers });
      dnsmasqFragment = renderDnsmasqFragment(resolved, ruleset.tableName);
    } catch (error) {
      // Generation/resolution failed before anything was installed: seal the
      // TAP so a concurrently-booting guest cannot egress, then fail closed.
      const sealed = await this.#seal(handle);
      throw new EgressApplyError(
        "failed to generate egress ruleset",
        sealed,
        error,
      );
    }

    const result = await this.#nft(renderApplyScript(ruleset), handle.netns);
    if (!result.success) {
      const sealed = await this.#seal(handle);
      throw new EgressApplyError(
        `nft apply failed (exit ${result.code})`,
        sealed,
        new Error(result.stderr),
      );
    }
    return { tableName: ruleset.tableName, ruleset, dnsmasqFragment };
  }

  /**
   * Convenience wrapper: parse a raw `allowNet` value and apply it. Malformed
   * specs raise {@linkcode import("./spec.ts").EgressSpecError} before any host
   * change (never a leak).
   */
  applyAllowNet(
    allowNet: readonly string[] | undefined,
    handle: SandboxNetworkHandle,
    options?: EgressApplyOptions,
  ): Promise<EgressApplied> {
    const spec = parseAllowNet(allowNet);
    return this.apply(spec, handle, options);
  }

  /**
   * Remove exactly this sandbox's egress table (chain + all sets) by name.
   * Idempotent: deleting an already-absent table is not an error. Throws
   * {@linkcode EgressReclaimError} only on an unexpected `nft` failure, so the
   * caller can quarantine the record (a leaked chain must never be swept
   * blindly — DESIGN.md §8).
   */
  async reclaim(target: EgressReclaimTarget): Promise<void> {
    const tableName = egressTableName(target.sandboxId);
    const script = renderReclaimScript({
      family: "inet",
      tableName,
      chainName: "egress",
      sets: [],
      rules: [],
      unrestricted: false,
    });
    const result = await this.#nft(script, target.netns);
    if (!result.success) {
      throw new EgressReclaimError(
        `nft reclaim failed for table ${tableName} (exit ${result.code})`,
        new Error(result.stderr),
      );
    }
  }

  /** Best-effort deny-all seal; returns whether it was installed. */
  async #seal(handle: SandboxNetworkHandle): Promise<boolean> {
    try {
      const seal = generateSealRuleset(handle);
      const result = await this.#nft(renderApplyScript(seal), handle.netns);
      return result.success;
    } catch {
      return false;
    }
  }

  /** Run one `nft -f -` script, optionally inside a network namespace. */
  #nft(
    script: string,
    netns: string | undefined,
  ): Promise<EgressCommandResult> {
    if (netns !== undefined) {
      return this.#runner.run(
        this.#ipBin,
        ["netns", "exec", netns, this.#nftBin, "-f", "-"],
        script,
      );
    }
    return this.#runner.run(this.#nftBin, ["-f", "-"], script);
  }
}
