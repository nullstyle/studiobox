import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ArtifactCache } from "../../../images/cache.ts";
import { sha256HexOfText } from "../../../images/validate.ts";
import { JournalArtifactReferenceReader } from "../../../src/rootd/artifact_refs.ts";
import {
  type ArtifactReference,
  newSandboxRecord,
  type SandboxPhase,
  type SandboxRecord,
} from "../../../src/state/model.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";
import { makeTestManifest } from "../images/helpers.ts";

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);
const HASH_C = "cc".repeat(32);
const HASH_D = "dd".repeat(32);

function record(
  id: string,
  phase: SandboxPhase,
  artifact?: ArtifactReference,
): SandboxRecord {
  return {
    ...newSandboxRecord({ id, createdAt: "2026-07-11T00:00:00.000Z" }),
    phase,
    ...(artifact === undefined ? {} : { artifact }),
  };
}

Deno.test("only records that have not terminated pin their manifest hashes", async () => {
  const records: SandboxRecord[] = [
    record("sbx-boot", "booting", { manifestHash: HASH_B, arch: "aarch64" }),
    record("sbx-ready", "ready", { manifestHash: HASH_A, arch: "x86_64" }),
    // Duplicate citation of an already-referenced set: deduplicated.
    record("sbx-dup", "staging", { manifestHash: HASH_B, arch: "aarch64" }),
    // terminated is the one releasing phase.
    record("sbx-done", "terminated", {
      manifestHash: HASH_C,
      arch: "aarch64",
    }),
    // quarantined keeps its reference on purpose (fail closed).
    record("sbx-quar", "quarantined", {
      manifestHash: HASH_D,
      arch: "aarch64",
    }),
    // No artifact field: valid but references nothing.
    record("sbx-none", "ready"),
    // Schema-version-1 records predate the field entirely.
    { ...record("sbx-v1", "reconciling"), schemaVersion: 1 },
  ];
  const reader = new JournalArtifactReferenceReader({
    list: () => Promise.resolve(records),
  });
  assertEquals(await reader.listReferencedManifestHashes(), [
    HASH_A,
    HASH_B,
    HASH_D,
  ]);
});

Deno.test("an empty journal references nothing", async () => {
  const reader = new JournalArtifactReferenceReader({
    list: () => Promise.resolve([]),
  });
  assertEquals(await reader.listReferencedManifestHashes(), []);
});

// Regression for CONFIRMED defect 3: without the journal-backed reader,
// GC reaped the artifact set a booting (crash-recoverable) record still
// boots from.
Deno.test("gc keeps a booting record's artifact set and may collect after termination", async () => {
  const root = await Deno.makeTempDir({ prefix: "sbx-refs-" });
  try {
    const cache = new ArtifactCache({ root: join(root, "artifacts") });
    const kernel = join(root, "vmlinux");
    await Deno.writeTextFile(kernel, "kernel fixture");
    const manifest = makeTestManifest();
    manifest.kernel.sha256 = await sha256HexOfText("kernel fixture");
    const { hash } = await cache.store({
      manifest,
      files: { vmlinux: kernel },
    });

    const store = new JsonFileSandboxStore(join(root, "state.json"));
    await store.create(newSandboxRecord({ id: "sbx-gc" }));
    await store.compareAndSwap("sbx-gc", 0, (current) => ({
      ...current,
      phase: "booting",
      artifact: { manifestHash: hash, arch: "aarch64" },
    }));

    // The refcount is zero (no local lease), so ONLY the journal
    // reference protects the set here.
    const reader = new JournalArtifactReferenceReader(store);
    assertEquals(await cache.refcount(hash), 0);
    const kept = await cache.gc(reader);
    assertEquals(kept.deleted, []);
    assertEquals(kept.kept, [hash]);
    assertEquals(await cache.has(hash), true);

    const booting = await store.get("sbx-gc");
    await store.compareAndSwap("sbx-gc", booting!.revision, (current) => ({
      ...current,
      phase: "terminated",
      terminationReason: "shutdown",
    }));

    const swept = await cache.gc(reader);
    assertEquals(swept.deleted, [hash]);
    assertEquals(await cache.has(hash), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
