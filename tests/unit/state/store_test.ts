import { assertEquals, assertRejects } from "@std/assert";
import {
  JsonFileSandboxStore,
  StateConflictError,
  StateCorruptError,
} from "../../../src/state/store.ts";
import { newSandboxRecord } from "../../../src/state/model.ts";

Deno.test("sandbox state is create-only and compare-and-swap", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = new JsonFileSandboxStore(`${directory}/state.json`);
    const original = newSandboxRecord({
      id: "sbx-1",
      createdAt: "2026-07-10T00:00:00.000Z",
    });

    await store.create(original);
    await assertRejects(
      () => store.create(original),
      StateConflictError,
      "already exists",
    );

    const updated = await store.compareAndSwap("sbx-1", 0, (record) => ({
      ...record,
      phase: "running",
    }));
    assertEquals(updated.revision, 1);
    assertEquals(updated.phase, "running");

    await assertRejects(
      () => store.compareAndSwap("sbx-1", 0, (record) => record),
      StateConflictError,
      "revision",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("sandbox state survives a new store instance", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/state.json`;
    await new JsonFileSandboxStore(path).create(
      newSandboxRecord({ id: "sbx-2" }),
    );
    const reopened = new JsonFileSandboxStore(path);
    assertEquals((await reopened.get("sbx-2"))?.id, "sbx-2");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("sandbox ids cannot collide with object prototype keys", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const store = new JsonFileSandboxStore(`${directory}/state.json`);
    await store.create(newSandboxRecord({ id: "constructor" }));
    assertEquals((await store.get("constructor"))?.id, "constructor");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("corrupt nested resource and machine state fails closed", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/state.json`;
    const record = newSandboxRecord({ id: "sbx-corrupt" });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        records: {
          "sbx-corrupt": {
            ...record,
            resources: { exposedPorts: [70000] },
            machine: { executionId: "../escape", phase: "running" },
          },
        },
      }),
    );
    const store = new JsonFileSandboxStore(path);
    await assertRejects(() => store.list(), StateCorruptError);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
