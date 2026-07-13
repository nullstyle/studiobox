/**
 * `LeakAudit` — the reusable no-leak enumerator + assertion framework that
 * DEFINES the studiobox 1.0 soak (PLAN.md §M11, DESIGN.md §6/§9).
 *
 * Every studiobox milestone can self-check for leaks with this module: give
 * it a set of {@linkcode LeakEnumerator}s scoped to a state-dir / jail-base /
 * artifact-cache and it ENUMERATES and asserts-zero every leak class the 1.0
 * bar names —
 *
 * - `process`         — orphan firecracker/jailer VMMs (a tracked-pid ledger
 *                       host-safe, a `/proc` cmdline scan in-guest);
 * - `tap`             — leaked TAP devices;
 * - `netns`           — leaked network namespaces;
 * - `nftables`        — leaked per-sandbox nft tables (`inet sbx_eg_*` egress
 *                       + `ip sbx_pf_*` port-forward);
 * - `dnsmasq`         — leaked per-sandbox dnsmasq forwarders;
 * - `mount`           — leaked jail mounts;
 * - `overlay`         — leaked per-boot overlay ext4 files;
 * - `jailRoot`        — leaked jail root dirs;
 * - `portReservation` — leaked host forward-range port reservations;
 * - `journalPhase`    — journal records left outside terminal phases;
 * - `artifactRefcount`— artifact-cache refcounts stuck above zero.
 *
 * Each class is checked by an **independently reportable** enumerator, so the
 * audit says exactly *which* class leaked and *what exactly* leaked. The
 * enumerators are injectable, so the same {@linkcode LeakAudit} runs BOTH
 * host-safe (against fake/injected enumerators + a temp state-dir — the
 * factories in this module) AND in-guest (against real `/proc`, `ip`, `nft` —
 * the factories in `enumerators_linux.ts`).
 *
 * A class with no enumerator wired is reported as **skipped** (dropped
 * coverage), never silently passed: {@linkcode SoakRunner} logs the skipped
 * set so a bounded run is honest about what it did not check.
 *
 * This module consumes the studiobox client surfaces (`src/state`,
 * `images/cache.ts`) read-only; it never mutates host state. Being a
 * leak-detection tool it is exemplary about scope: enumerators are always
 * bounded to a caller-supplied scope (a jail base, an overlay dir, an owned
 * prefix) and never wildcard-sweep shared host state.
 *
 * @module
 */

import { join } from "@std/path";
import type { SandboxPhase, SandboxRecord } from "../../src/state/model.ts";
import type {
  ArtifactCache,
  ArtifactReferenceReader,
} from "../../images/cache.ts";

/** The 1.0 leak taxonomy (PLAN.md §M11). */
export type LeakClass =
  | "process"
  | "tap"
  | "netns"
  | "nftables"
  | "dnsmasq"
  | "mount"
  | "overlay"
  | "jailRoot"
  | "portReservation"
  | "journalPhase"
  | "artifactRefcount";

/** Every leak class, in report order. */
export const LEAK_CLASSES: readonly LeakClass[] = Object.freeze([
  "process",
  "tap",
  "netns",
  "nftables",
  "dnsmasq",
  "mount",
  "overlay",
  "jailRoot",
  "portReservation",
  "journalPhase",
  "artifactRefcount",
]);

/**
 * A single leak class's enumerator: returns the identities of every
 * studiobox-owned resource of {@linkcode LeakEnumerator.leakClass} currently
 * present in the scope. The audit subtracts a per-call allowance (resources
 * legitimately held by live sandboxes) and treats the residual as leaked.
 *
 * An enumerator MUST be scoped — it returns only resources this studiobox
 * instance owns (an owned TAP prefix, jail dirs under one base, refcounts in
 * one cache) — so a clean run reports zero even on a busy host.
 */
export interface LeakEnumerator {
  readonly leakClass: LeakClass;
  /** Scoped, studiobox-owned resource identities currently present. */
  enumerate(): Promise<readonly string[]>;
}

/**
 * Resources known to belong to currently-live sandboxes, excluded from the
 * audit. Keyed by leak class; each value is the set of identities an
 * enumerator of that class would return for the live fleet.
 */
