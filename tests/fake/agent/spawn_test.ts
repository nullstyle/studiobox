import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { AgentError } from "../../../src/agent/api.ts";
import { collectOutput } from "../../../src/agent/processes.ts";
import { bytes, makeTestAgent } from "./agent_test_helpers.ts";

Deno.test("echo round-trip: piped stdout, terminal status", async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.processes.spawn({
    command: "/bin/echo",
    args: ["hello", "agent"],
  });
  assert(proc.pid > 0);
  assert(proc.stdout !== null, "stdout defaults to piped");
  assert(proc.stderr !== null, "stderr defaults to piped");
  const output = await collectOutput(proc);
  assertEquals(output.stdoutText, "hello agent\n");
  assertEquals(output.stderrText, "");
  assertEquals(output.status, {
    code: 0,
    signal: null,
    signaled: false,
    oom: false,
  });
});

Deno.test("stdin: write with backpressure, close for EOF", async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.processes.spawn({
    command: "/bin/cat",
    stdin: "piped",
    stderr: "null",
  });
  await proc.writeStdin(bytes("line one\n"));
  await proc.writeStdin(bytes("line two"));
  await proc.closeStdin();
  await proc.closeStdin(); // idempotent
  const output = await collectOutput(proc);
  assertEquals(output.stdoutText, "line one\nline two");
  assertEquals(output.stderr, null);
  assertEquals(output.status.code, 0);
});

Deno.test('writeStdin on default ("null") stdin is SBX_AGENT_STATE', async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.processes.spawn({
    command: "/bin/cat",
    stdout: "null",
    stderr: "null",
  });
  const err = await assertRejects(
    () => proc.writeStdin(bytes("nope")),
    AgentError,
  );
  assertEquals(err.code, "SBX_AGENT_STATE");
  await proc.closeStdin(); // no-op for "null" stdin
  assertEquals((await proc.status).code, 0);
});

Deno.test("writeStdin after closeStdin is SBX_AGENT_CLOSED", async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.processes.spawn({
    command: "/bin/cat",
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  });
  await proc.writeStdin(bytes("x"));
  await proc.closeStdin();
  const err = await assertRejects(
    () => proc.writeStdin(bytes("late")),
    AgentError,
  );
  assertEquals(err.code, "SBX_AGENT_CLOSED");
  await proc.status;
});

Deno.test("kill maps to 128+n statuses (SIGTERM 143, SIGKILL 137)", async () => {
  await using agent = await makeTestAgent();

  const term = await agent.processes.spawn({
    command: "/bin/sleep",
    args: ["30"],
    stdout: "null",
    stderr: "null",
  });
  await term.kill(); // default SIGTERM
  assertEquals(await term.status, {
    code: 143,
    signal: "SIGTERM",
    signaled: true,
    oom: false,
  });
  await term.kill("SIGKILL"); // signaling an exited process is a no-op

  const kill = await agent.processes.spawn({
    command: "/bin/sleep",
    args: ["30"],
    stdout: "null",
    stderr: "null",
  });
  await kill.kill("SIGKILL");
  assertEquals(await kill.status, {
    code: 137,
    signal: "SIGKILL",
    signaled: true,
    oom: false,
  });
});

Deno.test("oom annotation seam: consulted only for exit 137", async () => {
  const consulted: number[] = [];
  await using agent = await makeTestAgent({
    oomAnnotator(exit) {
      consulted.push(exit.code);
      return exit.code === 137;
    },
  });

  const killed = await agent.processes.spawn({
    command: "/bin/sleep",
    args: ["30"],
    stdout: "null",
    stderr: "null",
  });
  await killed.kill("SIGKILL");
  const killedStatus = await killed.status;
  assertEquals(killedStatus.oom, true);
  assertEquals(killedStatus.code, 137);

  const clean = await agent.processes.spawn({
    command: "/bin/echo",
    stdout: "null",
    stderr: "null",
  });
  assertEquals((await clean.status).oom, false);
  assertEquals(consulted, [137], "annotator runs only for exit code 137");
});

Deno.test("output() buffering with lazy text over a real process", async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.processes.spawn({
    command: "/bin/sh",
    args: ["-c", "printf out-bytes; printf err-bytes 1>&2; exit 3"],
  });
  const output = await collectOutput(proc);
  assertEquals(output.stdout, bytes("out-bytes"));
  assertEquals(output.stderr, bytes("err-bytes"));
  assertEquals(output.stdoutText, "out-bytes");
  assertEquals(output.stdoutText, "out-bytes"); // cached second access
  assertEquals(output.stderrText, "err-bytes");
  assertEquals(output.status.code, 3);
  assertFalse(output.status.signaled);
});

