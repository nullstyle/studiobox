/**
 * Cold-start reconcile helpers for the Tier-B dataplane
 * (DESIGN networking-dataplane.md §6, §8).
 *
 * Two host-safe, injected-seam functions the rootd entrypoint runs BEFORE it
 * accepts launches:
 *
 * 1. {@linkcode reserveLiveSlots} — rebuild the allocator bitmap from the
 *    journal so a fresh launch can never be handed a slot a surviving record
 *    (including a QUARANTINED one whose reclaim FAILED) still owns.
 * 2. {@linkcode sweepNetworkOrphans} — the NETWORK ORPHAN SWEEP, part of the
 *    destructive restart reconcile. A supervisor that crashed BETWEEN
 *    provisioning the host dataplane and journaling `resources` (the
 *    staging→booting CAS) leaves a live TAP / egress table / dnsmasq with NO
 *    journaled record to key the per-record {@linkcode
 *    import("./reclaim_hook.ts").NetworkReclaimHook} off. This sweep enumerates
 *    the live studiobox-prefixed host state and reaps whatever no surviving
 *    record owns.
 *
 * Both are keyed off the SAME "a record owns its resources unless it is
 * `terminated`" rule (a terminated record's dataplane was already reclaimed, so
 * its slot / TAP / table are free). Enumeration goes through injected seams that
 * capture stdout (unlike the mutating {@linkcode
 * import("./apply.ts").CommandRunner}, which discards it), so the whole sweep is
 * asserted with a fake runner and no host access.
 *
 * Conservative by construction: it only ever reaps names matching the studiobox
 * prefixes (`sbxtap<slot>`, `sbx_eg_<id>`, `sbx_pf_<id>`, `<slot>.pid`) — never a
 * wildcard flush of shared nft state.
 *
 * @module
 */

import type { SandboxRecord } from "../../state/model.ts";
import {
  type SubnetAllocator,
  subnetForSlot,
  TAP_NAME_PREFIX,
} from "./allocator.ts";
import { slotOfTapName } from "./reclaim_hook.ts";
import type { NetworkController } from "./dataplane.ts";
import type { DnsmasqController } from "./dnsmasq.ts";
import { DNS_RUN_DIR } from "./dnsmasq.ts";
import { egressTableName } from "./ruleset.ts";
import { portForwardTableName } from "./port_forward.ts";

/** nft table families the sweep knows how to reap (`sbx_eg_`=inet, `sbx_pf_`=ip). */
type NftFamily = "ip" | "inet";

/** A record owns its dataplane unless it is `terminated` (already reclaimed). */
function isLive(record: SandboxRecord): boolean {
  return record.phase !== "terminated";
}

/**
 * Reserve the allocator slot of every journaled record that still owns one
 * (§8). Terminated records (their dataplane reclaimed, so the slot is free) are
 * skipped; every other phase — including QUARANTINED, whose reclaim FAILED and
 * whose TAP / dnsmasq are therefore still live — reserves its slot, so a
 * post-restart launch cannot be handed a slot whose TAP is up.
 */
export function reserveLiveSlots(
  allocator: SubnetAllocator,
  records: readonly SandboxRecord[],
): void {
  for (const record of records) {
    if (!isLive(record)) continue;
    const tapName = record.resources.tapName;
    if (tapName !== undefined) {
      allocator.reserve(slotOfTapName(tapName));
    }
  }
}

/** Result of an enumeration command — stdout captured (the mutating runner drops it). */
export interface EnumerationResult {
  readonly success: boolean;
  /** Captured stdout (empty when the command failed or the binary is absent). */
  readonly stdout: string;
}

/**
 * Injected read-only command seam for the sweep's enumeration (`ip -o link
 * show`, `nft list tables`). Separate from the mutating {@linkcode
 * import("./apply.ts").CommandRunner} because enumeration needs stdout.
 */