export type LeakAllowance = Partial<Record<LeakClass, Iterable<string>>>;

/** One leaked class and the exact resources that leaked. */
export interface LeakFinding {
  readonly leakClass: LeakClass;
  readonly resources: readonly string[];
}

/** The outcome of one {@linkcode LeakAudit.audit}. */
export interface LeakReport {
  /** True iff no wired enumerator found a residual leak. */
  readonly clean: boolean;
  /** One entry per class that leaked, in {@link LEAK_CLASSES} order. */
  readonly findings: readonly LeakFinding[];
  /** Classes an enumerator actually checked. */
  readonly checked: readonly LeakClass[];
  /** Classes with no enumerator wired — coverage this audit did NOT bound. */
  readonly skipped: readonly LeakClass[];
}

/** How many leaked resources to name per class before summarizing the rest. */
const MAX_NAMED_RESOURCES = 8;

/**
 * Thrown by {@linkcode LeakAudit.assertClean}. Fails LOUD: the message names
 * every leaked class and (a bounded sample of) exactly what leaked, so a soak
 * failure points straight at the defect.
 */
export class LeakDetectedError extends Error {
  readonly code = "SBX_SOAK_LEAK";
  readonly report: LeakReport;

  constructor(report: LeakReport, context?: string) {
    super(LeakDetectedError.#format(report, context));
    this.name = "LeakDetectedError";
    this.report = report;
  }

  static #format(report: LeakReport, context?: string): string {
    const where = context === undefined ? "" : ` (${context})`;
    const lines = report.findings.map((finding) => {
      const shown = finding.resources.slice(0, MAX_NAMED_RESOURCES);
      const extra = finding.resources.length - shown.length;
      const suffix = extra > 0 ? `, ...(+${extra} more)` : "";
      return `  - ${finding.leakClass} (${finding.resources.length}): ${
        shown.join(", ")
      }${suffix}`;
    });
    return `leak detected${where}: ${report.findings.length} class(es) leaked\n${
      lines.join("\n")
    }`;
  }
}

/**
 * Runs a set of {@linkcode LeakEnumerator}s and asserts every class is clean.
 * One enumerator per class wins (a later enumerator for the same class
 * replaces an earlier one), so a caller can compose the host-safe factories
 * from this module with the Linux factories from `enumerators_linux.ts`.
 */
export class LeakAudit {
  readonly #enumerators: Map<LeakClass, LeakEnumerator>;

  constructor(enumerators: readonly LeakEnumerator[] = []) {
    this.#enumerators = new Map();
    for (const enumerator of enumerators) {
      this.#enumerators.set(enumerator.leakClass, enumerator);
    }
  }

  /** Add or replace the enumerator for its class; returns `this`. */
  with(enumerator: LeakEnumerator): this {
    this.#enumerators.set(enumerator.leakClass, enumerator);
    return this;
  }