Deno.test("cwd defaults to /home/app and resolves under the sandbox root", async () => {
  await using agent = await makeTestAgent();
  const home = await collectOutput(
    await agent.processes.spawn({
      command: "/bin/sh",
      args: ["-c", "pwd"],
      stderr: "null",
    }),
  );
  assertEquals(home.stdoutText, `${agent.realRoot}/home/app\n`);

  await Deno.mkdir(`${agent.root}/work`);
  const work = await collectOutput(
    await agent.processes.spawn({
      command: "/bin/sh",
      args: ["-c", "pwd"],
      cwd: "/work",
      stderr: "null",
    }),
  );
  assertEquals(work.stdoutText, `${agent.realRoot}/work\n`);
});

Deno.test("cwd escaping the root via symlink refuses to spawn", async () => {
  await using agent = await makeTestAgent();
  const outside = await Deno.makeTempDir({ prefix: "sbx-outside-" });
  try {
    await Deno.symlink(outside, `${agent.root}/escape`);
    const err = await assertRejects(
      () =>
        agent.processes.spawn({
          command: "/bin/sh",
          args: ["-c", "pwd"],
          cwd: "/escape",
        }),
      AgentError,
    );
    assertEquals(err.code, "SBX_AGENT_PATH_ESCAPE");
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("agent env layers under per-spawn env; clearEnv drops both host and agent layers", async () => {
  await using agent = await makeTestAgent({
    seedEnv: { FOO: "base", KEEP: "kept" },
  });

  const layered = await collectOutput(
    await agent.processes.spawn({
      command: "/bin/sh",
      args: ["-c", 'echo "$FOO/$KEEP/$NEW"'],
      env: { FOO: "over", NEW: "new" },
      stderr: "null",
    }),
  );
  assertEquals(layered.stdoutText, "over/kept/new\n");

  // NOTE: $PATH is not probed here — /bin/sh sets its own default PATH
  // when the environment does not carry one.
  const cleared = await collectOutput(
    await agent.processes.spawn({
      command: "/bin/sh",
      args: ["-c", 'echo "only=$ONLY keep=$KEEP foo=$FOO home=$HOME"'],
      clearEnv: true,
      env: { ONLY: "x" },
      stderr: "null",
    }),
  );
  assertEquals(cleared.stdoutText, "only=x keep= foo= home=\n");
});

Deno.test("the host process environment never leaks into spawns", async () => {
  await using agent = await makeTestAgent();
  // PATH/HOME are seeded; everything else from the test-runner env must
  // be invisible. Count the environment: exactly the seeded vars + PWD?
  const output = await collectOutput(
    await agent.processes.spawn({
      command: "/bin/sh",
      args: ["-c", "env | sort"],
      stderr: "null",
    }),
  );
  const names = (output.stdoutText ?? "")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")))
    // The shell itself defines PWD/SHLVL/_ and friends; ignore them.
    .filter((name) => !["PWD", "OLDPWD", "SHLVL", "_"].includes(name));
  assertEquals(names.sort(), ["HOME", "PATH"]);
});

Deno.test("spawn surfaces OS errors unchanged (missing command)", async () => {
  await using agent = await makeTestAgent();
  await assertRejects(
    () => agent.processes.spawn({ command: "/no/such/binary" }),
    Deno.errors.NotFound,
  );
});

Deno.test("registry: concurrent spawns, auto-unregister on exit, release semantics", async () => {
  await using agent = await makeTestAgent();
  assertEquals(agent.processes.live.length, 0);

  const a = await agent.processes.spawn({
    command: "/bin/sleep",
    args: ["30"],
    stdout: "null",
    stderr: "null",
  });
  const b = await agent.processes.spawn({
    command: "/bin/sleep",
    args: ["30"],
    stdout: "null",
    stderr: "null",
  });
  assertEquals(agent.processes.live.length, 2);

  // Exit auto-unregisters.
  const quick = await agent.processes.spawn({
    command: "/bin/echo",
    stdout: "null",
    stderr: "null",
  });
  assertEquals(agent.processes.live.length, 3);
  await quick.status;
  assertEquals(agent.processes.live.length, 2);

  // Release drops the registry entry without killing; the retained
  // handle stays usable.
  assert(agent.processes.release(a));
  assertFalse(agent.processes.release(a), "second release is a no-op");
  assertEquals(agent.processes.live.length, 1);
  await a.kill("SIGKILL");
  assertEquals((await a.status).code, 137);

  // Release relinquishes unconsumed piped stdio.
  const piped = await agent.processes.spawn({
    command: "/bin/sleep",
    args: ["30"],
    stdin: "piped",
  });
  assert(agent.processes.release(piped));
  await piped.kill("SIGKILL");
  await piped.status;

  // Shutdown reaps whatever is still registered.
  await agent.processes.shutdown();
  assertEquals(agent.processes.live.length, 0);
  assertEquals((await b.status).code, 137);
});