export interface CommandEnumerator {
  run(bin: string, args: readonly string[]): Promise<EnumerationResult>;
}

/** Injected pidfile lister so the `/run/studiobox/dns/*.pid` scan is host-safe. */
export interface PidfileLister {
  /** Absolute paths of the `<slot>.pid` files present in the dns run dir. */
  list(): Promise<readonly string[]>;
}

/** Default {@linkcode CommandEnumerator} backed by `Deno.Command` (captures stdout). */
export class DenoCommandEnumerator implements CommandEnumerator {
  async run(
    bin: string,
    args: readonly string[],
  ): Promise<EnumerationResult> {
    try {
      const output = await new Deno.Command(bin, {
        args: [...args],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      return {
        success: output.success,
        stdout: new TextDecoder().decode(output.stdout),
      };
    } catch {
      // A missing `ip` / `nft` binary enumerates nothing rather than crashing
      // startup; a truly leaked resource surfaces on the next sweep with the
      // binary present.
      return { success: false, stdout: "" };
    }
  }
}

/** Default {@linkcode PidfileLister} reading `<runDir>/*.pid`. */
export class DenoPidfileLister implements PidfileLister {
  readonly #runDir: string;

  constructor(runDir: string = DNS_RUN_DIR) {
    this.#runDir = runDir;
  }

  async list(): Promise<readonly string[]> {
    const paths: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.#runDir)) {
        if (entry.isFile && entry.name.endsWith(".pid")) {
          paths.push(`${this.#runDir}/${entry.name}`);
        }
      }
    } catch {
      // No run dir yet (fresh host) ⇒ nothing to reap.
    }
    return paths;
  }
}

/** Everything {@linkcode sweepNetworkOrphans} needs, all injected for testability. */
export interface NetworkOrphanSweepDeps {
  /** The full journal (ownership is derived from every non-terminated record). */
  readonly records: readonly SandboxRecord[];
  /** Enumerates live host state (`ip -o link show`, `nft list tables`). */
  readonly enumerator: CommandEnumerator;
  /** Enumerates the per-sandbox dnsmasq pidfiles. */
  readonly pidfiles: PidfileLister;
  /** Tears down orphan TAPs + deletes orphan `sbx_eg_`/`sbx_pf_` tables by name. */
  readonly network: NetworkController;
  /** Reaps orphan dnsmasq instances from their pidfiles. */
  readonly dnsmasq: DnsmasqController;
  /** Path to the `ip` binary. @default "ip" */
  readonly ipBin?: string;
  /** Path to the `nft` binary. @default "nft" */
  readonly nftBin?: string;
}

/** What {@linkcode sweepNetworkOrphans} reaped, for the startup log. */
export interface NetworkOrphanSweepResult {
  /** Orphan TAP device names torn down. */
  readonly taps: readonly string[];
  /** Orphan `sbx_eg_`/`sbx_pf_` nft table names deleted. */
  readonly tables: readonly string[];
  /** Orphan dnsmasq pidfiles reaped. */
  readonly pidfiles: readonly string[];
}

/**
 * Reap every studiobox-prefixed host resource that no surviving journaled record
 * owns (§6, §8). Idempotent and conservative — a fresh host (no `sbxtap*`, no
 * `sbx_*` tables, no pidfiles) is a clean no-op, and only exactly-matching
 * prefixed names are ever reaped. Reap goes through the existing controllers
 * (`network.teardown` / `network.reapTable` / `dnsmasq.reap`), each gone-tolerant
 * so a name that vanished between enumeration and reap is not an error.
 */
