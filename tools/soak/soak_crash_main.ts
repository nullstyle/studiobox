/**
 * The doomed child supervisor for the soak's kill-9-mid-fleet drill
 * (PLAN.md §M11), the fake-VMM analogue of `tests/vm/reconcile_crash_main.ts`.
 *
 * Launches N fake-VMM sandboxes to `ready` through a real
 * {@linkcode SupervisorCore} over the journal named in the shared config,
 * prints one `READY <json>` line describing them, then hangs until the parent
 * `kill -9`s it — leaving orphan fake VMMs and a live-looking journal for the
 * parent's destructive reconcile.
 *
 * Usage: `deno run -A soak_crash_main.ts <configJson> <batchSize> <crashIndex>`
 *
 * @module
 */

import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { join } from "@std/path";
import {
  type CrashLaunch,
  FakeVmmPlanner,
  type FakeVmmSoakConfig,
} from "./fake_backend.ts";

const configJson = Deno.args[0];
const batchSize = Number(Deno.args[1] ?? "2");
const crashIndex = Number(Deno.args[2] ?? "0");
if (
  configJson === undefined || !Number.isInteger(batchSize) || batchSize < 1 ||
  !Number.isInteger(crashIndex) || crashIndex < 0
) {
  console.error(
    "usage: soak_crash_main.ts <configJson> <batchSize> <crashIndex>",
  );
  Deno.exit(2);
}

const config = JSON.parse(configJson) as FakeVmmSoakConfig;
const core = new SupervisorCore({
  store: new JsonFileSandboxStore(join(config.workDir, "state.json")),
  planner: new FakeVmmPlanner(config),
  // No reclaim hooks: the parent's restart reconcile owns reclamation, exactly
  // as a crashed rootd leaves its journal for the next process.
  buildId: `soak-crash-${crashIndex}`,
});

const launched: CrashLaunch[] = [];
for (let i = 0; i < batchSize; i++) {
  // Globally unique across the run: `<crashIndex>-<i>` never collides with a
  // prior crash batch (the create-only journal rejects a reused id).
  const sandboxId = `sbx-x${crashIndex}-${i}`;
  const executionId = `x${crashIndex}-${i}`;
  const status = await core.launch({
    sandboxId,
    executionId,
    artifactId: "artifact-soak",
    allocationId: "alloc-soak",
    bootNonce: crypto.getRandomValues(new Uint8Array(32)),
    idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
  });
  launched.push({ sandboxId, executionId, pid: status.pid! });
}

console.log(`READY ${JSON.stringify(launched)}`);
// Hang until the parent SIGKILLs us, leaving the orphans + live journal.
setInterval(() => {}, 1 << 30);
await new Promise<never>(() => {});
