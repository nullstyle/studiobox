/**
 * Host-level lifecycle invariants for {@linkcode FakeSandboxHost} that the
 * parity suite (per-fixture create/close) does not exercise: a failure
 * while applying `SandboxOptions.env` must leave NO partial sandbox
 * observable via `list()`/`connect()` and must not leak the per-sandbox
 * temp root.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import { FakeSandboxHost } from "../../testing/mod.ts";
import { AgentError } from "../../src/agent/api.ts";
import { UnsupportedFeatureError } from "../../src/api/errors.ts";

/** Count temp dirs the fake host provisions, by its fixed prefix. */
async function countFakeRoots(): Promise<number> {
  const tmp = await Deno.makeTempDir({ prefix: "sbx-probe-" });
  await Deno.remove(tmp, { recursive: true });
  const parent = tmp.slice(0, tmp.lastIndexOf("/"));
  let count = 0;
  for await (const entry of Deno.readDir(parent)) {
    if (entry.isDirectory && entry.name.startsWith("sbx-fake-")) count++;
  }
  return count;
}

Deno.test(
  "FakeSandboxHost.create: a failing options.env leaves no partial sandbox",
  async () => {
    const host = new FakeSandboxHost();
    const before = await countFakeRoots();

    // "BAD=NAME" contains "=", which validateEnvName rejects while
    // env.set applies it post-provisioning.
    const error = await assertRejects(
      () => host.create({ env: { "BAD=NAME": "x" } }),
      AgentError,
    );
    assertEquals(error.code, "SBX_AGENT_VALIDATION");

    // No partial sandbox is observable, and the temp root did not leak.
    assertEquals(await host.list(), []);
    assertEquals(
      await countFakeRoots(),
      before,
      "the failed create must not leak a temp root",
    );
  },
);

Deno.test(
  "FakeSandboxHost.create: an invalid host-level env leaves no leaked root",
  async () => {
    // Host-level env (constructor) is validated during provisioning, after
    // the temp root exists — a failure there must tear the root down too,
    // not just the per-create options.env path.
    const host = new FakeSandboxHost({ env: { "HOST=BAD": "v" } });
    const before = await countFakeRoots();

    const error = await assertRejects(() => host.create(), AgentError);
    assertEquals(error.code, "SBX_AGENT_VALIDATION");

    assertEquals(await host.list(), []);
    assertEquals(
      await countFakeRoots(),
      before,
      "an invalid host-level env must not leak a temp root",
    );
  },
);

Deno.test(
  "FakeSandboxHost.create: a successful options.env is applied and listed",
  async () => {
    await using host = new FakeSandboxHost();
    await using sandbox = await host.create({ env: { GREETING: "hi" } });
    assertEquals(await sandbox.env.get("GREETING"), "hi");
    const listed = await host.list();
    assertEquals(listed.length, 1);
    assert(
      listed.some((meta) => meta.id === sandbox.id),
      "the created sandbox is observable via list()",
    );
  },
);

Deno.test(
  "FakeSandbox.exposeHttp: returns a plausible loopback URL and leases distinct ports",
  async () => {
    await using host = new FakeSandboxHost();
    await using sandbox = await host.create();

    const first = await sandbox.exposeHttp({ port: 8080 });
    const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(first);
    assert(match !== null, `unexpected exposeHttp url: ${first}`);
    const firstPort = Number(match[1]);
    // The fake leases from the same reserved 40100..40199 range as the real host.
    assert(
      firstPort >= 40_100 && firstPort <= 40_199,
      `host port ${firstPort} in reserved range`,
    );

    // A second exposeHttp resolves a DISTINCT url.
    const second = await sandbox.exposeHttp({ port: 9090 });
    assert(second !== first, "the second exposeHttp url is distinct");
  },
);

Deno.test(
  "FakeSandbox.exposeHttp: by pid is unsupported",
  async () => {
    await using host = new FakeSandboxHost();
    await using sandbox = await host.create();
    await assertRejects(
      () => sandbox.exposeHttp({ pid: 4321 }),
      UnsupportedFeatureError,
    );
  },
);
