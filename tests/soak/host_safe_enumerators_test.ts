/**
 * The REAL host-safe enumerator factories (PLAN.md §M11): each catches a
 * deliberately-created leak against a temp state-dir / artifact-cache / FS /
 * pid ledger, and reports clean when there is nothing to leak. Complements the
 * fake-enumerator catch-tests in `leak_audit_test.ts` — here the studiobox
 * client surfaces do the enumerating, on any OS.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

import { ArtifactCache } from "../../images/cache.ts";
import { JournalArtifactReferenceReader } from "../../src/rootd/artifact_refs.ts";
import { newSandboxRecord, type SandboxRecord } from "../../src/state/model.ts";
import {
  artifactRefcountEnumerator,
  jailRootEnumerator,
  journalPhaseEnumerator,
  type JournalReader,
  overlayFileEnumerator,
  portReservationEnumerator,
  trackedProcessEnumerator,
} from "../../tools/soak/leak_audit.ts";

function stubJournal(records: SandboxRecord[]): JournalReader {
  return {
    list: () => Promise.resolve(records.map((r) => structuredClone(r))),
  };
}

function record(id: string, over: Partial<SandboxRecord>): SandboxRecord {
  return { ...newSandboxRecord({ id }), ...over };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-le-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("journalPhaseEnumerator flags non-terminal (and quarantined) records", async () => {
  const journal = stubJournal([
    record("sbx-a", { phase: "terminated" }),
    record("sbx-b", { phase: "ready" }),
    record("sbx-c", { phase: "quarantined" }),
  ]);
  const found = await journalPhaseEnumerator(journal).enumerate();
  assertEquals([...found].sort(), ["sbx-b:ready", "sbx-c:quarantined"]);

  // A run where everything reached terminal is clean.
  const clean = await journalPhaseEnumerator(
    stubJournal([record("sbx-a", { phase: "terminated" })]),
  ).enumerate();
  assertEquals(clean, []);
});

Deno.test("portReservationEnumerator flags ports held by a terminal record", async () => {
  const journal = stubJournal([
    record("sbx-a", {
      phase: "terminated",
      resources: { exposedPorts: [40100, 40101] },
    }),
    // A live sandbox legitimately holds its port — not a leak.
    record("sbx-b", { phase: "ready", resources: { exposedPorts: [40102] } }),
  ]);
  const found = await portReservationEnumerator(journal).enumerate();
  assertEquals([...found].sort(), ["sbx-a:port=40100", "sbx-a:port=40101"]);
});

Deno.test("overlayFileEnumerator flags leaked overlays only", async () => {
  await withTempDir(async (dir) => {
    const overlayDir = join(dir, "o");
    await Deno.mkdir(overlayDir);
    await Deno.writeTextFile(join(overlayDir, "ov-e1.ext4"), "x");
    await Deno.writeTextFile(join(overlayDir, "ov-e2.ext4"), "x");
    await Deno.writeTextFile(join(overlayDir, "notes.txt"), "not an overlay");

    const found = await overlayFileEnumerator(overlayDir).enumerate();
    assertEquals(found, ["ov-e1.ext4", "ov-e2.ext4"]);

    // A missing overlay dir enumerates clean, never throws.
    const clean = await overlayFileEnumerator(join(dir, "gone")).enumerate();
    assertEquals(clean, []);
  });
});

Deno.test("jailRootEnumerator flags per-execution jail dirs", async () => {
  await withTempDir(async (dir) => {
    const base = join(dir, "j");
    await Deno.mkdir(join(base, "firecracker-fake-ready", "e1"), {
      recursive: true,
    });
    await Deno.mkdir(join(base, "firecracker-fake-ready", "e2"), {
      recursive: true,
    });
    const found = await jailRootEnumerator(base).enumerate();
    assertEquals(found, [
      "firecracker-fake-ready/e1",
      "firecracker-fake-ready/e2",
    ]);

    const clean = await jailRootEnumerator(join(dir, "gone")).enumerate();
    assertEquals(clean, []);
  });
});

Deno.test("trackedProcessEnumerator flags launched pids that are still alive", async () => {
  // A real dead pid: spawn a process and wait for it to exit + be reaped.
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", ""],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await child.status;
  const deadPid = child.pid;
  const alivePid = Deno.pid;

  const found = await trackedProcessEnumerator(() => [alivePid, deadPid])
    .enumerate();
  assertEquals(found, [`pid=${alivePid}`]);
});

Deno.test("artifactRefcountEnumerator flags a stuck belt, honours the journal reference", async () => {
  await withTempDir(async (dir) => {
    const cache = new ArtifactCache({ root: join(dir, "cache") });
    const hash = "b".repeat(64);
    await Deno.mkdir(cache.setPath(hash), { recursive: true });
    await cache.acquire(hash); // refcount 1, no live record referencing it

    // No record references the hash → the belt is leaked.
    const noRefs = new JournalArtifactReferenceReader(stubJournal([]));
    assertEquals(
      await artifactRefcountEnumerator(cache, noRefs).enumerate(),
      [`${hash}@1`],
    );

    // A live (non-terminal) record referencing it makes the belt legitimate.
    const liveRefs = new JournalArtifactReferenceReader(stubJournal([
      record("sbx-a", {
        phase: "booting",
        artifact: { manifestHash: hash, arch: "x86_64" },
      }),
    ]));
    assertEquals(
      await artifactRefcountEnumerator(cache, liveRefs).enumerate(),
      [],
    );

    // Released back to zero → clean regardless of references.
    await cache.release(hash);
    assertEquals(
      await artifactRefcountEnumerator(cache, noRefs).enumerate(),
      [],
    );
  });
});

Deno.test("artifactRefcountEnumerator ignores sets with a corrupt refcount (fail closed)", async () => {
  await withTempDir(async (dir) => {
    const cache = new ArtifactCache({ root: join(dir, "cache") });
    const hash = "c".repeat(64);
    await Deno.mkdir(cache.setPath(hash), { recursive: true });
    await Deno.writeTextFile(join(cache.setPath(hash), "refcount.json"), "{{");
    const refs = new JournalArtifactReferenceReader(stubJournal([]));
    // A corrupt refcount is not a countable belt leak (the cache keeps it).
    const found = await artifactRefcountEnumerator(cache, refs).enumerate();
    assert(!found.includes(`${hash}@`));
  });
});
