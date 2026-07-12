import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AgentError } from "../../../src/agent/api.ts";
import {
  AgentEnv,
  DEFAULT_GUEST_PATH,
  guestBaseEnvironment,
  layerSpawnEnv,
  validateEnvName,
  validateEnvValue,
} from "../../../src/agent/env.ts";

Deno.test("guestBaseEnvironment: default PATH + HOME sit UNDER the boot env", () => {
  // A bare init env (overlay-init execs studioboxd with no PATH/HOME) still
  // yields a usable PATH so bare-name spawns resolve, and HOME = sandbox home.
  const base = guestBaseEnvironment("/home/app", {});
  assertEquals(base.PATH, DEFAULT_GUEST_PATH);
  assertEquals(base.HOME, "/home/app");
  assert(base.PATH.includes("/usr/bin") && base.PATH.includes("/bin"));

  // A boot-provided PATH WINS; HOME is FORCED to the sandbox home over the
  // init's `HOME=/` so `$HOME/.bashrc` and `~` resolve inside the sandbox.
  const overridden = guestBaseEnvironment("/home/app", {
    PATH: "/custom/bin",
    HOME: "/",
    EXTRA: "1",
  });
  assertEquals(overridden.PATH, "/custom/bin");
  assertEquals(overridden.HOME, "/home/app");
  assertEquals(overridden.EXTRA, "1");
});

Deno.test("get/set/delete/toObject round-trip", async () => {
  const env = new AgentEnv({ SEEDED: "yes" });
  assertEquals(await env.get("SEEDED"), "yes");
  assertEquals(await env.get("MISSING"), undefined);

  await env.set("FOO", "bar");
  assertEquals(await env.get("FOO"), "bar");
  await env.set("FOO", "baz");
  assertEquals(await env.get("FOO"), "baz");

  assertEquals(await env.toObject(), { SEEDED: "yes", FOO: "baz" });

  await env.delete("FOO");
  assertEquals(await env.get("FOO"), undefined);
  await env.delete("FOO"); // deleting an unset key is a no-op
  assertEquals(await env.toObject(), { SEEDED: "yes" });
});

Deno.test("snapshot and toObject are copies, not views", async () => {
  const env = new AgentEnv({ A: "1" });
  const snap = env.snapshot();
  snap.A = "mutated";
  snap.B = "injected";
  assertEquals(await env.get("A"), "1");
  assertEquals(await env.get("B"), undefined);
  const obj = await env.toObject();
  obj.A = "mutated";
  assertEquals(await env.get("A"), "1");
});

Deno.test("structural validation of names and values", async () => {
  const env = new AgentEnv();
  await assertRejects(() => env.set("", "x"), AgentError, "non-empty");
  await assertRejects(
    () => env.set("A=B", "x"),
    AgentError,
    "must not contain",
  );
  await assertRejects(
    () => env.set("A\0", "x"),
    AgentError,
    "must not contain",
  );
  await assertRejects(() => env.set("A", "x\0y"), AgentError, "NUL");
  await assertRejects(() => env.get(""), AgentError, "non-empty");
  assertThrows(() => validateEnvName("BAD=NAME"), AgentError);
  assertThrows(() => validateEnvValue("bad\0value"), AgentError);
  assertThrows(() => new AgentEnv({ "BAD=": "x" }), AgentError);
});

Deno.test("layerSpawnEnv: per-spawn env wins over the agent base", () => {
  const base = { FOO: "base", KEEP: "kept" };
  const merged = layerSpawnEnv(base, { env: { FOO: "over", NEW: "new" } });
  assertEquals(merged, { FOO: "over", KEEP: "kept", NEW: "new" });
  // Pure: inputs untouched.
  assertEquals(base, { FOO: "base", KEEP: "kept" });
});

Deno.test("layerSpawnEnv: clearEnv drops the inherited agent env", () => {
  const base = { FOO: "base", KEEP: "kept" };
  assertEquals(layerSpawnEnv(base, { clearEnv: true, env: { ONLY: "x" } }), {
    ONLY: "x",
  });
  assertEquals(layerSpawnEnv(base, { clearEnv: true }), {});
  assertEquals(layerSpawnEnv(base, {}), base);
});
