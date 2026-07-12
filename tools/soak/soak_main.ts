/**
 * `deno task soak` — the HOST-SAFE 1.0 soak drill (PLAN.md §M11).
 *
 * Runs {@linkcode SoakRunner} against the {@linkcode FakeVmmSoakBackend}: real
 * `SupervisorCore` lifecycle over fake VMM / jailer shims + a temp journal,
 * with periodic kill-9-mid-fleet + reconcile, auditing for leaks after every
 * phase and enforcing RSS / journal-size / create-latency budgets. Runnable in
 * CI and dev on any OS — no VM, no root.
 *
 * The real-microVM drill is `deno task soak:vm` (`soak_vm_main.ts`), deferred
 * to avoid contending for the fc-smoke VM.
 *
 * Environment:
 * - `SBX_SOAK_CYCLES`  total create/use cycles (default 200; the 1.0 bar).
 * - `SBX_SOAK_CRASHES` kill-9+reconcile drills (default ~12; the 1.0 bar ≥10).
 * - `SBX_SOAK_BATCH`   sandboxes launched mid-fleet per drill (default 2).
 * - `SBX_SOAK_SEED`    RNG seed for the crash schedule (default 1).
 *
 * @module
 */

import { FakeVmmSoakBackend } from "./fake_backend.ts";
import {
  type SoakResult,
  SoakRunner,
  type SoakRunOptions,
} from "./soak_runner.ts";

/** Provision the fake backend, run the soak, and always tear it down. */
export async function runFakeSoak(
  options: SoakRunOptions = {},
): Promise<SoakResult> {
  const backend = await FakeVmmSoakBackend.provision();
  try {
    return await new SoakRunner(backend).run(options);
  } finally {
    await backend.close();
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  const options: SoakRunOptions = {
    cycles: intFromEnv("SBX_SOAK_CYCLES", 200),
    batchSize: intFromEnv("SBX_SOAK_BATCH", 2),
    seed: intFromEnv("SBX_SOAK_SEED", 1),
  };
  const crashes = Deno.env.get("SBX_SOAK_CRASHES");
  if (crashes !== undefined && crashes !== "") {
    (options as { crashes?: number }).crashes = intFromEnv(
      "SBX_SOAK_CRASHES",
      12,
    );
  }
  try {
    const result = await runFakeSoak(options);
    console.log(
      `SOAK: PASS — ${result.cycles} cycles / ${result.crashes} reconciles clean; no leaks across ${result.audits} audits`,
    );
  } catch (error) {
    console.error(
      `SOAK: FAIL — ${
        error instanceof Error ? error.stack ?? error.message : error
      }`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) await main();
