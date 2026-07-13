/**
 * SoakRunner behaviour (PLAN.md §M11): the control flow, the after-every-phase
 * audit, the fail-loud-on-leak contract, and the resource budgets — proven
 * fast with an in-memory {@linkcode StubSoakBackend}; then the end-to-end
 * fake-VMM soak proving (a) N cycles + kill-9-reconcile complete correctly and
 * (c) a clean run reports zero, plus a deliberately-leaky backend proving the
 * runner fails loud with the exact leak.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

import { LeakAudit, LeakDetectedError } from "../../tools/soak/leak_audit.ts";
import {
  journalDirSize,
  journalTempFileCount,
  mulberry32,
  percentile,
  rssGrowth,
  scheduleCrashCycles,
  type SoakBackend,
  SoakBudgetError,
  type SoakBudgets,
  SoakRunner,
  type SoakSandboxHandle,
} from "../../tools/soak/soak_runner.ts";
import { FakeVmmSoakBackend } from "../../tools/soak/fake_backend.ts";

// ---------------------------------------------------------------------------
// Metrics + scheduling unit tests (no backend)
// ---------------------------------------------------------------------------

Deno.test("percentile: nearest-rank, clamped, empty-safe", () => {
  const values = [10, 20, 30, 40, 50];
  assertEquals(percentile(values, 50), 30);
  assertEquals(percentile(values, 95), 50);
  assertEquals(percentile(values, 100), 50);
  assertEquals(percentile([], 95), 0);
});

Deno.test("rssGrowth: null below 8 samples, ~1 when flat, >1 when climbing", () => {
  assertEquals(rssGrowth([1, 2, 3]), null);
  const flat = rssGrowth(new Array(16).fill(100)) ?? 0;
  assertEquals(flat, 1);
  const climbing = rssGrowth(
    Array.from({ length: 16 }, (_, i) => 100 + i * 50),
  );
  assert(climbing !== null && climbing > 1.5, `growth ${climbing}`);
});

Deno.test("scheduleCrashCycles: exact count, spread, in range, deterministic", () => {
  const a = scheduleCrashCycles(100, 10, mulberry32(1));
  assertEquals(a.size, 10);
  for (const cycle of a) assert(cycle >= 1 && cycle <= 100);
  const b = scheduleCrashCycles(100, 10, mulberry32(1));
  assertEquals([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));
  // Target above the cycle count is clamped.
  assert(scheduleCrashCycles(5, 20, mulberry32(2)).size <= 5);
  assertEquals(scheduleCrashCycles(10, 0, mulberry32(1)).size, 0);
});

Deno.test("mulberry32: deterministic, in [0,1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 20; i++) {
    const v = a();
    assertEquals(v, b());
    assert(v >= 0 && v < 1);
  }
});

Deno.test("journalDirSize + journalTempFileCount over a real dir", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-jd-" });
  try {
    const journalPath = join(dir, "state.json");
    await Deno.writeTextFile(journalPath, "x".repeat(120));
    await Deno.writeTextFile(join(dir, "state.json.abc.tmp"), "y".repeat(30));
    assertEquals(await journalDirSize(journalPath), 150);
    assertEquals(await journalTempFileCount(journalPath), 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// StubSoakBackend: fast, in-memory control-flow + budget coverage
// ---------------------------------------------------------------------------

interface StubOptions {
  readonly createDelayMs?: number;
  readonly rss?: number;
  readonly rssStep?: number;
  /** Inject a `process` leak on the Nth `use` call. */
  readonly leakOnUse?: number;
}

class StubSoakBackend implements SoakBackend {
  readonly audit: LeakAudit;
  readonly journalPath: string;
  crashCalls = 0;
  useCalls = 0;
  readonly #dir: string;
  readonly #opts: StubOptions;
  #leak: string[] = [];
  #rss: number;
  #seq = 0;

