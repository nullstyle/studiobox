/**
 * `SoakRunner` — drives the studiobox 1.0 soak drill (PLAN.md §M11).
 *
 * It runs N `create → use(sh/fs/eval) → terminate` cycles against an injected
 * {@linkcode SoakBackend} (a SupervisorCore / agent client), with periodic
 * `kill -9` of the supervisor + destructive reconcile at random points
 * mid-fleet, and after EVERY phase it runs the backend's {@linkcode LeakAudit}
 * and asserts clean — failing LOUD with the exact leak on any violation. It
 * tracks daemon RSS, journal-dir size, and create-latency percentiles against
 * budgets, and logs which leak classes it could not enumerate (bounded
 * coverage) so a partial run is never mistaken for a clean one.
 *
 * The runner is backend-agnostic: the host-safe `FakeVmmSoakBackend` (fake
 * VMM/jailer shims + a temp journal, runs anywhere) and the deferred real
 * in-guest backend both satisfy {@linkcode SoakBackend}. See DESIGN.md §6/§9.
 *
 * @module
 */

import { basename, dirname, join } from "@std/path";
import type { LeakAllowance, LeakAudit, LeakClass } from "./leak_audit.ts";

/** One live sandbox the runner is tracking through a cycle. */
export interface SoakSandboxHandle {
  readonly sandboxId: string;
  readonly executionId: string;
  /** VMM pid, for the process-leak ledger. */
  readonly pid: number;
}

/**
 * The sandbox backend the runner drives. The runner never touches the
 * supervisor, journal, or host directly — every side effect is behind one of
 * these methods, so the same runner exercises a fake-VMM backend on macOS and
 * a real microVM backend in `fc-smoke`.
 */
export interface SoakBackend {
  /** The audit configured with this backend's enumerators. */
  readonly audit: LeakAudit;
  /** Absolute path of the journal state file (its dir is size-budgeted). */
  readonly journalPath: string;

  /** Journal-before-spawn launch of one fresh sandbox to `ready`. */
  create(): Promise<SoakSandboxHandle>;
  /** Exercise the sandbox (the `use` phase): sh/fs/eval or an agent probe. */
  use(handle: SoakSandboxHandle): Promise<void>;
  /** Authoritative termination + full reclaim. */
  terminate(handle: SoakSandboxHandle): Promise<void>;
  /**
   * The kill-9-mid-fleet drill: launch `batchSize` sandboxes to `ready` in a
   * doomed supervisor, `kill -9` that supervisor (orphan VMMs + a live-looking
   * journal), then restart a fresh supervisor over the same journal and run
   * the destructive reconcile. On return every orphan is reaped and its
   * record is terminal. The backend self-audits the live mid-fleet (with its
   * own allowance) before the kill, so a false positive on live resources is
   * caught too.
   */
  crashAndReconcile(batchSize: number): Promise<void>;

  /**
   * Resources that legitimately belong to `live` sandboxes, to exclude from a
   * mid-cycle audit (so a live overlay/jail/pid is not flagged as a leak).
   */
  allowanceFor(live: readonly SoakSandboxHandle[]): LeakAllowance;

  /** Sample the daemon's resident set size in bytes. */
  sampleRssBytes(): number;

  /** Release backend resources (temp dirs, the supervisor). */
  close(): Promise<void>;
}

/** Resource budgets the soak enforces (the 1.0 bar's bounded-resource claim). */
export interface SoakBudgets {
  /** Create-latency p95 must be at or under this (ms). */
  readonly createP95Ms: number;
  /** Peak daemon RSS must be at or under this (bytes). */
  readonly maxRssBytes: number;
  /**
   * Late-run median RSS must be at or under early-run median × this factor —
   * the unbounded-growth guard. Tolerates GC noise; catches a real climb.
   */
  readonly rssGrowthFactor: number;
  /** Journal-dir size must be at or under this at the end of the run (bytes). */
  readonly maxJournalDirBytes: number;
}

/** Lenient defaults suited to the fake-VMM backend (each create spawns Deno). */
export const DEFAULT_SOAK_BUDGETS: SoakBudgets = Object.freeze({
  createP95Ms: 15_000,
  maxRssBytes: 2_048 * 1024 * 1024,
  rssGrowthFactor: 2.0,
  maxJournalDirBytes: 16 * 1024 * 1024,
});

