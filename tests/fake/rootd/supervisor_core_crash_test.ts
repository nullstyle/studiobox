import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  CreateOnlyVmRegistry,
  SandboxStateJailRecordStore,
  StaleExecutionIdError,
} from "../../../src/rootd/firecracker/mod.ts";
import {
  SupervisorCore,
  type SupervisorLaunchPlanner,
} from "../../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";

const CRASH_MAIN = fromFileUrl(
  import.meta.resolve("./supervisor_core_crash_main.ts"),
);

interface LaunchedExecution {
  readonly sandboxId: string;
  readonly executionId: string;
  readonly pid: number;
  readonly jailRoot: string;
}

// Mirrors the package's liveness probe: signal 0 where the runtime
// supports it, SIGCONT otherwise (harmless to the fake VMM, ESRCH when
// the pid is gone, EPERM still means "exists").
function pidAlive(pid: number): boolean {
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

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  return await Deno.stat(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
}

async function spawnCrashSupervisor(
  workDir: string,
  count: number,
): Promise<{ child: Deno.ChildProcess; launched: LaunchedExecution[] }> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CRASH_MAIN, workDir, String(count)],
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
        throw new Error(`crash supervisor exited before READY:\n${stderr}`);
      }
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const line = buffer.split("\n", 1)[0]!;
  if (!line.startsWith("READY ")) {
    throw new Error(`unexpected crash supervisor output: ${line}`);
  }
  return {
    child,
    launched: JSON.parse(line.slice("READY ".length)) as LaunchedExecution[],
  };
}

const UNUSED_PLANNER: SupervisorLaunchPlanner = {
  resolve: () =>
    Promise.reject(new Error("the reconcile drill never launches")),
};

Deno.test(
  "crash drill: SIGKILLed supervisor -> restart -> destructive reconcile reaps everything",
  async () => {
    // Short base path: jail paths prefix Unix socket paths (~104 bytes).
    const workDir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-cd-" });
    try {
      const { child, launched } = await spawnCrashSupervisor(workDir, 2);
      assertEquals(launched.length, 2);
      for (const execution of launched) {
        assert(pidAlive(execution.pid), "fake VMM must be running pre-crash");
        assert(await statOrNull(execution.jailRoot) !== null);
      }

      // kill -9 the supervisor mid-flight.
      child.kill("SIGKILL");
      const status = await child.status;
      assertEquals(status.signal, "SIGKILL");
      await child.stdout.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});

      // The orphans must exist: nothing reaped them yet.
      for (const execution of launched) {
        assert(
          pidAlive(execution.pid),
          "fake VMM must survive the supervisor crash as an orphan",
        );
      }

      // Restart: a fresh core over the same journal directory.
      const store = new JsonFileSandboxStore(join(workDir, "state.json"));
      const preSweep = await store.list();
      assertEquals(preSweep.length, 2);
      for (const record of preSweep) {
        assertEquals(record.phase, "ready", "the crash left live journals");
      }

      const core = new SupervisorCore({
        store,
        planner: UNUSED_PLANNER,
        buildId: "crash-drill-restart",
      });
      const summary = await core.reconcile();

      assertEquals(summary.examined, 2);
      assertEquals(summary.killed, 2);
      assertEquals(summary.reclaimed, 2);
      assertEquals(summary.quarantined, 0);
      assertEquals(summary.failures, []);

      // Every orphan fake VMM is dead and every jail dir reclaimed.
      for (const execution of launched) {
        assert(
          !pidAlive(execution.pid),
          "reconcile must SIGKILL the orphan VMM",
        );
        assertEquals(
          await statOrNull(execution.jailRoot),
          null,
          "reconcile must reclaim the jail dir",
        );
      }

      // Every record is terminal with the destructive-restart reason.
      const converged = await store.list();
      assertEquals(converged.length, 2);
      for (const record of converged) {
        assertEquals(record.phase, "terminated");
        assertEquals(record.terminationReason, "host-restart");
        assertEquals(record.machine?.jailRecord, undefined);
      }

      // A stale pre-crash execution can never CAS over the converged state.
      const registry = new CreateOnlyVmRegistry(
        new SandboxStateJailRecordStore(store),
      );
      for (const execution of launched) {
        await assertRejects(
          () => registry.update(execution.executionId, { pid: 99_999 }),
          StaleExecutionIdError,
        );
      }

      // The second reconcile is a no-op.
      const again = await core.reconcile();
      assertEquals(again, {
        examined: 0,
        killed: 0,
        reclaimed: 0,
        quarantined: 0,
        failures: [],
      });
      const untouched = await store.list();
      assertEquals(
        untouched.map((record) => record.revision),
        converged.map((record) => record.revision),
        "a no-op sweep must not rewrite records",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
);
