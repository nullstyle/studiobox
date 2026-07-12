import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type AgentDenoRunSpec,
  AgentError,
  type AgentProcessSpawner,
  type AgentSpawnSpec,
} from "../../../src/agent/api.ts";
import { validateSpawnSpec } from "../../../src/agent/processes.ts";
import { AgentDeno } from "../../../src/agent/deno_runtime.ts";

function expectValidation(spec: unknown, substring: string) {
  const err = assertThrows(
    () => validateSpawnSpec(spec as AgentSpawnSpec),
    AgentError,
    substring,
  );
  assertEquals(err.code, "SBX_AGENT_VALIDATION");
}

Deno.test("spawn spec structural validation", () => {
  expectValidation(null, "object");
  expectValidation({}, "command");
  expectValidation({ command: "" }, "command");
  expectValidation({ command: "x", args: "nope" }, "array");
  expectValidation({ command: "x", args: [1] }, "strings");
  expectValidation({ command: "x", cwd: 5 }, "cwd");
  expectValidation({ command: "x", env: { "BAD=": "v" } }, "must not contain");
  expectValidation({ command: "x", env: { OK: 3 } }, "string");
  expectValidation({ command: "x", clearEnv: "yes" }, "boolean");
  expectValidation({ command: "x", stdin: "inherit" }, "stdin");
  expectValidation({ command: "x", stdout: "discard" }, "stdout");
  expectValidation({ command: "x", stderr: 0 }, "stderr");

  // A well-formed spec passes.
  validateSpawnSpec({
    command: "echo",
    args: ["hi"],
    cwd: "/work",
    env: { FOO: "bar" },
    clearEnv: false,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  });
});

const NEVER_SPAWN: AgentProcessSpawner = {
  spawn() {
    return Promise.reject(new Error("spawner must not be reached"));
  },
};

Deno.test("run spec validation rejects before anything spawns", async () => {
  const deno = new AgentDeno({
    config: { root: "/sbx-root" },
    spawner: NEVER_SPAWN,
  });
  const cases: [unknown, string][] = [
    [{}, "exactly one"],
    [{ entrypoint: "/a.ts", code: "1" }, "exactly one"],
    [{ entrypoint: 7 }, "entrypoint"],
    [{ code: 7 }, "code"],
    [{ code: "1", extension: "exe" }, "extension"],
    [{ code: "1", watch: true }, "watch"],
  ];
  for (const [spec, substring] of cases) {
    const err = await assertRejects(
      () => deno.run(spec as AgentDenoRunSpec),
      AgentError,
      substring,
    );
    assertEquals(err.code, "SBX_AGENT_VALIDATION");
  }
});
