/**
 * The M5 reconcile drill on real hardware (PLAN.md §M5, T3 tier).
 *
 * Boots a real jailed microVM in a child "rootd" process, `kill -9`s that
 * process mid-life leaving a REAL orphaned Firecracker VMM, then restarts a
 * fresh {@linkcode SupervisorCore} over the same journal and runs the
 * destructive reconcile. Asserts the package's real `/proc`-identity sweep
 * killed the orphan, the jail + overlay were reclaimed, the artifact belt
 * released, and the record converged to `terminated(host-restart)`.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { ArtifactCache } from "../../images/cache.ts";
import {
  buildPlanner,
  denoConfigArgs,
  inGuest,
  pathExists,
  pidAlive,
  readVmConfig,
} from "./support.ts";

const CRASH_MAIN = fromFileUrl(
  import.meta.resolve("./reconcile_crash_main.ts"),
);

interface CrashReady {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly pid: number;
  readonly stateFile: string;
  readonly jailExecDir: string;
  readonly vsockHostPath: string;
  readonly overlayPath: string;
  readonly manifestHash: string;
  readonly cacheRoot: string;
}

async function spawnCrashRootd(
  workDir: string,
): Promise<{ child: Deno.ChildProcess; ready: CrashReady }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-vsock",
      ...denoConfigArgs(),
      CRASH_MAIN,
      workDir,
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        const stderr = await new Response(child.stderr).text();
        await child.status;
        throw new Error(`crash rootd exited before READY:\n${stderr}`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const line = buffer.split("\n", 1)[0]!;
  if (!line.startsWith("READY ")) {
    throw new Error(`unexpected crash rootd output: ${line}`);
  }
  return {
    child,
    ready: JSON.parse(line.slice("READY ".length)) as CrashReady,
  };
}

Deno.test({
  name: "M5 reconcile: kill -9 rootd → orphan VMM → restart sweep reaps it",
  ignore: !inGuest,
}, async () => {
  const config = readVmConfig();
  const workDir = await Deno.makeTempDir({
    dir: config.workBase,
    prefix: "r-",
  });
  try {
    // The artifact belt for this manifest hash may already carry a NON-ZERO
    // refcount from an EARLIER in-VM test that leaked a VM in this SAME process
    // (exactly what bit the full suite: an absolute `refcount === 1` assertion
    // breaks the moment anything upstream leaks a hold). So capture a BASELINE
    // before this drill's launch and assert a DELTA against it — never an
    // absolute count. The crash rootd reads the same `SBX_VM_*` contract as the
    // suite, so its cache root + manifest hash are the suite's own and knowable
    // before the spawn (they equal `ready.cacheRoot` / `ready.manifestHash`).
    const cache = new ArtifactCache({ root: config.cacheRoot });
    const beltBefore = await cache.refcount(config.manifestHash);

    const { child, ready } = await spawnCrashRootd(workDir);

    // The real VMM is live and jailed before the crash.
    assert(pidAlive(ready.pid), "VMM alive pre-crash");
    assert(await pathExists(ready.jailExecDir), "jail exists pre-crash");
    // The journaled launch pins the belt: exactly one MORE hold than baseline.
    assertEquals(
      await cache.refcount(ready.manifestHash),
      beltBefore + 1,
      "journaled launch pins the artifact belt (+1 over any baseline)",
    );

    // kill -9 the rootd-equivalent mid-life: the VMM is orphaned, not reaped.
    child.kill("SIGKILL");
    const st = await child.status;
    assertEquals(st.signal, "SIGKILL");
    await child.stdout.cancel().catch(() => {});
    await child.stderr.cancel().catch(() => {});
    assert(pidAlive(ready.pid), "VMM survives the rootd crash as an orphan");

    // Restart: a fresh core over the same journal + a fresh reclaim hook.
    const planner = buildPlanner(config, workDir);
    const restarted = new SupervisorCore({
      store: new JsonFileSandboxStore(ready.stateFile),
      planner,
      reclaimHooks: [planner.reclaimHook],
      buildId: "m5-reconcile-restart",
    });

    const summary = await restarted.reconcile();
    assertEquals(summary.quarantined, 0, "nothing quarantined");
    assertEquals(summary.reclaimed, 1, "the record was reclaimed");
    assert(summary.killed >= 1, "the package sweep killed the orphan VMM");

    // Real teardown assertions.
    assert(!pidAlive(ready.pid), "the orphan VMM was SIGKILLed by the sweep");
    assertEquals(
      await pathExists(ready.jailExecDir),
      false,
      "the jail was reclaimed",
    );
    assertEquals(
      await pathExists(ready.overlayPath),
      false,
      "the per-boot overlay was reclaimed",
    );
    // Reconcile reaps the orphan and releases its hold, returning the belt to
    // exactly the pre-launch baseline (a leaked baseline, if any, is left as-is
    // — this drill only proves ITS launch's hold is released, not that the belt
    // reaches zero).
    assertEquals(
      await cache.refcount(ready.manifestHash),
      beltBefore,
      "reconcile released the launch's belt (back to the baseline)",
    );

    const record = await new JsonFileSandboxStore(ready.stateFile).get(
      ready.sandboxId,
    );
    assertEquals(record?.phase, "terminated", "record is terminal");
    assertEquals(record?.terminationReason, "host-restart");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});
