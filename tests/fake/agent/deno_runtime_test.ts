import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { AgentError } from "../../../src/agent/api.ts";
import { collectOutput } from "../../../src/agent/processes.ts";
import { makeTestAgent } from "./agent_test_helpers.ts";

Deno.test("repl preserves state across eval calls (x, then y, then x+y)", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    assertEquals(await repl.eval("let x = 2"), undefined);
    assertEquals(await repl.eval("let y = 3"), undefined);
    assertEquals(await repl.eval("x + y"), 5);
    // var and function declarations persist too.
    await repl.eval("function twice(n) { return n * 2 }");
    assertEquals(await repl.eval("twice(x + y)"), 10);
  } finally {
    await repl.close();
  }
});

Deno.test("Map, Set, and Date are preserved across the eval boundary", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    const map = await repl.eval<Map<string, number>>(
      'new Map([["a", 1], ["b", 2]])',
    );
    assertInstanceOf(map, Map);
    assertEquals(map.get("b"), 2);

    const set = await repl.eval<Set<number>>("new Set([1, 2, 3])");
    assertInstanceOf(set, Set);
    assertEquals([...set], [1, 2, 3]);

    const date = await repl.eval<Date>('new Date("2026-07-11T00:00:00Z")');
    assertInstanceOf(date, Date);
    assertEquals(date.toISOString(), "2026-07-11T00:00:00.000Z");
  } finally {
    await repl.close();
  }
});

Deno.test("class instances arrive as plain objects; promises are awaited", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    const plain = await repl.eval(
      "class Point { constructor(x, y) { this.x = x; this.y = y } }\n" +
        "new Point(3, 4)",
    );
    assertEquals(plain, { x: 3, y: 4 });

    assertEquals(await repl.eval("Promise.resolve(7)"), 7);
  } finally {
    await repl.close();
  }
});

Deno.test("repl.call: by defined name, inline source, structured args", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    await repl.eval("function add(a, b) { return a + b }");
    assertEquals(await repl.call("add", 2, 3), 5);
    assertEquals(await repl.call("(a, b) => a * b", 4, 5), 20);
    assertEquals(
      await repl.call("function (s) { return s.size }", new Set(["x", "y"])),
      2,
    );
    const echoed = await repl.call<Map<string, number>>(
      "(m) => (m.set('added', 1), m)",
      new Map([["orig", 0]]),
    );
    assertInstanceOf(echoed, Map);
    assertEquals(echoed.get("added"), 1);

    await assertRejects(
      () => repl.call("noSuchFunction", 1),
      Error,
      "noSuchFunction",
    );
  } finally {
    await repl.close();
  }
});

Deno.test("errors thrown by evaluated code re-throw with the guest message", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    const err = await assertRejects(
      () => repl.eval('throw new RangeError("boom in guest")'),
      Error,
      "boom in guest",
    );
    assertFalse(err instanceof AgentError, "guest errors are plain Errors");
    assertEquals(err.name, "RangeError");
  } finally {
    await repl.close();
  }
});

Deno.test("unserializable results and arguments are SBX_AGENT_EVAL", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    const result = await assertRejects(
      () => repl.eval("() => 1"),
      AgentError,
    );
    assertEquals(result.code, "SBX_AGENT_EVAL");

    const arg = await assertRejects(
      () => repl.call("(f) => f()", () => 1),
      AgentError,
    );
    assertEquals(arg.code, "SBX_AGENT_EVAL");

    // The session survives a serialization failure.
    assertEquals(await repl.eval("40 + 2"), 42);
  } finally {
    await repl.close();
  }
});

Deno.test("deno.eval is an ephemeral repl: no state survives between calls", async () => {
  await using agent = await makeTestAgent();
  assertEquals(await agent.deno.eval("globalThis.__leak = 5"), 5);
  assertEquals(await agent.deno.eval("typeof globalThis.__leak"), "undefined");
});