export interface SoakRunOptions {
  /** Total create/use cycles (≥200 for the 1.0 bar). @default 200 */
  readonly cycles?: number;
  /**
   * How many of the cycles are batched kill-9-mid-fleet + reconcile drills
   * (≥10 for the 1.0 bar). Spread at random points across the run.
   * @default `cycles >= 200 ? 12 : max(2, floor(cycles / 4))`
   */
  readonly crashes?: number;
  /** Sandboxes launched mid-fleet before each crash. @default 2 */
  readonly batchSize?: number;
  /** RNG seed, for a reproducible crash schedule. @default 1 */
  readonly seed?: number;
  readonly budgets?: Partial<SoakBudgets>;
  /** Line logger. @default `console.log` */
  readonly log?: (line: string) => void;
}

/** Latency percentiles over the run's creates (ms). */
export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** The outcome of a completed soak run. */
export interface SoakResult {
  readonly cycles: number;
  readonly crashes: number;
  readonly creates: number;
  readonly audits: number;
  readonly createLatencyMs: LatencySummary;
  readonly rssStartBytes: number;
  readonly rssPeakBytes: number;
  readonly rssEndBytes: number;
  readonly journalDirBytes: number;
  readonly skipped: readonly LeakClass[];
}

/** Thrown when a resource budget is exceeded (fails the soak loud). */
export class SoakBudgetError extends Error {
  readonly code = "SBX_SOAK_BUDGET";
  constructor(message: string) {
    super(message);
    this.name = "SoakBudgetError";
  }
}

/** Drives one soak run against a {@linkcode SoakBackend}. */
export class SoakRunner {
  readonly #backend: SoakBackend;

  constructor(backend: SoakBackend) {
    this.#backend = backend;
  }

  async run(options: SoakRunOptions = {}): Promise<SoakResult> {
    const cycles = options.cycles ?? 200;
    if (!Number.isInteger(cycles) || cycles < 1) {
      throw new TypeError("soak cycles must be a positive integer");
    }
    const targetCrashes = options.crashes ??
      (cycles >= 200 ? 12 : Math.max(2, Math.floor(cycles / 4)));
    const batchSize = options.batchSize ?? 2;
    const budgets = { ...DEFAULT_SOAK_BUDGETS, ...options.budgets };
    const log = options.log ?? ((line: string) => console.log(line));
    const rng = mulberry32(options.seed ?? 1);
    const crashCycles = scheduleCrashCycles(cycles, targetCrashes, rng);

    const skipped = this.#backend.audit.skipped;
    if (skipped.length > 0) {
      log(
        `SOAK: bounding coverage — no enumerator wired for: ${
          skipped.join(", ")
        }. These leak classes are NOT checked in this run (host-safe); run \`soak:vm\` for full coverage.`,
      );
    }
    log(
      `SOAK: ${cycles} cycles, ${crashCycles.size} kill-9+reconcile drills, batch ${batchSize}; checking: ${
        this.#backend.audit.checked.join(", ")
      }`,
    );

    const createLatencies: number[] = [];
    const rssSamples: number[] = [];
    const rssStart = this.#backend.sampleRssBytes();
    let rssPeak = rssStart;
    let audits = 0;
    let creates = 0;
    let crashes = 0;

    const audit = async (
      live: readonly SoakSandboxHandle[],
      context: string,
    ): Promise<void> => {
      audits++;
      await this.#backend.audit.assertClean(
        this.#backend.allowanceFor(live),
        context,
      );
    };

    for (let cycle = 1; cycle <= cycles; cycle++) {
      if (crashCycles.has(cycle)) {
        // Batched kill-9-mid-fleet drill (the backend owns the doomed
        // supervisor + its mid-fleet self-audit).
        await this.#backend.crashAndReconcile(batchSize);
        crashes++;
        await audit([], `after kill-9 + reconcile (cycle ${cycle})`);
      } else {
        // Sequential create → use → terminate cycle.
        const handle = await this.#timedCreate(createLatencies);
        creates++;
        await audit([handle], `after create (cycle ${cycle})`);
        await this.#backend.use(handle);
        await audit([handle], `after use (cycle ${cycle})`);
        await this.#backend.terminate(handle);
        await audit([], `after terminate (cycle ${cycle})`);
      }

      const rss = this.#backend.sampleRssBytes();
      rssSamples.push(rss);
      if (rss > rssPeak) rssPeak = rss;
    }

    const journalDirBytes = await journalDirSize(this.#backend.journalPath);
    await this.#assertNoJournalTempLeak(log);

    const latency = summarize(createLatencies);
    log(
      `SOAK: done — ${creates} creates, ${crashes} reconciles, ${audits} audits; create p50/p95/p99=${latency.p50}/${latency.p95}/${latency.p99}ms, RSS peak ${
        mib(rssPeak)
      }MiB, journal ${kib(journalDirBytes)}KiB`,
    );

    this.#enforceBudgets(
      budgets,
      latency,
      rssPeak,
      rssSamples,
      journalDirBytes,
    );

