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
// nftables egress chains
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
}

/**
 * The prefix every per-sandbox egress table name carries, derived from
 * `ruleset.ts` so it tracks the engine. A single `[a-z0-9]` id byte encodes to
 * itself, so dropping it leaves exactly the `sbx_eg_` prefix.
 */
export const EGRESS_TABLE_PREFIX = egressTableName("0").slice(0, -1);

/**
 * `nftables`: `inet` egress tables with the studiobox-owned prefix. Parses
 * `nft -j list tables`. Live sandboxes' table names are passed in the
 * allowance.
 */
export function nftablesEnumerator(
  options: NftablesEnumeratorOptions = {},
): LeakEnumerator {
  const runner = options.runner ?? new DenoSoakCommandRunner();
  const nftBin = options.nftBin ?? "nft";
  const prefix = options.tablePrefix ?? EGRESS_TABLE_PREFIX;
  return {
    leakClass: "nftables",
    async enumerate(): Promise<readonly string[]> {
      const result = await runner.run(nftBin, ["-j", "list", "tables"]);
      requireOk(result, `${nftBin} list tables`);
      return parseNftInetTables(result.stdout)
        .filter((name) => name.startsWith(prefix))
        .sort();
    },
  };
}

/** Extract `inet` table names from `nft -j list tables` JSON output. */
export function parseNftInetTables(json: string): string[] {
  const parsed = parseJsonObject(json);
  const list = parsed.nftables;
  const names: string[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const table = entry.table;
      if (
        isRecord(table) && table.family === "inet" &&
        typeof table.name === "string"
      ) {
        names.push(table.name);
      }
    }
  }
  return names;
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
   * Cmdline tokens that identify a studiobox VMM/jailer — e.g. the
   * `firecracker` / `jailer` exec-file basenames and each live execution's
   * `--id <executionId>` argv token. A process whose cmdline contains ANY of
   * these is studiobox-owned.
   */
  readonly identityTokens: () => Iterable<string>;
}

/**
 * `process` (in-guest variant): pids under `/proc` whose cmdline matches a
 * studiobox identity token. Unlike the host-safe pid ledger, this catches an
 * orphan VMM that has NO journal record at all (the true reconcile leak).
 * Live sandboxes' pids are passed in the allowance as `pid=<n>`.
 */
export function procCmdlineOrphanEnumerator(
  options: ProcCmdlineOrphanEnumeratorOptions,
): LeakEnumerator {
  const procRoot = options.procRoot ?? "/proc";
  return {
    leakClass: "process",
    async enumerate(): Promise<readonly string[]> {
      const tokens = [...options.identityTokens()].filter((t) => t !== "");
      if (tokens.length === 0) return [];
      const out: string[] = [];
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
        const cmdline = new TextDecoder().decode(raw).replaceAll("\0", " ");
        if (tokens.some((token) => cmdline.includes(token))) {
          out.push(`pid=${entry.name}`);
        }
      }
      return out.sort();
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