Deno.test("repl options: scriptArgs surface as Deno.args, env layers over agent env", async () => {
  await using agent = await makeTestAgent({ seedEnv: { FOO: "base" } });
  const repl = await agent.deno.openRepl({
    scriptArgs: ["alpha", "beta"],
    env: { FOO: "over" },
  });
  try {
    assertEquals(await repl.eval("Deno.args"), ["alpha", "beta"]);
    assertEquals(await repl.eval('Deno.env.get("FOO")'), "over");
  } finally {
    await repl.close();
  }
});

Deno.test("repl close semantics: pending evals reject, close is idempotent", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();

  const pending = repl.eval("new Promise(() => {})");
  const rejection = assertRejects(() => pending, AgentError);
  await repl.close();
  const err = await rejection;
  assertEquals(err.code, "SBX_AGENT_CLOSED");

  await repl.close(); // idempotent

  const late = await assertRejects(() => repl.eval("1"), AgentError);
  assertEquals(late.code, "SBX_AGENT_CLOSED");
  const lateCall = await assertRejects(() => repl.call("add", 1), AgentError);
  assertEquals(lateCall.code, "SBX_AGENT_CLOSED");
});

Deno.test("console output of evaluated code cannot corrupt results", async () => {
  await using agent = await makeTestAgent();
  const repl = await agent.deno.openRepl();
  try {
    assertEquals(
      await repl.eval('console.log("noise", { a: 1 }); "signal"'),
      "signal",
    );
  } finally {
    await repl.close();
  }
});

Deno.test("run with inline code: scriptArgs surface as Deno.args", async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.deno.run({
    code: "console.log(JSON.stringify(Deno.args));",
    scriptArgs: ["a", "b c"],
  });
  const output = await collectOutput(proc);
  assertEquals(output.status.code, 0, output.stderrText ?? "");
  assertEquals(output.stdoutText, '["a","b c"]\n');
});

Deno.test("run with an entrypoint resolves in-sandbox paths", async () => {
  await using agent = await makeTestAgent();
  await Deno.writeTextFile(
    `${agent.root}/home/app/main.ts`,
    'console.log("hi from", Deno.args[0] ?? "entrypoint");',
  );
  // Relative entrypoints resolve against the effective cwd (/home/app).
  const relative = await collectOutput(
    await agent.deno.run({ entrypoint: "main.ts" }),
  );
  assertEquals(relative.status.code, 0, relative.stderrText ?? "");
  assertEquals(relative.stdoutText, "hi from entrypoint\n");

  const absolute = await collectOutput(
    await agent.deno.run({
      entrypoint: "/home/app/main.ts",
      scriptArgs: ["sandbox"],
    }),
  );
  assertEquals(absolute.stdoutText, "hi from sandbox\n");
});

Deno.test("run cleans up materialized inline code after exit", async () => {
  await using agent = await makeTestAgent();
  const proc = await agent.deno.run({ code: "console.log(1);" });
  const output = await collectOutput(proc);
  assertEquals(output.status.code, 0);
  // Cleanup is a status continuation; give it a beat.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const leftovers: string[] = [];
  for await (const entry of Deno.readDir(`${agent.root}/tmp`)) {
    if (entry.name.startsWith("sbx-deno-run-")) leftovers.push(entry.name);
  }
  assertEquals(leftovers, []);
});

Deno.test("run respects spawn options: cwd and env", async () => {
  await using agent = await makeTestAgent({ seedEnv: { FOO: "base" } });
  await Deno.mkdir(`${agent.root}/work`);
  const output = await collectOutput(
    await agent.deno.run({
      code: "console.log(Deno.cwd(), Deno.env.get('FOO'));",
      cwd: "/work",
      env: { FOO: "over" },
    }),
  );
  assertEquals(output.status.code, 0, output.stderrText ?? "");
  assertEquals(output.stdoutText, `${agent.realRoot}/work over\n`);
});

Deno.test("a repl spawn goes through the process registry and is reaped on close", async () => {
  await using agent = await makeTestAgent();
  const before = agent.processes.live.length;
  const repl = await agent.deno.openRepl();
  assertEquals(agent.processes.live.length, before + 1);
  await repl.close();
  assertEquals(agent.processes.live.length, before);
  assert(true);
});
