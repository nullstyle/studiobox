/**
 * Linux / in-guest {@linkcode LeakEnumerator}s for the classes the host-safe
 * factories in `leak_audit.ts` cannot observe: real TAP devices, network
 * namespaces, nftables egress chains, jail mounts, `/proc`-cmdline orphan
 * VMMs, and the host forward-range port ledger.
 *
 * These are the enumerators the DEFERRED `soak:vm` drill wires against real
 * `ip` / `nft` / `/proc` inside `fc-smoke`. Every host touch is behind an
 * injected seam — a {@linkcode SoakCommandRunner} for `ip`/`nft` and a
 * `procRoot` / `mountsPath` for the filesystem reads — so the parsers are
 * exercised host-safe against captured fixtures (see
 * `tests/soak/enumerators_linux_test.ts`) with no Linux, no root, no host
 * mutation.
 *
 * Scope discipline (this is a leak-detection tool): each enumerator filters to
 * a caller-supplied owned prefix / scope and returns only what studiobox owns.
 * It never wildcard-sweeps shared `ip`/`nft`/mount state.
 *
 * @module
 */

import { egressTableName } from "../../src/rootd/network/ruleset.ts";
import { portForwardTableName } from "../../src/rootd/network/port_forward.ts";
import { DNS_RUN_DIR } from "../../src/rootd/network/dnsmasq.ts";
import type { LeakEnumerator } from "./leak_audit.ts";

/** Result of running one enumeration command. */
export interface SoakCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable subprocess seam so the parsers are testable off-Linux. */
export interface SoakCommandRunner {
  run(bin: string, args: readonly string[]): Promise<SoakCommandResult>;
}