export async function sweepNetworkOrphans(
  deps: NetworkOrphanSweepDeps,
): Promise<NetworkOrphanSweepResult> {
  const ipBin = deps.ipBin ?? "ip";
  const nftBin = deps.nftBin ?? "nft";

  // Ownership is GENEROUS on purpose: over-marking a name as owned only means the
  // sweep declines to reap it (safe), while under-marking would reap a live
  // resource (unacceptable). A live record therefore claims its whole table
  // namespace, whether or not the table is currently installed.
  const ownedTaps = new Set<string>();
  const ownedTables = new Set<string>();
  const ownedPidfiles = new Set<string>();
  for (const record of deps.records) {
    if (!isLive(record)) continue;
    const tap = record.resources.tapName;
    if (tap !== undefined) ownedTaps.add(tap);
    const pidfile = record.resources.dnsmasqPidfile;
    if (pidfile !== undefined) ownedPidfiles.add(pidfile);
    try {
      ownedTables.add(egressTableName(record.id));
      ownedTables.add(portForwardTableName(record.id));
    } catch {
      // A record id that yields no valid table name never owned one.
    }
  }

  // TAPs: `ip -o link show` → reap every `sbxtap<slot>` with no live owner.
  const taps: string[] = [];
  const linkOut = await deps.enumerator.run(ipBin, ["-o", "link", "show"]);
  for (const tap of parseTapNames(linkOut.stdout)) {
    if (ownedTaps.has(tap)) continue;
    await deps.network.teardown(subnetForSlot(slotOfTapName(tap)));
    taps.push(tap);
  }

  // nft tables: `nft list tables` → reap every `sbx_eg_`/`sbx_pf_` table with no
  // live owner, deleting by the exact enumerated family + name.
  const tables: string[] = [];
  const tableOut = await deps.enumerator.run(nftBin, ["list", "tables"]);
  for (const { family, name } of parseSbxTables(tableOut.stdout)) {
    if (ownedTables.has(name)) continue;
    await deps.network.reapTable(family, name);
    tables.push(name);
  }

  // dnsmasq: reap every `<slot>.pid` with no live owner (kills the pid + unlinks).
  const pidfiles: string[] = [];
  for (const pidfile of await deps.pidfiles.list()) {
    if (ownedPidfiles.has(pidfile)) continue;
    await deps.dnsmasq.reap(pidfile);
    pidfiles.push(pidfile);
  }

  return { taps, tables, pidfiles };
}

const TAP_LINE = /^\s*\d+:\s+([^:@\s]+)/;
const SBXTAP_NAME = new RegExp(`^${TAP_NAME_PREFIX}\\d+$`);
const NFT_TABLE_LINE = /^\s*table\s+(\S+)\s+(\S+)\s*(\{)?\s*$/;
const SBX_TABLE_PREFIXES = ["sbx_eg_", "sbx_pf_"] as const;

/**
 * Extract `sbxtap<slot>` device names from `ip -o link show` output. Each `-o`
 * line is `<index>: <name>: <flags> …`; only names matching `sbxtap<digits>`
 * exactly are returned (peer suffixes like `@if13` are stripped by the `[^:@\s]`
 * capture), so nothing outside the studiobox prefix is ever a reap candidate.
 */
function parseTapNames(stdout: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = TAP_LINE.exec(line);
    if (match === null) continue;
    const name = match[1];
    if (SBXTAP_NAME.test(name) && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Extract `{family, name}` for every `sbx_eg_`/`sbx_pf_` table in `nft list
 * tables` output. Lines are `table <family> <name>`; only the studiobox
 * per-sandbox prefixes with a reapable family (`ip`/`inet`) are returned, so the
 * shared `studiobox_nat`/`studiobox_isolation`/`studiobox_hostguard` tables and
 * any non-studiobox table are never candidates.
 */
function parseSbxTables(
  stdout: string,
): Array<{ family: NftFamily; name: string }> {
  const out: Array<{ family: NftFamily; name: string }> = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = NFT_TABLE_LINE.exec(line);
    if (match === null) continue;
    const family = match[1];
    const name = match[2];
    if (family !== "ip" && family !== "inet") continue;
    if (!SBX_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ family, name });
  }
  return out;
}
