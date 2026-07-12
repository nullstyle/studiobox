/**
 * Lifecycle regression tests for {@linkcode AgentBackedSandbox} `close()` /
 * `kill()` — pinning three defects the M8 adversarial verify pass confirmed:
 *
 *  1. **Teardown deadlock.** `close()`/`kill()`/`await using` drained the
 *     inherit-stdio pumps BEFORE dropping the connection, but an `inherit`
 *     pump (the DEFAULT for stdout/stderr) only ends when the process's stream
 *     ends — which for a still-live process happens only when the connection
 *     drops. So any sandbox with a running default-stdio process hung on exit.
 *  2. **Swallowed kill failure.** `kill()` reported success even when the
 *     authoritative terminate failed — the caller believed the VM dead.
 *  3. **kill-after-close no-op.** `close()` and `kill()` coalesced onto one
 *     memoized promise; a `kill()` after `close()` returned that promise and
 *     never issued the terminate, reporting a success it never attempted.
 *
 * Hand-rolled fakes (no VM, no UDS) make the ordering deterministic.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  AgentBackedSandbox,
  type SandboxLifecycle,
} from "../../../src/sdk/sandbox.ts";
import type { SandboxBackend } from "../../../src/sdk/wire_agent.ts";
import type { AgentProcess } from "../../../src/agent/api.ts";
import { SandboxKillError } from "../../../src/api/errors.ts";

/** A process whose stdout never ends until `endStdout()` is invoked. */
function neverEndingProcess(): {
  process: AgentProcess;
  endStdout: () => void;
} {
  let closeStream: () => void = () => {};
  const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      closeStream = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });
  type Status = Awaited<AgentProcess["status"]>;
  let resolveStatus: (s: Status) => void = () => {};
  const status = new Promise<Status>((resolve) => {
    resolveStatus = resolve;
  });
  const process: AgentProcess = {
    pid: 4321,
    stdout,
    stderr: null,
    status,
    kill: () => Promise.resolve(),
    writeStdin: () => Promise.resolve(),
    closeStdin: () => Promise.resolve(),
  };
  return {
    process,
    endStdout: () => {
      closeStream();
      resolveStatus({
        code: 143,
        signal: "SIGTERM",
        signaled: true,
        oom: false,
      });
    },
  };
}

function fakeBackend(
  spawn: SandboxBackend["processes"]["spawn"],
): SandboxBackend {
  return {
    processes: { spawn },
    fs: {} as SandboxBackend["fs"],
    env: {} as SandboxBackend["env"],
    deno: {} as SandboxBackend["deno"],
  };
}

interface FakeLifecycle extends SandboxLifecycle {
  teardownCalls: number;
  killCalls: number;
}

function fakeLifecycle(
  opts?: { onTeardown?: () => void; killResult?: () => Promise<void> },
): FakeLifecycle {
  const lc: FakeLifecycle = {
    id: `sbx_loc_${"a".repeat(20)}`,
    teardownCalls: 0,
    killCalls: 0,
    teardown: () => {
      lc.teardownCalls++;
      opts?.onTeardown?.();
      return Promise.resolve();
    },
    kill: () => {
      lc.killCalls++;
      return opts?.killResult ? opts.killResult() : Promise.resolve();
    },
    extendTimeout: () => Promise.resolve(new Date(0)),
  };
  return lc;
}

/** Resolve `p`, or the sentinel `"TIMED_OUT"` after `ms` (timer cleared on win). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "TIMED_OUT"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMED_OUT"), ms);
    p.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const noSpawn: SandboxBackend["processes"]["spawn"] = () =>
  Promise.reject(new Error("spawn not used in this test"));

Deno.test("close() drops the connection before draining inherit pumps (no deadlock)", async () => {
  const { process, endStdout } = neverEndingProcess();
  // teardown() ends the (otherwise endless) stdout stream — modeling the real
  // connection drop that lets an inherit pump complete.
  const lifecycle = fakeLifecycle({ onTeardown: endStdout });
  const sandbox = new AgentBackedSandbox(
    fakeBackend(() => Promise.resolve(process)),
    lifecycle,
  );

  // Default stdio => an inherit pump is installed on the endless stdout.
  const child = await sandbox.spawn("run-forever");
  assertEquals(child.pid, 4321);

  const outcome = await withTimeout(
    sandbox.close().then(() => "closed" as const),
    2_000,
  );
  assertEquals(outcome, "closed", "close() must resolve, not hang on the pump");
  assertEquals(lifecycle.teardownCalls, 1);
});

Deno.test("kill() surfaces the authoritative-terminate failure", async () => {
  const lifecycle = fakeLifecycle({
    killResult: () =>
      Promise.reject(new SandboxKillError(500, "vmm refused to die")),
  });
  const sandbox = new AgentBackedSandbox(fakeBackend(noSpawn), lifecycle);

  const error = await assertRejects(() => sandbox.kill(), SandboxKillError);
  assert(error.message.includes("vmm refused to die"));
  assertEquals(lifecycle.killCalls, 1);
  // The connection is still torn down even though the terminate failed.
  assertEquals(lifecycle.teardownCalls, 1);
});

Deno.test("kill() after close() still issues the authoritative terminate", async () => {
  const lifecycle = fakeLifecycle();
  const sandbox = new AgentBackedSandbox(fakeBackend(noSpawn), lifecycle);

  await sandbox.close();
  assertEquals(lifecycle.killCalls, 0, "close() alone must not kill");

  await sandbox.kill();
  assertEquals(lifecycle.killCalls, 1, "a later kill() is NOT a silent no-op");
  assertEquals(lifecycle.teardownCalls, 1, "teardown coalesces (idempotent)");
});

Deno.test("close() and kill() are each idempotent", async () => {
  const lifecycle = fakeLifecycle();
  const sandbox = new AgentBackedSandbox(fakeBackend(noSpawn), lifecycle);

  await sandbox.kill();
  await sandbox.kill();
  await sandbox.close();
  await sandbox[Symbol.asyncDispose]();

  assertEquals(lifecycle.killCalls, 1);
  assertEquals(lifecycle.teardownCalls, 1);
});
