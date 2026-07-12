import { assert, assertEquals } from "@std/assert";
import {
  ABANDONED_TEMP_MAX_AGE_MS,
  JsonFileSandboxStore,
} from "../../../src/state/store.ts";
import { newSandboxRecord } from "../../../src/state/model.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("write sweeps an aged orphan .tmp but spares a fresh one", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/state.json`;
    const store = new JsonFileSandboxStore(path);

    // Seed the store so state.json exists and has a known record.
    await store.create(newSandboxRecord({ id: "sbx-keep" }));

    // A crash between temp-write and rename leaks an orphan .tmp. Simulate
    // an aged one (past the sweep bound) and a fresh one (a concurrent
    // in-flight writer's temp, well within the bound).
    const agedTemp = `${path}.${crypto.randomUUID()}.tmp`;
    const freshTemp = `${path}.${crypto.randomUUID()}.tmp`;
    // A sibling that is NOT one of this store's temps must never be touched.
    const foreignTemp = `${directory}/other.json.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(agedTemp, "half-written");
    await Deno.writeTextFile(freshTemp, "in-flight");
    await Deno.writeTextFile(foreignTemp, "not ours");

    const now = Date.now();
    const agedMs = now - (ABANDONED_TEMP_MAX_AGE_MS + 60_000);
    await Deno.utime(agedTemp, new Date(agedMs), new Date(agedMs));
    await Deno.utime(foreignTemp, new Date(agedMs), new Date(agedMs));

    // The next write runs the sweep before creating its own temp.
    const updated = await store.compareAndSwap("sbx-keep", 0, (record) => ({
      ...record,
      phase: "ready",
    }));

    // The aged orphan is gone; the fresh in-flight temp and the foreign
    // sibling survive.
    assert(!(await exists(agedTemp)), "aged orphan .tmp should be swept");
    assert(await exists(freshTemp), "fresh in-flight .tmp must be spared");
    assert(await exists(foreignTemp), "foreign .tmp must be left untouched");

    // CAS / durability semantics are unchanged by the sweep.
    assertEquals(updated.revision, 1);
    assertEquals(updated.phase, "ready");
    const reopened = new JsonFileSandboxStore(path);
    const persisted = await reopened.get("sbx-keep");
    assertEquals(persisted?.phase, "ready");
    assertEquals(persisted?.revision, 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
