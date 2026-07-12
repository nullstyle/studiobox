/**
 * Host-safe unit tests for the M10 cgroup v2 OOM annotator
 * ({@linkcode createCgroupOomAnnotator}) and its parse helpers. All cases
 * use an injected fake {@linkcode CgroupReader}, so the logic is asserted
 * on macOS with no real cgroupfs. One run-permission-gated integration
 * test proves the spawner only consults the annotator for the `137` path.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  AgentError,
  type AgentKillSignal,
  type AgentOomAnnotator,
} from "../../../src/agent/api.ts";
import {
  AgentProcesses,
  type CgroupMemoryEvents,
  type CgroupReader,
  createCgroupOomAnnotator,
  parseMemoryEventsOomKill,
  parseSelfCgroupMemoryEventsPath,
} from "../../../src/agent/processes.ts";

// ---------------------------------------------------------------------------
// A scripted fake cgroup reader
// ---------------------------------------------------------------------------

/**
 * Dispenses `readMemoryEvents` results FIFO from a scripted list; a number
 * becomes `{ oomKill }`, an `Error` rejects (missing file / non-cgroup-v2).
 */
class FakeCgroupReader implements CgroupReader {
  resolveCalls = 0;
  readCalls = 0;
  readonly #events: Array<number | Error>;
  readonly #path: string | Error;

  constructor(
    events: Array<number | Error>,
    path: string | Error = "/sys/fs/cgroup/studiobox/memory.events",
  ) {
    this.#events = [...events];
    this.#path = path;
  }

  resolveSelfMemoryEventsPath(): Promise<string> {
    this.resolveCalls++;
    return this.#path instanceof Error
      ? Promise.reject(this.#path)
      : Promise.resolve(this.#path);
  }

  readMemoryEvents(_path: string): Promise<CgroupMemoryEvents> {
    this.readCalls++;
    const next = this.#events.shift();
    if (next === undefined) {
      return Promise.reject(new Error("fake reader: no scripted event left"));
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ oomKill: next });
  }
}

const kill137 = { pid: 42, code: 137, signal: "SIGKILL" as AgentKillSignal };

// ---------------------------------------------------------------------------
// Annotator logic
// ---------------------------------------------------------------------------

Deno.test("oom annotator: code 137 + oom_kill incremented -> true", async () => {
  // baseline read = 0, post-death read = 1 -> incremented.
  const reader = new FakeCgroupReader([0, 1]);
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), true);
});

Deno.test("oom annotator: code 137 + oom_kill unchanged -> false", async () => {
  const reader = new FakeCgroupReader([1, 1]);
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), false);
});

Deno.test("oom annotator: successive OOMs each attributed once", async () => {
  // baseline 0, then 1, 1, 2 across three 137 exits: true, false, true.
  const reader = new FakeCgroupReader([0, 1, 1, 2]);
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), true); // 0 -> 1
  assertEquals(await annotate(kill137), false); // 1 -> 1 (explicit kill)
  assertEquals(await annotate(kill137), true); // 1 -> 2
});

Deno.test("oom annotator: non-137 exit returns false without a read", async () => {
  const reader = new FakeCgroupReader([0]);
  const annotate = createCgroupOomAnnotator(reader);
  // Non-137 short-circuits synchronously to the boolean `false`.
  const result = annotate({ pid: 7, code: 0, signal: null });
  assertEquals(result, false);
  const signaledButNot137 = annotate({ pid: 7, code: 143, signal: "SIGTERM" });
  assertEquals(signaledButNot137, false);
  // Let the construction baseline settle, then assert no post-death read
  // was ever performed for the non-137 consultations (only the baseline).
  await Promise.resolve();
  assertEquals(reader.readCalls, 1);
});

Deno.test("oom annotator: readMemoryEvents throws -> false (fail-safe)", async () => {
  const reader = new FakeCgroupReader([
    new Error("baseline read failed"),
    new Error("post-death read failed"),
  ]);
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), false);
});

Deno.test("oom annotator: path resolve rejects (non-cgroup-v2) -> false", async () => {
  const reader = new FakeCgroupReader(
    [0, 1],
    new Error("no /proc/self/cgroup"),
  );
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), false);
});

Deno.test("oom annotator: baseline ok but post-death read fails -> false", async () => {
  const reader = new FakeCgroupReader([0, new Error("EIO on memory.events")]);
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), false);
});

