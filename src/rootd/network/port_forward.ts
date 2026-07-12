/**
 * Per-sandbox host→guest port forwarding for exposeHttp
 * (DESIGN networking-dataplane.md §6).
 *
 * {@linkcode PortForwardController} installs a **per-sandbox** nftables table
 * `sbx_pf_<idtoken>` that DNATs a loopback host port to the guest and SNATs the
 * return path to the guest's gateway. Because each sandbox owns its own table,
 * addressed by exact name, another sandbox's reclaim / relaunch never touches an
 * exposed port — the same "own table, exact-name reclaim" isolation the egress
 * engine relies on (§6, §12).
 *
 * The table name reuses `egressTableName`'s **injective** encoding
 * (`ruleset.ts`) so `sbx_pf_<idtoken>` is collision-free the exact same way
 * `sbx_eg_<idtoken>` is — a hostile launcher cannot steer two ids onto one
 * forward table. It is derived by swapping the `sbx_eg_` prefix for `sbx_pf_`;
 * the encoding itself is never reimplemented.
 *
 * All host mutation goes through the injected {@linkcode CommandRunner}, so the
 * exact `nft` script is asserted in unit tests with no host mutation.
 *
 * @module
 */

import type { CommandRunner, EgressCommandResult } from "./apply.ts";
import { DenoCommandRunner } from "./apply.ts";
import { egressTableName } from "./ruleset.ts";
import type { SubnetAllocation } from "./allocator.ts";

const EGRESS_PREFIX = "sbx_eg_";
const PORT_FORWARD_PREFIX = "sbx_pf_";

/**
 * Derive the per-sandbox port-forward nft table name, `sbx_pf_<idtoken>`. Reuses
 * `egressTableName`'s injective id encoding (and its length / charset
 * validation) verbatim, swapping only the table prefix, so the two schemes share
 * one collision-free encoding and can never be reimplemented apart.
 */
export function portForwardTableName(sandboxId: string): string {
  const egress = egressTableName(sandboxId);
  return `${PORT_FORWARD_PREFIX}${egress.slice(EGRESS_PREFIX.length)}`;
}

/** Options for {@linkcode PortForwardController}. */
export interface PortForwardControllerOptions {
  /** Injected subprocess seam (reused from the egress engine). */
  readonly runner?: CommandRunner;
  /** Path to the `nft` binary. @default "nft" */
  readonly nftBin?: string;
}

/** Per-`expose` inputs (§6). */
export interface PortForwardRequest {
  /** Sandbox id; derives the `sbx_pf_<idtoken>` table name (injective). */
  readonly sandboxId: string;
  /** Loopback host port dialed as `http://127.0.0.1:<hostPort>` (40100..40199). */
  readonly hostPort: number;
  /** Guest port the DNAT targets on `<guestIp>` (1..65535). */
  readonly guestPort: number;
}

/** Raised when an exposeHttp forward could not be installed. Fatal to the call. */
export class PortForwardError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PortForwardError";
  }
}

/** Raised when a sandbox's forward table could not be removed. */
export class PortForwardReclaimError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PortForwardReclaimError";
  }
}

/**
 * Installs and reclaims per-sandbox exposeHttp forwards through an injected
 * runner. Stateless between calls: reclaim recomputes the table name from the
 * sandbox id (matching what expose installed) so a cold reconcile with no live
 * state can still tear the forward down.
 */
export class PortForwardController {
  readonly #runner: CommandRunner;
  readonly #nftBin: string;

  constructor(options: PortForwardControllerOptions = {}) {
    this.#runner = options.runner ?? new DenoCommandRunner();
    this.#nftBin = options.nftBin ?? "nft";
  }

  /**
   * Install the sandbox's `sbx_pf_<idtoken>` forward table (§6): an output-hook
   * DNAT from `127.0.0.1:<hostPort>` to `<guestIp>:<guestPort>` and a
   * postrouting SNAT to `<hostIp>` so the guest replies to its gateway. Rendered
   * as one atomic `add;delete;add` `nft` script so re-apply replaces rather than
   * appends. Returns the installed table name for the journal / logs.
   */
  async expose(
    alloc: SubnetAllocation,
    request: PortForwardRequest,
  ): Promise<string> {
    const tableName = portForwardTableName(request.sandboxId);
    const script = renderPortForwardApply(
      tableName,
      request.hostPort,
      alloc.guestIp,
      request.guestPort,
      alloc.hostIp,
    );
    const result = await this.#nft(script);
    if (!result.success) {
      throw new PortForwardError(
        `nft port-forward install failed for ${tableName} (exit ${result.code}): ${result.stderr}`,
      );
    }
    return tableName;
  }

  /**
   * Remove exactly this sandbox's `sbx_pf_<idtoken>` table by name (§6, §8).
   * Idempotent by construction: the `add`-then-`delete` script never errors on
   * an already-gone table, mirroring `EgressController.reclaim`. Throws
   * {@linkcode PortForwardReclaimError} only on an unexpected `nft` failure, so
   * a leaked forward table is surfaced (quarantined) rather than swept blindly.
   */
  async reclaim(sandboxId: string): Promise<void> {
    const tableName = portForwardTableName(sandboxId);
    const result = await this.#nft(renderPortForwardReclaim(tableName));
    if (!result.success) {
      throw new PortForwardReclaimError(
        `nft port-forward reclaim failed for ${tableName} (exit ${result.code}): ${result.stderr}`,
      );
    }
  }

  #nft(script: string): Promise<EgressCommandResult> {
    return this.#runner.run(this.#nftBin, ["-f", "-"], script);
  }
}

/**
 * Render the atomic apply script for a port-forward table (§6). `add`-then-
 * `delete` makes the following fresh `table { … }` a replace, never an append,
 * so re-apply is idempotent — the same pattern as `renderApplyScript`.
 */
function renderPortForwardApply(
  tableName: string,
  hostPort: number,
  guestIp: string,
  guestPort: number,
  hostIp: string,
): string {
  return [
    `add table ip ${tableName}`,
    `delete table ip ${tableName}`,
    `table ip ${tableName} {`,
    "\tchain output {",
    "\t\ttype nat hook output priority -100; policy accept;",
    `\t\tip daddr 127.0.0.1 tcp dport ${hostPort} dnat to ${guestIp}:${guestPort}`,
    "\t}",
    "\tchain postrouting {",
    "\t\ttype nat hook postrouting priority 100; policy accept;",
    `\t\tip daddr ${guestIp} tcp dport ${guestPort} snat to ${hostIp}`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

/** Render the reclaim script: delete exactly this sandbox's forward table. */
function renderPortForwardReclaim(tableName: string): string {
  // `add`-then-`delete` so reclaim is idempotent (no error if already gone).
  return [
    `add table ip ${tableName}`,
    `delete table ip ${tableName}`,
    "",
  ].join("\n");
}
