/**
 * DEFECT A (availability) — REAL-VSOCK validation (PLAN.md §M5, T3 tier).
 *
 * Reproduces the original hang scenario against the REAL guest inside
 * `fc-smoke`: boot a real jailed Firecracker microVM running the real
 * studioboxd on real AF_VSOCK, then dial its vsock and send a malformed
 * TRANSPORT frame and STALL — the exact shape that used to hang the host
 * dialer forever AND leak the studioboxd per-connection session. Asserts
 * the guest now DROPS the abusive connection promptly (our end sees EOF /
 * a peer reset — the session was torn down, not leaked) and the accept
 * loop stays healthy: a fresh, legit `openAgentSession` still completes the
 * bootstrap and round-trips `ping` over the same guest.
 *
 * Pre-fix (studioboxd onError not wired to teardown; no handshake
 * deadline) the abusive read never settles — the connection leaks — and
 * this test hangs. Requires the fixed studioboxd baked into the rootfs.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import {
  buildPlanner,
  CALL_TIMEOUT_MS,
  inGuest,
  openAgentSession,
  pidAlive,
  readVmConfig,
} from "./support.ts";

// The guest studioboxd is launched by overlay-init with the DEFAULT
// handshake deadline (15s); a garbage frame trips onError → teardown far
// sooner, but budget well past the deadline so no path can be a false hang.
const DROP_BUDGET_MS = 25_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

Deno.test({
  name:
    "M5 defect A: a malformed vsock frame is dropped, not leaked; guest stays healthy",
  ignore: !inGuest,
}, async () => {
  const config = readVmConfig();
  const workDir = await Deno.makeTempDir({
    dir: config.workBase,
    prefix: "hl-",
  });
  const planner = buildPlanner(config, workDir);
  const store = new JsonFileSandboxStore(join(workDir, "state.json"));
  const core = new SupervisorCore({
    store,
    planner,
    reclaimHooks: [planner.reclaimHook],
    buildId: "m5-defect-a",
  });

  const sandboxId = "sbx-m5-defect-a";
  const executionId = "e-hl-1";
  const bootNonce = crypto.getRandomValues(new Uint8Array(32));

  try {
    const status = await core.launch({
      sandboxId,
      executionId,
      artifactId: "artifact-golden",
      allocationId: "alloc-hl",
      bootNonce,
      idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
    });
    assertEquals(status.state, "running", "launch reaches running");
    const pid = status.pid!;
    assert(pidAlive(pid), "the real Firecracker VMM is alive");

    // -- the abusive dial: real vsock, malformed frame, then stall --------
    const badConn = await core.connectAgent(executionId);
    await badConn.write(crypto.getRandomValues(new Uint8Array(48)));
    // Do NOT close: hold the connection open and wait for the guest to drop
    // us. Pre-fix this read hangs forever (leaked session).
    const buf = new Uint8Array(64);
    let dropped = false;
    try {
      const n = await withTimeout(
        badConn.read(buf),
        DROP_BUDGET_MS,
        "guest-drop",
      );
      dropped = n === null; // EOF: the guest closed its end.
    } catch (error) {
      if (error instanceof Error && /timed out/.test(error.message)) {
        throw error; // The defect: the guest leaked the connection.
      }
      dropped = true; // A reset/bad-resource is the guest closing on us.
    } finally {
      try {
        badConn.close();
      } catch {
        // Already closed by the guest.
      }
    }
    assert(dropped, "the guest must drop the malformed connection");
    assert(pidAlive(pid), "the guest survives the abusive connection");

    // -- the accept loop is healthy: a legit session still round-trips ----
    const coordinates = planner.coordinatesFor(executionId)!;
    const goodConn = await core.connectAgent(executionId);
    await using session = await openAgentSession(
      goodConn,
      coordinates.credential,
      sandboxId,
      bootNonce,
    );
    assertEquals(
      await session.agent.ping(9n, { timeoutMs: CALL_TIMEOUT_MS }),
      9n,
      "a legit agent session still round-trips after the abuse",
    );
    await session.agent.close();

    await core.kill(executionId);
    assert(!pidAlive(pid), "the VMM is gone after kill");
    const record = await store.get(sandboxId);
    assertEquals(record?.phase, "terminated", "journal record is terminal");
  } finally {
    await core.kill(executionId).catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});