Deno.test("oom annotator: recovers after a transient read failure", async () => {
  // baseline 0, first 137 read fails (false, no advance), second read 1
  // increments over the still-0 baseline (true).
  const reader = new FakeCgroupReader([0, new Error("transient"), 1]);
  const annotate = createCgroupOomAnnotator(reader);
  assertEquals(await annotate(kill137), false);
  assertEquals(await annotate(kill137), true);
});

Deno.test("oom annotator: default reader is used when none injected", () => {
  // No throw at construction on a non-cgroupfs host: the baseline read is
  // fired-and-caught, so the factory returns a usable annotator.
  const annotate = createCgroupOomAnnotator();
  assertEquals(typeof annotate, "function");
});

// ---------------------------------------------------------------------------
// Parse helpers (the real reader's parsing path, host-safe)
// ---------------------------------------------------------------------------

Deno.test("parseMemoryEventsOomKill: extracts the oom_kill counter", () => {
  const body = [
    "low 0",
    "high 0",
    "max 0",
    "oom 5",
    "oom_kill 3",
    "oom_group_kill 1",
    "",
  ].join("\n");
  assertEquals(parseMemoryEventsOomKill(body), 3);
});

Deno.test("parseMemoryEventsOomKill: missing/blank oom_kill -> 0", () => {
  assertEquals(parseMemoryEventsOomKill("low 0\noom 2\n"), 0);
  assertEquals(parseMemoryEventsOomKill(""), 0);
  // `oom` must not be mistaken for `oom_kill`.
  assertEquals(parseMemoryEventsOomKill("oom 9\n"), 0);
  // Tab-separated is tolerated.
  assertEquals(parseMemoryEventsOomKill("oom_kill\t7\n"), 7);
});

Deno.test("parseSelfCgroupMemoryEventsPath: unified line -> events path", () => {
  assertEquals(
    parseSelfCgroupMemoryEventsPath("0::/studiobox/app\n"),
    "/sys/fs/cgroup/studiobox/app/memory.events",
  );
  // Root cgroup.
  assertEquals(
    parseSelfCgroupMemoryEventsPath("0::/\n"),
    "/sys/fs/cgroup/memory.events",
  );
  // Trailing slash is trimmed.
  assertEquals(
    parseSelfCgroupMemoryEventsPath("0::/scope/\n"),
    "/sys/fs/cgroup/scope/memory.events",
  );
});

Deno.test("parseSelfCgroupMemoryEventsPath: no v2 line throws", () => {
  // A cgroup-v1-only / hybrid body has no `0::` unified line.
  const v1 = "3:memory:/some/scope\n2:cpu,cpuacct:/some/scope\n";
  const err = assertThrows(
    () => parseSelfCgroupMemoryEventsPath(v1),
    AgentError,
    "cgroup v2",
  );
  assertEquals(err.code, "SBX_AGENT_STATE");
});

// ---------------------------------------------------------------------------
// Spawner gating: the annotator is only consulted on the 137 path.
// Needs --allow-run (+ --allow-read); skipped under the strict test:unit
// permission set so `deno task test:unit` stays green.
// ---------------------------------------------------------------------------

const canSpawn =
  Deno.permissions.querySync({ name: "run" }).state === "granted";

Deno.test({
  name: "spawner consults the oom annotator only for a 137 exit",
  ignore: !canSpawn,
  fn: async () => {
    const calls: Array<{ code: number; signal: AgentKillSignal | null }> = [];
    const spy: AgentOomAnnotator = (exit) => {
      calls.push({ code: exit.code, signal: exit.signal });
      return false;
    };
    const processes = new AgentProcesses({
      config: { root: "/", home: Deno.cwd() },
      oomAnnotator: spy,
    });

    // A clean exit (code 0): the annotator must NOT be consulted.
    const ok = await processes.spawn({
      command: Deno.execPath(),
      args: ["eval", "Deno.exit(0)"],
      stdout: "null",
      stderr: "null",
    });
    const okStatus = await ok.status;
    assertEquals(okStatus.code, 0);
    assertEquals(okStatus.oom, false);
    assertEquals(calls.length, 0);

    // A SIGKILL (code 137): the annotator is consulted exactly once, with
    // the 137 exit; the spy returns false so oom stays false.
    const blocked = await processes.spawn({
      command: Deno.execPath(),
      args: ["eval", "await new Promise(() => {})"],
      stdout: "null",
      stderr: "null",
    });
    await blocked.kill("SIGKILL");
    const killedStatus = await blocked.status;
    assertEquals(killedStatus.code, 137);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].code, 137);
    assertEquals(killedStatus.oom, false);

    await processes.shutdown();
    assert(true);
  },
});