/** Default runner backed by `Deno.Command` (needs `--allow-run=ip,nft`). */
export class DenoSoakCommandRunner implements SoakCommandRunner {
  async run(
    bin: string,
    args: readonly string[],
  ): Promise<SoakCommandResult> {
    const { code, stdout, stderr } = await new Deno.Command(bin, {
      args: [...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  }
}

// ---------------------------------------------------------------------------
// TAP devices
// ---------------------------------------------------------------------------

export interface TapEnumeratorOptions {
  readonly runner?: SoakCommandRunner;
  /** `ip` binary. @default "ip" */
  readonly ipBin?: string;
  /** Only interfaces whose name starts with this are studiobox-owned. */
  readonly ownedPrefix: string;
}

/**
 * `tap`: TAP interfaces named with the studiobox-owned prefix. Parses
 * `ip -j link show`. Live sandboxes' TAP names are passed in the allowance.
 */
export function tapEnumerator(options: TapEnumeratorOptions): LeakEnumerator {
  const runner = options.runner ?? new DenoSoakCommandRunner();
  const ipBin = options.ipBin ?? "ip";
  return {
    leakClass: "tap",
    async enumerate(): Promise<readonly string[]> {
      const result = await runner.run(ipBin, ["-j", "link", "show"]);
      requireOk(result, `${ipBin} link show`);
      return parseIpLinkNames(result.stdout)
        .filter((name) => name.startsWith(options.ownedPrefix))
        .sort();
    },
  };
}

/** Extract `ifname`s from `ip -j link show` JSON output. */
export function parseIpLinkNames(json: string): string[] {
  const parsed = parseJsonArray(json);
  const names: string[] = [];
  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry.ifname === "string") {
      names.push(entry.ifname);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Network namespaces
// ---------------------------------------------------------------------------

export interface NetnsEnumeratorOptions {
  readonly runner?: SoakCommandRunner;
  readonly ipBin?: string;
  readonly ownedPrefix: string;
}

/**
 * `netns`: named network namespaces with the studiobox-owned prefix. Parses
 * `ip -j netns list` (falls back to the plain line format). Live sandboxes'
 * netns names are passed in the allowance.
 */
export function netnsEnumerator(
  options: NetnsEnumeratorOptions,
): LeakEnumerator {
  const runner = options.runner ?? new DenoSoakCommandRunner();
  const ipBin = options.ipBin ?? "ip";
  return {
    leakClass: "netns",
    async enumerate(): Promise<readonly string[]> {
      const result = await runner.run(ipBin, ["-j", "netns", "list"]);
      requireOk(result, `${ipBin} netns list`);
      return parseNetnsNames(result.stdout)
        .filter((name) => name.startsWith(options.ownedPrefix))
        .sort();
    },
  };
}

/** Extract netns names from `ip -j netns list` JSON or the plain format. */
export function parseNetnsNames(output: string): string[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[")) {
    const names: string[] = [];
    for (const entry of parseJsonArray(trimmed)) {
      if (isRecord(entry) && typeof entry.name === "string") {
        names.push(entry.name);
      }
    }
    return names;
  }
  // Plain format: `name (id: 0)` per line.
  const names: string[] = [];
  for (const line of trimmed.split("\n")) {
    const name = line.trim().split(/\s+/, 1)[0];
    if (name !== undefined && name !== "") names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// nftables per-sandbox tables (egress + port-forward)
// ---------------------------------------------------------------------------

export interface NftablesEnumeratorOptions {
  readonly runner?: SoakCommandRunner;
  /** `nft` binary. @default "nft" */
  readonly nftBin?: string;
  /**
   * Only `inet` tables whose name starts with this are studiobox egress
   * tables. @default the `sbx_eg_` prefix used by the egress engine
   */
  readonly tablePrefix?: string;
  /**
   * Only `ip` tables whose name starts with this are studiobox exposeHttp
   * port-forward tables. @default the `sbx_pf_` prefix the forward engine uses
   */
  readonly portForwardPrefix?: string;
}

/**
 * The prefix every per-sandbox egress table name carries, derived from
 * `ruleset.ts` so it tracks the engine. A single `[a-z0-9]` id byte encodes to
 * itself, so dropping it leaves exactly the `sbx_eg_` prefix.
 */
export const EGRESS_TABLE_PREFIX = egressTableName("0").slice(0, -1);

/**
 * The prefix every per-sandbox exposeHttp forward table name carries, derived
 * the same injective way as {@link EGRESS_TABLE_PREFIX} so it tracks the
 * forward engine — `portForwardTableName("0")` is `sbx_pf_0`, so dropping the
 * single id byte leaves exactly the `sbx_pf_` prefix.
 */
export const PORT_FORWARD_TABLE_PREFIX = portForwardTableName("0").slice(0, -1);

/** One nft table's family + name, from `nft -j list tables` JSON. */
export interface NftTableId {
  readonly family: string;
  readonly name: string;
}

/**
 * `nftables`: the per-sandbox nft tables studiobox owns — `inet sbx_eg_*`
 * egress tables AND `ip sbx_pf_*` exposeHttp port-forward tables. Parses
 * `nft -j list tables`. The shared, persistent `studiobox_nat` /
 * `studiobox_isolation` / `studiobox_hostguard` tables are NOT per-sandbox
 * leaks and are excluded by the owned-prefix filter (their names carry neither
 * prefix). Identity is family-qualified (`inet:sbx_eg_…` / `ip:sbx_pf_…`) so a
 * name collision across families stays distinct. Live sandboxes' table ids are
 * passed in the allowance.
 */
export function nftablesEnumerator(
  options: NftablesEnumeratorOptions = {},
): LeakEnumerator {
  const runner = options.runner ?? new DenoSoakCommandRunner();
  const nftBin = options.nftBin ?? "nft";
  const egressPrefix = options.tablePrefix ?? EGRESS_TABLE_PREFIX;
  const forwardPrefix = options.portForwardPrefix ?? PORT_FORWARD_TABLE_PREFIX;
  return {
    leakClass: "nftables",
    async enumerate(): Promise<readonly string[]> {
      const result = await runner.run(nftBin, ["-j", "list", "tables"]);
      requireOk(result, `${nftBin} list tables`);
      const out: string[] = [];
      for (const { family, name } of parseNftTables(result.stdout)) {
        const owned = (family === "inet" && name.startsWith(egressPrefix)) ||
          (family === "ip" && name.startsWith(forwardPrefix));
        if (owned) out.push(`${family}:${name}`);
      }
      return out.sort();
    },
  };
}

/** Extract every `{ family, name }` table from `nft -j list tables` JSON. */
export function parseNftTables(json: string): NftTableId[] {
  const parsed = parseJsonObject(json);
  const list = parsed.nftables;
  const tables: NftTableId[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const table = entry.table;
      if (
        isRecord(table) && typeof table.family === "string" &&
        typeof table.name === "string"
      ) {
        tables.push({ family: table.family, name: table.name });
      }
    }
  }
  return tables;
}

/**
 * Extract `inet` table names from `nft -j list tables` JSON output. Retained
 * for callers that only want the egress family; {@link parseNftTables} returns
 * both families with their family tag.
 */
export function parseNftInetTables(json: string): string[] {
  return parseNftTables(json)
    .filter((table) => table.family === "inet")
    .map((table) => table.name);
}

// ---------------------------------------------------------------------------
// Per-sandbox dnsmasq forwarders
// ---------------------------------------------------------------------------

export interface DnsmasqEnumeratorOptions {
  readonly runner?: SoakCommandRunner;
  /** `pgrep` binary. @default "pgrep" */
  readonly pgrepBin?: string;
  /**
   * The studiobox dns run dir whose `<slot>.pid` pidfiles a spawned dnsmasq
   * `--pid-file=` argument points at. Only dnsmasq processes whose args name
   * this dir are studiobox-owned. @default {@link DNS_RUN_DIR}
   */
  readonly runDir?: string;
}

/**
 * `dnsmasq`: the per-sandbox dnsmasq forwarders studiobox spawns (one per
 * non-netless sandbox, bound to its gateway on `sbxtap<slot>`). Parses
 * `pgrep -a dnsmasq` and keeps ONLY lines whose args carry the studiobox dns
 * run dir in `--pid-file=<runDir>/<slot>.pid`, so a host's own / unrelated
 * dnsmasq is never flagged. Identity is `dns:<slot>` (the slot parsed from the
 * pidfile path); a live sandbox's dnsmasq slot is passed in the allowance.
 */
export function dnsmasqEnumerator(
  options: DnsmasqEnumeratorOptions = {},
): LeakEnumerator {
  const runner = options.runner ?? new DenoSoakCommandRunner();
  const pgrepBin = options.pgrepBin ?? "pgrep";
  const runDir = options.runDir ?? DNS_RUN_DIR;
  return {
    leakClass: "dnsmasq",
    async enumerate(): Promise<readonly string[]> {
      const result = await runner.run(pgrepBin, ["-a", "dnsmasq"]);
      // `pgrep` exits 1 with no output when nothing matches — that is a clean
      // "no dnsmasq at all", not a command failure.
      if (result.code !== 0 && result.stdout.trim() === "") return [];
      requireOk(result, `${pgrepBin} -a dnsmasq`);
      return parseDnsmasqSlots(result.stdout, runDir).sort();
    },
  };
}

/**
 * Extract `dns:<slot>` identities from `pgrep -a dnsmasq` output, keeping only
 * lines whose `--pid-file=<runDir>/<slot>.pid` names the studiobox dns run dir.
 * The slot is the pidfile basename minus its `.pid` suffix.
 */
export function parseDnsmasqSlots(
  pgrepOutput: string,
  runDir: string = DNS_RUN_DIR,
): string[] {
  const base = runDir.endsWith("/") ? runDir : `${runDir}/`;
  const marker = `--pid-file=${base}`;
  const slots: string[] = [];
  for (const line of pgrepOutput.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(marker);
    if (at === -1) continue;
    // The pidfile token runs to the next whitespace; strip the `.pid` suffix.
    const token = line.slice(at + marker.length).split(/\s+/, 1)[0] ?? "";
    const slot = token.replace(/\.pid$/, "");
    if (slot !== "") slots.push(`dns:${slot}`);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Jail mounts
// ---------------------------------------------------------------------------

export interface MountEnumeratorOptions {
  /** Path to the kernel mount table. @default "/proc/mounts" */
  readonly mountsPath?: string;
  /** Only mount points at or under this base are studiobox jail mounts. */
  readonly scopePrefix: string;
}

/**
 * `mount`: mount points at or under the jail scope still present in the
 * kernel mount table. Live sandboxes' mount points are passed in the
 * allowance.
 */
export function mountEnumerator(
  options: MountEnumeratorOptions,
): LeakEnumerator {
  const mountsPath = options.mountsPath ?? "/proc/mounts";
  return {
    leakClass: "mount",
    async enumerate(): Promise<readonly string[]> {
      let text: string;
      try {
        text = await Deno.readTextFile(mountsPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
      }
      return parseMountPoints(text)
        .filter((point) => underScope(point, options.scopePrefix))
        .sort();
    },
  };
}

/** Extract mount points (field 2) from `/proc/mounts` text. */
export function parseMountPoints(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(/\s+/);
    if (fields.length >= 2) points.push(unescapeMount(fields[1]!));
  }
  return points;
}

// ---------------------------------------------------------------------------
// /proc-cmdline orphan VMMs (catches orphans with no journal record)
// ---------------------------------------------------------------------------

export interface ProcCmdlineOrphanEnumeratorOptions {
  /** Path to the proc filesystem. @default "/proc" */
  readonly procRoot?: string;
  /**
   * argv0 basenames that identify a studiobox VMM — the `firecracker` /
   * `jailer` exec-file basenames. A process is studiobox-owned iff its
   * `basename(argv[0])` is one of these — NOT a substring anywhere in the
   * cmdline: the soak runner itself carries `SBX_VM_FIRECRACKER_BIN=…` in its
   * env, so a substring match flags the runner.
   */
  readonly ownedBinaries: () => Iterable<string>;
}

/**
 * Parse `/proc/<pid>/cmdline` (NUL-separated argv, trailing NUL) into its argv
 * vector, dropping the trailing empty element.
 */
export function parseProcCmdline(raw: Uint8Array): string[] {
  return new TextDecoder().decode(raw).split("\0").filter((a) => a !== "");
}

/**
 * The studiobox jail identity of a VMM argv, or `undefined` if `argv[0]`'s
 * basename is not one of `owned`. Keyed on the jailer `--id <executionId>`
 * (present on both the jailer and the firecracker it exec's into), so it is
 * pid-namespace-independent; a matched VMM with no `--id` falls back to the pid.
 */
export function vmmJailIdentity(
  argv: readonly string[],
  owned: ReadonlySet<string>,
  pid: string,
): string | undefined {
  const argv0 = argv[0];
  if (argv0 === undefined) return undefined;
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  if (!owned.has(base)) return undefined;
  const idIdx = argv.indexOf("--id");
  const execId = idIdx >= 0 ? argv[idIdx + 1] : undefined;
  return execId !== undefined && execId !== ""
    ? `exec:${execId}`
    : `pid=${pid}`;
}

/**
 * `process` (in-guest variant): every studiobox VMM under `/proc`, keyed by its
 * jail exec-id (`exec:<executionId>`). A process is a VMM iff `basename(argv0)`
 * is an owned binary (firecracker/jailer) — this catches an orphan VMM with NO
 * journal record (the true reconcile leak) while ignoring the runner and other
 * processes that merely mention the binary path. Live sandboxes' exec-ids are
 * passed in the allowance as `exec:<executionId>`.
 */
export function procCmdlineOrphanEnumerator(
  options: ProcCmdlineOrphanEnumeratorOptions,
): LeakEnumerator {
  const procRoot = options.procRoot ?? "/proc";
  return {
    leakClass: "process",
    async enumerate(): Promise<readonly string[]> {
      const owned = new Set(
        [...options.ownedBinaries()].filter((b) => b !== ""),
      );
      if (owned.size === 0) return [];
      const found = new Set<string>();
      let entries: AsyncIterable<Deno.DirEntry>;
      try {
        entries = Deno.readDir(procRoot);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
      }
      for await (const entry of entries) {
        if (!/^\d+$/.test(entry.name)) continue;
        let raw: Uint8Array;
        try {
          raw = await Deno.readFile(`${procRoot}/${entry.name}/cmdline`);
        } catch {
          continue; // the process exited between readDir and read
        }
        const identity = vmmJailIdentity(
          parseProcCmdline(raw),
          owned,
          entry.name,
        );
        if (identity !== undefined) found.add(identity);
      }
      return [...found].sort();
    },
  };
}

// ---------------------------------------------------------------------------
// Host forward-range port ledger
// ---------------------------------------------------------------------------

export interface HostPortLedgerEnumeratorOptions {
  /** Yields the (owner, port) pairs the host currently has reserved. */
  readonly reserved: () => Promise<Iterable<{ owner: string; port: number }>>;
  /** Predicate: is this owner's sandbox still live? Leaked iff not. */
  readonly isLive: (owner: string) => boolean;
}

/**
 * `portReservation` (in-guest variant): forward-range ports still reserved by
 * an owner whose sandbox is no longer live. Identity is `<owner>:port=<port>`.
 */
export function hostPortLedgerEnumerator(
  options: HostPortLedgerEnumeratorOptions,
): LeakEnumerator {
  return {
    leakClass: "portReservation",
    async enumerate(): Promise<readonly string[]> {
      const out: string[] = [];
      for (const { owner, port } of await options.reserved()) {
        if (!options.isLive(owner)) out.push(`${owner}:port=${port}`);
      }
      return out.sort();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

function requireOk(result: SoakCommandResult, what: string): void {
  if (result.code !== 0) {
    throw new Error(
      `${what} exited ${result.code}: ${result.stderr.slice(0, 512)}`,
    );
  }
}

function parseJsonArray(json: string): unknown[] {
  const trimmed = json.trim();
  if (trimmed === "") return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new TypeError("expected a JSON array");
  }
  return parsed;
}

function parseJsonObject(json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (trimmed === "") return {};
  const parsed = JSON.parse(trimmed);
  if (!isRecord(parsed)) {
    throw new TypeError("expected a JSON object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function underScope(point: string, scope: string): boolean {
  const base = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return point === base || point.startsWith(`${base}/`);
}

/** `/proc/mounts` octal-escapes space (\040), tab (\011), etc. */
function unescapeMount(field: string): string {
  return field.replace(
    /\\([0-7]{3})/g,
    (_, oct: string) => String.fromCharCode(parseInt(oct, 8)),
  );
}
