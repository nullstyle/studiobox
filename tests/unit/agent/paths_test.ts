import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AgentError, type AgentRootConfig } from "../../../src/agent/api.ts";
import {
  normalizeSandboxPath,
  resolveSandboxPath,
  sandboxCwd,
  sandboxHome,
} from "../../../src/agent/processes.ts";

const CONFIG: AgentRootConfig = { root: "/sbx-root" };

Deno.test("defaults: home /home/app, cwd defaults to home", () => {
  assertEquals(sandboxHome(CONFIG), "/home/app");
  assertEquals(sandboxCwd(CONFIG), "/home/app");
  assertEquals(sandboxCwd({ root: "/r", home: "/h" }), "/h");
  assertEquals(sandboxCwd({ root: "/r", home: "/h", cwd: "/w" }), "/w");
});

Deno.test("relative paths resolve against the effective in-sandbox cwd", () => {
  assertEquals(normalizeSandboxPath(CONFIG, "x/y"), "/home/app/x/y");
  assertEquals(
    normalizeSandboxPath({ root: "/r", cwd: "/work" }, "a"),
    "/work/a",
  );
  assertEquals(normalizeSandboxPath(CONFIG, "."), "/home/app");
});

Deno.test("absolute in-sandbox paths are rooted at the sandbox, not the host", () => {
  assertEquals(normalizeSandboxPath(CONFIG, "/etc/passwd"), "/etc/passwd");
});

Deno.test("dot segments fold and .. clamps at the sandbox root", () => {
  assertEquals(normalizeSandboxPath(CONFIG, "a/./b/../c"), "/home/app/a/c");
  assertEquals(normalizeSandboxPath(CONFIG, "../../.."), "/");
  assertEquals(
    normalizeSandboxPath(CONFIG, "../../../../etc/passwd"),
    "/etc/passwd",
  );
  assertEquals(normalizeSandboxPath(CONFIG, "/.."), "/");
});

Deno.test("malformed paths and configs are validation errors", () => {
  assertThrows(
    () => normalizeSandboxPath(CONFIG, ""),
    AgentError,
    "non-empty",
  );
  assertThrows(() => normalizeSandboxPath(CONFIG, "a\0b"), AgentError, "NUL");
  assertThrows(
    () => normalizeSandboxPath({ root: "/r", cwd: "relative" }, "a"),
    AgentError,
    "absolute",
  );
  assertThrows(
    () => sandboxHome({ root: "/r", home: "nope" }),
    AgentError,
    "absolute",
  );
});

Deno.test("resolveSandboxPath maps under the root and keeps missing suffixes lexical", async () => {
  const root = await Deno.makeTempDir({ prefix: "sbx-paths-" });
  try {
    await Deno.mkdir(`${root}/home/app`, { recursive: true });
    const realRoot = await Deno.realPath(root);

    const existing = await resolveSandboxPath({ root }, "/home/app");
    assertEquals(existing.sandboxPath, "/home/app");
    assertEquals(existing.hostPath, `${root}/home/app`);
    assertEquals(existing.realHostPath, `${realRoot}/home/app`);

    const missing = await resolveSandboxPath({ root }, "no/such/file.txt");
    assertEquals(missing.sandboxPath, "/home/app/no/such/file.txt");
    assertEquals(
      missing.realHostPath,
      `${realRoot}/home/app/no/such/file.txt`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a symlink resolving outside the root throws SBX_AGENT_PATH_ESCAPE", async () => {
  const root = await Deno.makeTempDir({ prefix: "sbx-paths-" });
  const outside = await Deno.makeTempDir({ prefix: "sbx-outside-" });
  try {
    await Deno.symlink(outside, `${root}/escape`);
    const err = await assertRejects(
      () => resolveSandboxPath({ root }, "/escape/file"),
      AgentError,
      "outside the sandbox root",
    );
    assertEquals(err.code, "SBX_AGENT_PATH_ESCAPE");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("an in-root symlink is followed and allowed", async () => {
  const root = await Deno.makeTempDir({ prefix: "sbx-paths-" });
  try {
    await Deno.mkdir(`${root}/real/dir`, { recursive: true });
    await Deno.symlink(`${root}/real`, `${root}/link`);
    const realRoot = await Deno.realPath(root);
    const resolved = await resolveSandboxPath({ root }, "/link/dir");
    assertEquals(resolved.realHostPath, `${realRoot}/real/dir`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('root "/" makes containment vacuous (the real guest)', async () => {
  const resolved = await resolveSandboxPath(
    { root: "/", home: "/home/app" },
    "/definitely/not/here",
  );
  assertEquals(resolved.sandboxPath, "/definitely/not/here");
  assertEquals(resolved.hostPath, "/definitely/not/here");
  assertEquals(resolved.realHostPath, "/definitely/not/here");
});

Deno.test('root "/" resolves an EXISTING absolute path (M5 regression)', async () => {
  // The chroot/pivot_root guest runs studioboxd with root="/". The prior
  // containment prefix was `realRoot + "/"` = "//", so an existing path
  // resolved to `realpath !== "/"` and was wrongly rejected — the M5 cycle
  // caught it. A non-existent path (above) dodged the bug because its
  // deepest existing ancestor is "/" itself (real === realRoot).
  const dir = await Deno.makeTempDir({ prefix: "sbx-root-slash-" });
  try {
    const resolved = await resolveSandboxPath(
      { root: "/", home: "/home/app" },
      dir,
    );
    // root "/" is the identity map: no containment stripping, path preserved
    // (modulo the OS realpath of any symlinked temp root).
    assertEquals(resolved.sandboxPath, dir);
    assertEquals(resolved.realHostPath, await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir);
  }
});
