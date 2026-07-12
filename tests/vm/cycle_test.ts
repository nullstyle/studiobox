/**
 * The M5 full-lifecycle in-VM test (PLAN.md §M5, T3 tier).
 *
 * Drives the REAL rootd launch path — no fakes, no macOS tunnel — end to
 * end inside `fc-smoke`:
 *
 *   SupervisorCore.launch (stage golden set into a real jail, journal the
 *   artifact ref before spawn, boot a real jailed Firecracker microVM, dial
 *   studioboxd over real vsock)
 *     → probeAgent (real vsock reachability)
 *     → connectAgent → sandbox_agent plane:
 *         · exec `sh -c "echo hi; pwd"` → "hi" + cwd /home/app
 *         · write + read a file through FileSystem upload/download
 *         · deno repl `1+2 == 3`, then state carried across two snippets
 *     → kill → VM gone, jail reclaimed, vsock unlinked, journal terminal,
 *       artifact refcount released, overlay removed.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { ArtifactCache } from "../../images/cache.ts";
import { Sha256 } from "../../src/agent/sha256.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../../src/wire/contract.ts";
import { decodeReplValue } from "../../src/agent/deno_runtime_codec.ts";
import * as wire from "../../src/wire/generated/sandbox_agent_types.ts";
import {
  buildPlanner,
  CALL_TIMEOUT_MS,
  CAP_CALL,
  concatBytes,
  inGuest,
  jailExecDir,
  openAgentSession,
  pathExists,
  pidAlive,
  readVmConfig,
  registerSink,
  requireProcess,
  SinkCollector,
  spec,
  toHex,
  vsockHostPath,
} from "./support.ts";

Deno.test({
  name: "M5 cycle: launch → exec/fs/eval over real vsock → terminate",
  ignore: !inGuest,
  // The real VMM's outbound vsock conns and the jailer subprocess are torn
  // down inside the test; the sanitizers still verify nothing leaks.
}, async () => {
  const config = readVmConfig();
  const workDir = await Deno.makeTempDir({
    dir: config.workBase,
    prefix: "c-",
  });
  const planner = buildPlanner(config, workDir);
  const store = new JsonFileSandboxStore(join(workDir, "state.json"));
  const core = new SupervisorCore({
    store,
    planner,
    reclaimHooks: [planner.reclaimHook],
    buildId: "m5-cycle",
  });

  const sandboxId = "sbx-m5-cycle";
  const executionId = "e-cyc-1";
  const bootNonce = crypto.getRandomValues(new Uint8Array(32));

  try {
    // -- launch: real jailed VMM, real vsock probe to studioboxd -----------
    const status = await core.launch({
      sandboxId,
      executionId,
      artifactId: "artifact-golden",
      allocationId: "alloc-m5",
      bootNonce,
      idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
    });
    assertEquals(status.state, "running", "launch reaches running");
    assertEquals(status.sandboxId, sandboxId);
    const pid = status.pid!;
    assert(pidAlive(pid), "the real Firecracker VMM is alive");

    // Real vsock reachability (not just journal + liveness).
    await core.probeAgent(executionId);

    // -- drive the agent plane over the tracked machine's vsock ------------
    const coordinates = planner.coordinatesFor(executionId)!;
    const conn = await core.connectAgent(executionId);
    await using session = await openAgentSession(
      conn,
      coordinates.credential,
      sandboxId,
      bootNonce,
    );
    const { agent, wireClient } = session;

    assertEquals(
      await agent.ping(7n, { timeoutMs: CALL_TIMEOUT_MS }),
      7n,
      "agent ping over real vsock",
    );

    const spawner = await agent.processes(CAP_CALL);
    const fs = await agent.filesystem(CAP_CALL);
    const deno = await agent.deno(CAP_CALL);

    // -- exec: sh -c "echo hi; pwd" → "hi" + cwd /home/app ----------------
    {
      const sink = new SinkCollector();
      const process = requireProcess(
        await spawner.spawn({
          spec: spec({
            command: "/bin/sh",
            args: ["-c", "echo hi; pwd"],
          }),
          output: registerSink(wireClient, sink),
        }, CAP_CALL),
      );
      await sink.commit("stdout");
      const stdout = new TextDecoder().decode(sink.bytes("stdout"));
      assertEquals(stdout, "hi\n/home/app\n", "echo output + default cwd home");
      const done = await process.wait({ timeoutMs: CALL_TIMEOUT_MS });
      assertEquals(done.status?.code, 0, "exec exits 0");
      await process.close();
    }

    // -- fs: write then read a file back through the plane -----------------
    {
      const payload = new TextEncoder().encode("hello from M5\n");
      const payloadSha = new Sha256().update(payload).digest();
      const path = "/home/app/greeting.txt";

      const up = await fs.beginUpload({ path, mode: 0o644 }, CAP_CALL);
      assertEquals(up.which, "upload", up.error?.message);
      const upload = up.upload!;
      const sender = wire.createUploadChunkStreamSender(upload, {
        maxInFlight: DEFAULT_TRANSPORT_LIMITS.maxChunksInFlight,
        call: { timeoutMs: CALL_TIMEOUT_MS },
      });
      await sender.waitForCapacity();
      await sender.send({ sequence: 0n, data: payload });
      await sender.flush();
      const receipt = await upload.finish({
        totalBytes: BigInt(payload.byteLength),
        chunkCount: 1n,
        sha256: payloadSha,
      }, { timeoutMs: CALL_TIMEOUT_MS });
      assertEquals(receipt.which, "receipt", receipt.error?.message);
      await upload.close();

      const down = await fs.beginDownload(path, CAP_CALL);
      assertEquals(down.which, "reader", down.error?.message);
      const reader = down.reader!;
      const received: Uint8Array[] = [];
      let ended = false;
      while (!ended) {
        const r = await reader.read(64 * 1024, { timeoutMs: CALL_TIMEOUT_MS });
        if (r.which === "chunk") {
          received.push(r.chunk!.data.slice());
          continue;
        }
        assertEquals(r.which, "end", r.error?.message);
        ended = true;
      }
      await reader.close();
      assertEquals(
        new TextDecoder().decode(concatBytes(received)),
        "hello from M5\n",
        "file round-trips through the agent FileSystem plane",
      );
      assertEquals(
        toHex(new Sha256().update(concatBytes(received)).digest()),
        toHex(payloadSha),
      );
    }

    // -- deno repl: 1+2 == 3, and state across two snippets ----------------
    {
      const replResult = await deno.openRepl([], CAP_CALL);
      assertEquals(replResult.which, "repl", replResult.error?.message);
      const repl = replResult.repl!;
      const evalJson = (result: wire.EvalResult): unknown => {
        assertEquals(result.which, "json", result.error?.message);
        const frame = JSON.parse(new TextDecoder().decode(result.json!)) as {
          value: unknown;
        };
        return decodeReplValue(frame.value);
      };
      assertEquals(
        evalJson(await repl.eval("1 + 2", { timeoutMs: CALL_TIMEOUT_MS })),
        3,
        "deno.eval 1+2 == 3",
      );
      assertEquals(
        evalJson(
          await repl.eval("let carried = 40; carried", {
            timeoutMs: CALL_TIMEOUT_MS,
          }),
        ),
        40,
      );
      assertEquals(
        evalJson(
          await repl.eval("carried + 2", { timeoutMs: CALL_TIMEOUT_MS }),
        ),
        42,
        "repl state survives across snippets",
      );
      await repl.close({ timeoutMs: CALL_TIMEOUT_MS });
      await repl[Symbol.asyncDispose]();
    }

    await spawner.close();
    await fs.close();
    await deno.close();
    await agent.close();

    // -- terminate: VM gone, jail reclaimed, vsock unlinked, journal done --
    await core.kill(executionId);

    assert(!pidAlive(pid), "the VMM is gone after kill");
    assertEquals(
      await pathExists(jailExecDir(workDir, executionId)),
      false,
      "the jail exec dir is reclaimed",
    );
    assertEquals(
      await pathExists(vsockHostPath(workDir, executionId)),
      false,
      "the vsock socket is unlinked",
    );

    const record = await store.get(sandboxId);
    assertEquals(record?.phase, "terminated", "journal record is terminal");
    assertEquals(record?.terminationReason, "kill");

    // The artifact belt is released and the per-boot overlay removed.
    const cache = new ArtifactCache({ root: config.cacheRoot });
    assertEquals(
      await cache.refcount(config.manifestHash),
      0,
      "artifact refcount released on terminate",
    );
    assertEquals(
      await pathExists(join(workDir, "ov", `ov-${executionId}.ext4`)),
      false,
      "per-boot overlay removed on terminate",
    );

    // A terminal status view still resolves.
    const finalStatus = await core.status(executionId);
    assertEquals(finalStatus.state, "exited");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
});
