/**
 * Crash-drill fixture: a supervisor process destined to die badly.
 *
 * Launches N fake-VMM machines through a real SupervisorCore journaled at
 * `<workDir>/state.json`, prints one `READY <json>` line describing the
 * launched executions, then hangs until the test SIGKILLs it — leaving
 * orphaned fake VMMs and a live-looking journal for the restart
 * reconciliation drill.
 *
 * Usage: deno run -A supervisor_core_crash_main.ts <workDir> <count>
 */

import { basename, join } from "@std/path";
import {
  makeFakeJailerBin,
  makeFakeVmmBin,
} from "@nullstyle/firecracker/testing";
import {
  SupervisorCore,
  type SupervisorLaunchPlanner,
} from "../../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";

const workDir = Deno.args[0];
const count = Number(Deno.args[1] ?? "2");
if (workDir === undefined || !Number.isInteger(count) || count < 1) {
  console.error("usage: supervisor_core_crash_main.ts <workDir> <count>");
  Deno.exit(2);
}

const firecrackerBin = await makeFakeVmmBin(workDir, "ready");
const jailerBin = await makeFakeJailerBin(workDir);
const kernel = join(workDir, "vmlinux-src");
await Deno.writeTextFile(kernel, "crash drill kernel fixture\n");
const chrootBaseDir = join(workDir, "j");

const planner: SupervisorLaunchPlanner = {
  resolve: () =>
    Promise.resolve({
      jailer: {
        jailerBin,
        firecrackerBin,
        uid: Deno.uid() ?? 0,
        gid: Deno.gid() ?? 0,
        chrootBaseDir,
      },
      stage: [{ hostPath: kernel, jailPath: "/vmlinux" }],
      config: { boot_source: { kernel_image_path: "/vmlinux" } },
      readinessTimeoutMs: 10_000,
    }),
};

const core = new SupervisorCore({
  store: new JsonFileSandboxStore(join(workDir, "state.json")),
  planner,
  buildId: "crash-drill",
});

const launched: Array<{
  sandboxId: string;
  executionId: string;
  pid: number;
  jailRoot: string;
}> = [];
for (let index = 0; index < count; index++) {
  // Keep execution ids short: the jail path prefixes every in-jail Unix
  // socket path and sun_path is ~104 bytes on macOS.
  const executionId = `exec-cd-${index}`;
  const status = await core.launch({
    sandboxId: `sbx-crash-${index}`,
    executionId,
    artifactId: "artifact-fixture",
    allocationId: "alloc-fixture",
    bootNonce: crypto.getRandomValues(new Uint8Array(32)),
    idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
  });
  launched.push({
    sandboxId: status.sandboxId,
    executionId,
    pid: status.pid!,
    jailRoot: join(chrootBaseDir, basename(firecrackerBin), executionId),
  });
}

console.log(`READY ${JSON.stringify(launched)}`);
setInterval(() => {}, 1 << 30);
await new Promise<never>(() => {});
