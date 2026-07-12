/**
 * Reconcile-drill fixture: a rootd-equivalent that boots ONE real jailed
 * microVM through a real {@linkcode SupervisorCore}, prints a `READY <json>`
 * line, then hangs forever waiting to be SIGKILLed — leaving an orphaned
 * Firecracker VMM and a live-looking journal for the restart reconcile
 * drill (`reconcile_test.ts`).
 *
 * Usage: deno run -A reconcile_crash_main.ts <workDir>
 * Reads the same `SBX_VM_*` environment contract as the rest of the tier.
 *
 * @module
 */

import { join } from "@std/path";
import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import {
  buildPlanner,
  jailExecDir,
  readVmConfig,
  vsockHostPath,
} from "./support.ts";

const workDir = Deno.args[0];
if (workDir === undefined) {
  console.error("usage: reconcile_crash_main.ts <workDir>");
  Deno.exit(2);
}

const config = readVmConfig();
const planner = buildPlanner(config, workDir);
const stateFile = join(workDir, "state.json");
const core = new SupervisorCore({
  store: new JsonFileSandboxStore(stateFile),
  planner,
  reclaimHooks: [planner.reclaimHook],
  buildId: "m5-reconcile-crash",
});

const sandboxId = "sbx-m5-recon";
const executionId = "e-recon-1";

const status = await core.launch({
  sandboxId,
  executionId,
  artifactId: "artifact-golden",
  allocationId: "alloc-recon",
  bootNonce: crypto.getRandomValues(new Uint8Array(32)),
  idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
});

console.log(
  `READY ${
    JSON.stringify({
      sandboxId,
      executionId,
      pid: status.pid,
      stateFile,
      jailExecDir: jailExecDir(workDir, executionId),
      vsockHostPath: vsockHostPath(workDir, executionId),
      overlayPath: join(workDir, "ov", `ov-${executionId}.ext4`),
      manifestHash: config.manifestHash,
      cacheRoot: config.cacheRoot,
    })
  }`,
);

// Hang until SIGKILLed, leaving the real VMM orphaned.
setInterval(() => {}, 1 << 30);
await new Promise<never>(() => {});