    return {
      cycles,
      crashes,
      creates,
      audits,
      createLatencyMs: latency,
      rssStartBytes: rssStart,
      rssPeakBytes: rssPeak,
      rssEndBytes: rssSamples.at(-1) ?? rssStart,
      journalDirBytes,
      skipped,
    };
  }

  async #timedCreate(sink: number[]): Promise<SoakSandboxHandle> {
    const start = performance.now();
    const handle = await this.#backend.create();
    sink.push(performance.now() - start);
    return handle;
  }

  async #assertNoJournalTempLeak(log: (line: string) => void): Promise<void> {
    const count = await journalTempFileCount(this.#backend.journalPath);
    if (count > 0) {
      throw new SoakBudgetError(
        `journal directory holds ${count} leaked <state>.*.tmp file(s) — a writer crashed between temp write and atomic rename`,
      );
    }
    log("SOAK: journal directory has no leaked temp files");
  }

  #enforceBudgets(
    budgets: SoakBudgets,
    latency: LatencySummary,
    rssPeak: number,
    rssSamples: readonly number[],
    journalDirBytes: number,
  ): void {
    if (latency.count > 0 && latency.p95 > budgets.createP95Ms) {
      throw new SoakBudgetError(
        `create p95 ${latency.p95}ms exceeds budget ${budgets.createP95Ms}ms`,
      );
    }
    if (rssPeak > budgets.maxRssBytes) {
      throw new SoakBudgetError(
        `peak RSS ${mib(rssPeak)}MiB exceeds budget ${
          mib(budgets.maxRssBytes)
        }MiB`,
      );
    }
    const growth = rssGrowth(rssSamples);
    if (growth !== null && growth > budgets.rssGrowthFactor) {
      throw new SoakBudgetError(
        `RSS grew ${
          growth.toFixed(2)
        }× (late vs early median) — over the ${budgets.rssGrowthFactor}× unbounded-growth guard`,
      );
    }
    if (journalDirBytes > budgets.maxJournalDirBytes) {
      throw new SoakBudgetError(
        `journal dir ${kib(journalDirBytes)}KiB exceeds budget ${
          kib(budgets.maxJournalDirBytes)
        }KiB`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Journal-dir metrics
// ---------------------------------------------------------------------------

/** Total bytes of every file in the journal's directory. */
export async function journalDirSize(journalPath: string): Promise<number> {
  const dir = dirname(journalPath);
  let total = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      try {
        total += (await Deno.stat(join(dir, entry.name))).size;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  return total;
}

/** Count leaked `<state>.<uuid>.tmp` siblings of the journal file. */
export async function journalTempFileCount(
  journalPath: string,
): Promise<number> {
  const dir = dirname(journalPath);
  const prefix = `${basename(journalPath)}.`;
  let count = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name.startsWith(prefix) &&
        entry.name.endsWith(".tmp")
      ) {
        count++;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

/** Nearest-rank percentile of `values` (0..100). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Math.round(sorted[index]!);
}

function summarize(values: readonly number[]): LatencySummary {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? 0 : Math.round(Math.max(...values)),
  };
}

/** Late-run median ÷ early-run median RSS, or null when too few samples. */
export function rssGrowth(samples: readonly number[]): number | null {
  if (samples.length < 8) return null;
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const early = median(samples.slice(0, quarter));
  const late = median(samples.slice(samples.length - quarter));
  if (early <= 0) return null;
  return late / early;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function mib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function kib(bytes: number): number {
  return Math.round(bytes / 1024);
}

// ---------------------------------------------------------------------------
// Crash schedule (seeded, reproducible; crashes at random points)
// ---------------------------------------------------------------------------

/**
 * Choose `target` distinct cycle indices (1-based) at random points across
 * `cycles`, one per equal-width window so the drills are spread over the run.
 */
export function scheduleCrashCycles(
  cycles: number,
  target: number,
  rng: () => number,
): Set<number> {
  const chosen = new Set<number>();
  const wanted = Math.min(target, cycles);
  if (wanted <= 0) return chosen;
  const window = cycles / wanted;
  for (let i = 0; i < wanted; i++) {
    const lo = Math.floor(i * window);
    const hi = Math.floor((i + 1) * window);
    const span = Math.max(1, hi - lo);
    let cycle = lo + 1 + Math.floor(rng() * span);
    while (chosen.has(cycle) && cycle <= cycles) cycle++;
    if (cycle >= 1 && cycle <= cycles) chosen.add(cycle);
  }
  return chosen;
}

/** Small deterministic PRNG (mulberry32) for a reproducible crash schedule. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