  /** Classes an enumerator is wired for, in taxonomy order. */
  get checked(): readonly LeakClass[] {
    return LEAK_CLASSES.filter((leakClass) => this.#enumerators.has(leakClass));
  }

  /** Classes with no enumerator — coverage a run using this audit drops. */
  get skipped(): readonly LeakClass[] {
    return LEAK_CLASSES.filter((leakClass) =>
      !this.#enumerators.has(leakClass)
    );
  }

  /**
   * Enumerate every wired class, subtract the allowance, and report the
   * residual. Runs all enumerators even after the first finding so a report
   * names every class that leaked, not just the first.
   */
  async audit(allowed: LeakAllowance = {}): Promise<LeakReport> {
    const findings: LeakFinding[] = [];
    for (const leakClass of this.checked) {
      const enumerator = this.#enumerators.get(leakClass)!;
      const present = await enumerator.enumerate();
      const permitted = new Set(allowed[leakClass] ?? []);
      const leaked = present.filter((id) => !permitted.has(id));
      if (leaked.length > 0) {
        findings.push({ leakClass, resources: [...leaked].sort() });
      }
    }
    return {
      clean: findings.length === 0,
      findings,
      checked: this.checked,
      skipped: this.skipped,
    };
  }

  /**
   * Audit and throw {@linkcode LeakDetectedError} on any residual leak.
   * `context` (e.g. `"after terminate, cycle 42"`) is woven into the error.
   */
  async assertClean(
    allowed: LeakAllowance = {},
    context?: string,
  ): Promise<LeakReport> {
    const report = await this.audit(allowed);
    if (!report.clean) throw new LeakDetectedError(report, context);
    return report;
  }
}

// ---------------------------------------------------------------------------
// Host-safe enumerator factories
//
// These consume studiobox client surfaces (the state journal, the artifact
// cache) and local FS scopes, so they run on any OS the fake-VMM backend runs
// on. The Linux-only classes (tap / netns / nftables / mount) live in
// `enumerators_linux.ts`.
// ---------------------------------------------------------------------------

/** The read-only slice of the sandbox journal the audit needs. */
export interface JournalReader {
  list(): Promise<SandboxRecord[]>;
}

/**
 * Phases a record may rest in without leaking. Default `["terminated"]`:
 * a `quarantined` record means reclaim did not finish, so its inputs may be
 * leaked — the audit flags it. Every non-terminal phase (still in flight past
 * a quiescent audit point) is likewise flagged.
 */
export const DEFAULT_TERMINAL_PHASES: readonly SandboxPhase[] = Object.freeze([
  "terminated",
]);

export interface JournalPhaseEnumeratorOptions {
  /** @default {@link DEFAULT_TERMINAL_PHASES} */
  readonly terminalPhases?: readonly SandboxPhase[];
}

/**
 * `journalPhase`: every record whose phase is not terminal. Identity is
 * `<sandboxId>:<phase>` so a report shows what state a leaked record is stuck
 * in. A live sandbox's id is passed in the audit allowance.
 */
export function journalPhaseEnumerator(
  reader: JournalReader,
  options: JournalPhaseEnumeratorOptions = {},
): LeakEnumerator {
  const terminal = new Set(options.terminalPhases ?? DEFAULT_TERMINAL_PHASES);
  return {
    leakClass: "journalPhase",
    async enumerate(): Promise<readonly string[]> {
      const out: string[] = [];
      for (const record of await reader.list()) {
        if (!terminal.has(record.phase)) {
          out.push(`${record.id}:${record.phase}`);
        }
      }
      return out;
    },
  };
}

/** Allowance identity for a live record in the `journalPhase` class. */
export function journalPhaseIdentity(
  sandboxId: string,
  phase: SandboxPhase,
): string {
  return `${sandboxId}:${phase}`;
}

/**
 * `artifactRefcount`: cached sets whose refcount is above zero but which no
 * non-terminal journal record still references — a stuck belt. Identity is
 * `<manifestHash>@<count>`. A set legitimately held by a live record is
 * excluded via {@linkcode ArtifactReferenceReader} (the journal side of the
 * cache's own GC guard), so no allowance is needed for this class.
 */
export function artifactRefcountEnumerator(
  cache: Pick<ArtifactCache, "list" | "refcount">,
  referenced: ArtifactReferenceReader,
): LeakEnumerator {
  return {
    leakClass: "artifactRefcount",
    async enumerate(): Promise<readonly string[]> {
      const live = new Set(await referenced.listReferencedManifestHashes());
      const out: string[] = [];
      for (const hash of await cache.list()) {
        if (live.has(hash)) continue;
        let count: number;
        try {
          count = await cache.refcount(hash);
        } catch {
          // A corrupt/absent refcount is fail-closed on the cache side; a
          // read failure here is not a countable belt leak.
          continue;
        }
        if (count > 0) out.push(`${hash}@${count}`);
      }
      return out;
    },
  };
}

/** Default per-boot overlay filename shape (see the golden launch planner). */
export const DEFAULT_OVERLAY_PATTERN = /^ov-.+\.ext4$/;

/**
 * `overlay`: per-boot overlay ext4 files still present in `overlayDir`.
 * Identity is the bare filename. Live executions' overlays are passed in the
 * allowance.
 */
export function overlayFileEnumerator(
  overlayDir: string,
  pattern: RegExp = DEFAULT_OVERLAY_PATTERN,
): LeakEnumerator {
  return {
    leakClass: "overlay",
    enumerate: () =>
      listDir(overlayDir, (entry) => entry.isFile && pattern.test(entry.name)),
  };
}

/**
 * `jailRoot`: per-execution jail dirs still present under `chrootBaseDir`.
 * The package lays them out `<base>/<exec-file-basename>/<executionId>`, so a
 * leaked identity is `<exec-file-basename>/<executionId>`. Live executions'
 * jail dirs are passed in the allowance.
 */
export function jailRootEnumerator(chrootBaseDir: string): LeakEnumerator {
  return {
    leakClass: "jailRoot",
    async enumerate(): Promise<readonly string[]> {
      const out: string[] = [];
      let middles: readonly Deno.DirEntry[];
      try {
        middles = await collectDir(chrootBaseDir);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return out;
        throw error;
      }
      for (const middle of middles) {
        if (!middle.isDirectory) continue;
        const midPath = join(chrootBaseDir, middle.name);
        for (const child of await collectDir(midPath)) {
          if (child.isDirectory) out.push(join(middle.name, child.name));
        }
      }
      return out.sort();
    },
  };
}

export interface TrackedProcessEnumeratorOptions {
  /** Signal-0 liveness probe (SIGCONT fallback); see {@link defaultPidAlive}. */
  readonly pidAlive?: (pid: number) => boolean;
}

/**
 * `process`: of every pid this backend ever launched, those still alive. A
 * clean terminate / reconcile kills them all, so at a quiescent audit point
 * none remain; a live sandbox's pid is passed in the allowance. Host-safe —
 * the pids are real fake-VMM child processes. Identity is `pid=<n>`.
 *
 * (In-guest, `procCmdlineOrphanEnumerator` additionally catches orphans with
 * NO journal record — the class this pid ledger cannot see.)
 */
export function trackedProcessEnumerator(
  pids: () => Iterable<number>,
  options: TrackedProcessEnumeratorOptions = {},
): LeakEnumerator {
  const alive = options.pidAlive ?? defaultPidAlive;
  return {
    leakClass: "process",
    enumerate(): Promise<readonly string[]> {
      const out: string[] = [];
      for (const pid of pids()) if (alive(pid)) out.push(`pid=${pid}`);
      return Promise.resolve(out.sort());
    },
  };
}

/** Allowance identity for a live pid in the `process` class (host-safe ledger). */
export function processIdentity(pid: number): string {
  return `pid=${pid}`;
}

/**
 * Allowance identity for a live execution in the `process` class (the in-guest
 * `/proc`-cmdline VMM scan keys on the jail exec-id, not the pid).
 */
export function processExecIdentity(executionId: string): string {
  return `exec:${executionId}`;
}

/**
 * `portReservation`: forward-range ports still held by a record that has
 * reached a terminal phase (a lease that outlived its sandbox). Identity is
 * `<sandboxId>:port=<port>`. Journal-derived and host-safe; the in-guest host
 * port ledger has its own factory in `enumerators_linux.ts`.
 */
export function portReservationEnumerator(
  reader: JournalReader,
  options: JournalPhaseEnumeratorOptions = {},
): LeakEnumerator {
  const terminal = new Set(options.terminalPhases ?? DEFAULT_TERMINAL_PHASES);
  return {
    leakClass: "portReservation",
    async enumerate(): Promise<readonly string[]> {
      const out: string[] = [];
      for (const record of await reader.list()) {
        if (!terminal.has(record.phase)) continue;
        for (const port of record.resources.exposedPorts) {
          out.push(`${record.id}:port=${port.hostPort}`);
        }
      }
      return out.sort();
    },
  };
}

/** Signal-0 liveness (SIGCONT fallback for runtimes without `kill(pid, 0)`). */
export function defaultPidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    if (!(error instanceof TypeError)) return true;
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
}

async function collectDir(path: string): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry);
  return entries;
}

async function listDir(
  path: string,
  keep: (entry: Deno.DirEntry) => boolean,
): Promise<readonly string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (keep(entry)) out.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return out;
    throw error;
  }
  return out.sort();
}