  private constructor(dir: string, opts: StubOptions) {
    this.#dir = dir;
    this.#opts = opts;
    this.journalPath = join(dir, "state.json");
    this.#rss = opts.rss ?? 50 * 1024 * 1024;
    this.audit = new LeakAudit([{
      leakClass: "process",
      enumerate: () => Promise.resolve([...this.#leak]),
    }]);
  }

  static async create(opts: StubOptions = {}): Promise<StubSoakBackend> {
    const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-stub-" });
    await Deno.writeTextFile(join(dir, "state.json"), "{}");
    return new StubSoakBackend(dir, opts);
  }

  async create(): Promise<SoakSandboxHandle> {
    if (this.#opts.createDelayMs) {
      await new Promise((r) => setTimeout(r, this.#opts.createDelayMs));
    }
    const n = this.#seq++;
    return { sandboxId: `sbx-s${n}`, executionId: `e${n}`, pid: 1000 + n };
  }
  use(_handle: SoakSandboxHandle): Promise<void> {
    this.useCalls++;
    if (this.useCalls === this.#opts.leakOnUse) this.#leak = ["pid=666"];
    return Promise.resolve();
  }
  terminate(_handle: SoakSandboxHandle): Promise<void> {
    return Promise.resolve();
  }
  crashAndReconcile(_batchSize: number): Promise<void> {
    this.crashCalls++;
    return Promise.resolve();
  }
  allowanceFor(): Record<never, never> {
    return {};
  }
  sampleRssBytes(): number {
    const value = this.#rss;
    this.#rss += this.#opts.rssStep ?? 0;
    return value;
  }
  async close(): Promise<void> {
    await Deno.remove(this.#dir, { recursive: true }).catch(() => {});
  }
}

const LENIENT: Partial<SoakBudgets> = {
  createP95Ms: 60_000,
  maxRssBytes: 8 * 1024 * 1024 * 1024,
  rssGrowthFactor: 100,
  maxJournalDirBytes: 64 * 1024 * 1024,
};

Deno.test("SoakRunner: completes a clean stub run and audits every phase", async () => {
  const backend = await StubSoakBackend.create();
  try {
    const result = await new SoakRunner(backend).run({
      cycles: 12,
      crashes: 3,
      seed: 4,
      budgets: LENIENT,
    });
    assertEquals(result.cycles, 12);
    assertEquals(result.crashes, 3);
    assertEquals(backend.crashCalls, 3);
    // 9 normal cycles × (create+use+terminate = 3 audits) + 3 crash × 1 audit.
    assertEquals(result.audits, 9 * 3 + 3);
    assertEquals(result.creates, 9);
    assertEquals(result.skipped.length, 10); // only `process` is wired
  } finally {
    await backend.close();
  }
});

Deno.test("SoakRunner: fails LOUD with cycle context when a leak appears mid-run", async () => {
  const backend = await StubSoakBackend.create({ leakOnUse: 2 });
  try {
    const error = await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 5,
          crashes: 0,
          budgets: LENIENT,
        }),
      LeakDetectedError,
    );
    assert(error.message.includes("cycle 2"), error.message);
    assert(error.message.includes("process"), error.message);
    assertEquals(error.report.findings[0]!.resources, ["pid=666"]);
  } finally {
    await backend.close();
  }
});

Deno.test("SoakRunner: create-latency p95 budget is enforced", async () => {
  const backend = await StubSoakBackend.create({ createDelayMs: 15 });
  try {
    await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 3,
          crashes: 0,
          budgets: { ...LENIENT, createP95Ms: 3 },
        }),
      SoakBudgetError,
      "create p95",
    );
  } finally {
    await backend.close();
  }
});

Deno.test("SoakRunner: peak-RSS budget is enforced", async () => {
  const backend = await StubSoakBackend.create({ rss: 50 * 1024 * 1024 });
  try {
    await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 3,
          crashes: 0,
          budgets: { ...LENIENT, maxRssBytes: 1000 },
        }),
      SoakBudgetError,
      "peak RSS",
    );
  } finally {
    await backend.close();
  }
});

Deno.test("SoakRunner: unbounded-RSS-growth guard is enforced", async () => {
  const backend = await StubSoakBackend.create({
    rss: 10 * 1024 * 1024,
    rssStep: 10 * 1024 * 1024,
  });
  try {
    await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 12,
          crashes: 0,
          budgets: { ...LENIENT, rssGrowthFactor: 1.2 },
        }),
      SoakBudgetError,
      "RSS grew",
    );
  } finally {
    await backend.close();
  }
});

Deno.test("SoakRunner: journal-dir size budget is enforced", async () => {
  const backend = await StubSoakBackend.create();
  try {
    await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 2,
          crashes: 0,
          budgets: { ...LENIENT, maxJournalDirBytes: 1 },
        }),
      SoakBudgetError,
      "journal dir",
    );
  } finally {
    await backend.close();
  }
});

Deno.test("SoakRunner: a leaked journal temp file fails the run", async () => {
  const backend = await StubSoakBackend.create();
  try {
    await Deno.writeTextFile(`${backend.journalPath}.orphan.tmp`, "leaked");
    await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 1,
          crashes: 0,
          budgets: LENIENT,
        }),
      SoakBudgetError,
      "leaked",
    );
  } finally {
    await backend.close();
  }
});

// ---------------------------------------------------------------------------
// End-to-end fake-VMM soak (real SupervisorCore + fake VMM/jailer shims)
// ---------------------------------------------------------------------------

Deno.test("fake-VMM soak: cycles + kill-9-reconcile complete clean, zero leaks", async () => {
  const backend = await FakeVmmSoakBackend.provision();
  try {
    const result = await new SoakRunner(backend).run({
      cycles: 6,
      crashes: 2,
      batchSize: 1,
      seed: 5,
      budgets: { ...LENIENT, createP95Ms: 60_000 },
    });
    assertEquals(result.cycles, 6);
    assertEquals(result.crashes, 2);
    assert(result.creates >= 1, "at least one normal-cycle create");
    // The Linux-only classes are honestly reported as bounded coverage.
    assertEquals([...result.skipped].sort(), [
      "dnsmasq",
      "mount",
      "netns",
      "nftables",
      "tap",
    ]);
    // After the run, a fresh audit still reports zero.
    const report = await backend.audit.audit();
    assertEquals(report.clean, true, JSON.stringify(report.findings));
  } finally {
    await backend.close();
  }
});

Deno.test("fake-VMM soak: a leaky backend makes the runner fail LOUD with the exact leak", async () => {
  const backend = await FakeVmmSoakBackend.provision({ reclaim: false });
  try {
    const error = await assertRejects(
      () =>
        new SoakRunner(backend).run({
          cycles: 3,
          crashes: 0,
          batchSize: 1,
          seed: 1,
          budgets: { ...LENIENT, createP95Ms: 60_000 },
        }),
      LeakDetectedError,
    );
    const classes = error.report.findings.map((f) => f.leakClass);
    assert(classes.includes("overlay"), `overlay not flagged: ${classes}`);
    assert(
      classes.includes("artifactRefcount"),
      `refcount not flagged: ${classes}`,
    );
  } finally {
    await backend.close();
  }
});
