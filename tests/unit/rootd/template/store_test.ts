import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  type PublishTemplateFiles,
  type PublishTemplateMetadata,
  TEMPLATE_MEM_FILE_NAME,
  TEMPLATE_METADATA_FILE_NAME,
  TEMPLATE_OVERLAY_FILE_NAME,
  TEMPLATE_REFCOUNT_FILE_NAME,
  TEMPLATE_SNAPSHOT_FILE_NAME,
  TemplateStore,
  TemplateStoreError,
  validateTemplateMetadata,
} from "../../../../src/rootd/template/store.ts";

// Distinct valid sha256 hex hashes (the store keys/validates on the shape).
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SCHEMA = "c".repeat(64);
const WRONG_SCHEMA = "d".repeat(64);
const FIXED_AT = "2026-07-13T00:00:00.000Z";

const SNAPSHOT_BYTES = "snapshot-state-file-bytes";
const MEM_BYTES = "guest-memory-image-bytes-....";
const OVERLAY_BYTES = "overlay-ext4-bytes";

function metadata(
  overrides: Partial<PublishTemplateMetadata> = {},
): PublishTemplateMetadata {
  return {
    manifestHash: HASH_A,
    schemaSha256: SCHEMA,
    firecrackerVersion: "1.16.1",
    arch: "aarch64",
    vcpuCount: 1,
    memSizeMib: 512,
    vsockPort: 1024,
    createdAt: FIXED_AT,
    ...overrides,
  };
}

/** Write the three source artifacts into `dir` and return their paths. */
async function makeSources(dir: string): Promise<PublishTemplateFiles> {
  const snapshot = join(dir, "src-snapshot");
  const mem = join(dir, "src-mem");
  const overlay = join(dir, "src-overlay");
  await Deno.writeTextFile(snapshot, SNAPSHOT_BYTES);
  await Deno.writeTextFile(mem, MEM_BYTES);
  await Deno.writeTextFile(overlay, OVERLAY_BYTES);
  return { snapshot, mem, overlay };
}

async function withRoot(
  body: (store: TemplateStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await body(new TemplateStore({ root: join(root, "templates") }), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function byteLen(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

Deno.test("publish lays out <root>/<hash>/ with all artifacts + metadata", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    const result = await store.publish({ metadata: metadata(), files });

    assertEquals(result.created, true);
    assertEquals(result.hash, HASH_A);
    assertEquals(result.dir, store.templateDir(HASH_A));
    assertEquals(await store.has(HASH_A), true);
    assertEquals(await store.list(), [HASH_A]);

    for (
      const name of [
        TEMPLATE_SNAPSHOT_FILE_NAME,
        TEMPLATE_MEM_FILE_NAME,
        TEMPLATE_OVERLAY_FILE_NAME,
        TEMPLATE_METADATA_FILE_NAME,
        TEMPLATE_REFCOUNT_FILE_NAME,
      ]
    ) {
      assertEquals((await Deno.stat(join(result.dir, name))).isFile, true);
    }

    const meta = await store.readMetadata(HASH_A);
    assertEquals(meta.manifestHash, HASH_A);
    assertEquals(meta.schemaSha256, SCHEMA);
    assertEquals(meta.firecrackerVersion, "1.16.1");
    assertEquals(meta.arch, "aarch64");
    assertEquals(meta.vcpuCount, 1);
    assertEquals(meta.memSizeMib, 512);
    assertEquals(meta.vsockPort, 1024);
    assertEquals(meta.createdAt, FIXED_AT);
    // Sizes are derived from the COPIED files, not trusted from the caller.
    assertEquals(meta.sizes.snapshot, byteLen(SNAPSHOT_BYTES));
    assertEquals(meta.sizes.mem, byteLen(MEM_BYTES));
    assertEquals(meta.sizes.overlay, byteLen(OVERLAY_BYTES));

    assertEquals(await store.refcount(HASH_A), 0);
  });
});

Deno.test("publish is idempotent — the existing template wins", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    await store.publish({ metadata: metadata(), files });
    // A second publish (even with different metadata) does not overwrite.
    const again = await store.publish({
      metadata: metadata({ firecrackerVersion: "1.17.0" }),
      files,
    });
    assertEquals(again.created, false);
    assertEquals(
      (await store.readMetadata(HASH_A)).firecrackerVersion,
      "1.16.1",
    );
  });
});

Deno.test("publish REPLACES a present-but-corrupt template and reports created/replaced (FINDING 4)", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    const first = await store.publish({ metadata: metadata(), files });
    assertEquals(first.created, true);
    assertEquals(first.replaced, false);

    // Corrupt the published template: drift the mem artifact's size so it no
    // longer matches template.json → resolve()/isValid() fail. Before FINDING 4,
    // publish no-oped on has() and this hash stayed permanently un-restorable.
    const dir = store.templateDir(HASH_A);
    await Deno.writeTextFile(
      join(dir, TEMPLATE_MEM_FILE_NAME),
      MEM_BYTES + "!!DRIFT",
    );
    assertEquals(await store.isValid(HASH_A, { schemaSha256: SCHEMA }), false);

    // A rebuild publishes fresh sources over the SAME hash. Existence is not
    // validity: the corrupt template must be REPLACED (truthful), not reused.
    const freshDir = join(root, "fresh");
    await Deno.mkdir(freshDir, { recursive: true });
    const fresh = await makeSources(freshDir);
    const replaced = await store.publish({
      metadata: metadata(),
      files: fresh,
    });
    assertEquals(
      replaced.created,
      true,
      "a corrupt template is replaced, not reused",
    );
    assertEquals(replaced.replaced, true);

    // The replacement actually LANDED: resolve now succeeds and the mem artifact
    // matches the FRESH source (not the corrupt drift), with a reset refcount.
    const resolved = await store.resolve(HASH_A, { schemaSha256: SCHEMA });
    assertEquals(resolved.metadata.sizes.mem, byteLen(MEM_BYTES));
    assertEquals(await Deno.readTextFile(resolved.memPath), MEM_BYTES);
    assertEquals(await store.refcount(HASH_A), 0);

    // Atomic replace: no leftover temp / stale dirs remain under the store root.
    const leftovers: string[] = [];
    for await (const entry of Deno.readDir(store.root)) {
      if (entry.name.startsWith(".tmp-")) leftovers.push(entry.name);
    }
    assertEquals(leftovers, []);
  });
});

Deno.test("publish over a VALID matching template is idempotent reuse — the existing one wins (FINDING 4)", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    const first = await store.publish({ metadata: metadata(), files });
    assertEquals(first.created, true);
    assertEquals(first.replaced, false);

    // A live restore holds a refcount; republishing over the VALID template must
    // NOT replace it (no torn read of a live template), so the ref survives.
    await store.acquire(HASH_A);
    const again = await store.publish({
      metadata: metadata({ firecrackerVersion: "1.17.0" }),
      files,
    });
    assertEquals(again.created, false, "a valid existing template is reused");
    assertEquals(again.replaced, false);
    // Untouched: the original metadata + the live refcount survive.
    assertEquals(
      (await store.readMetadata(HASH_A)).firecrackerVersion,
      "1.16.1",
    );
    assertEquals(await store.refcount(HASH_A), 1);
  });
});

Deno.test("resolve accepts a matching hash + schema", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    await store.publish({ metadata: metadata(), files });

    const resolved = await store.resolve(HASH_A, { schemaSha256: SCHEMA });
    assertEquals(resolved.hash, HASH_A);
    assertEquals(
      resolved.snapshotPath,
      join(resolved.dir, TEMPLATE_SNAPSHOT_FILE_NAME),
    );
    assertEquals(resolved.memPath, join(resolved.dir, TEMPLATE_MEM_FILE_NAME));
    assertEquals(
      resolved.overlayPath,
      join(resolved.dir, TEMPLATE_OVERLAY_FILE_NAME),
    );
    assertEquals(resolved.metadata.manifestHash, HASH_A);
    assertEquals(await store.isValid(HASH_A, { schemaSha256: SCHEMA }), true);
  });
});

Deno.test("resolve REJECTS a stale schema hash", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    await store.publish({ metadata: metadata(), files });

    const error = await assertRejects(
      () => store.resolve(HASH_A, { schemaSha256: WRONG_SCHEMA }),
      TemplateStoreError,
    );
    assertInstanceOf(error, TemplateStoreError);
    assertEquals(error.message.includes("stale template"), true);
    assertEquals(
      await store.isValid(HASH_A, { schemaSha256: WRONG_SCHEMA }),
      false,
    );
  });
});

Deno.test("resolve REJECTS a wrong/mislabeled manifest hash", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    await store.publish({ metadata: metadata(), files });
    // Tamper: rewrite template.json to record a DIFFERENT manifest hash than
    // the dir it lives under (a mislabeled/corrupt template).
    const metaPath = join(
      store.templateDir(HASH_A),
      TEMPLATE_METADATA_FILE_NAME,
    );
    const meta = await store.readMetadata(HASH_A);
    await Deno.writeTextFile(
      metaPath,
      JSON.stringify({ ...meta, manifestHash: HASH_B }, null, 2) + "\n",
    );

    await assertRejects(
      () => store.resolve(HASH_A, { schemaSha256: SCHEMA }),
      TemplateStoreError,
      "records manifest hash",
    );
    assertEquals(await store.isValid(HASH_A, { schemaSha256: SCHEMA }), false);
  });
});

Deno.test("resolve REJECTS a size-corrupted artifact and a missing one", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    await store.publish({ metadata: metadata(), files });
    const dir = store.templateDir(HASH_A);

    // Corrupt the mem image so its size no longer matches template.json.
    await Deno.writeTextFile(
      join(dir, TEMPLATE_MEM_FILE_NAME),
      MEM_BYTES + "!!",
    );
    await assertRejects(
      () => store.resolve(HASH_A, { schemaSha256: SCHEMA }),
      TemplateStoreError,
      "corrupt",
    );

    // Restore mem, then remove snapshot entirely.
    await Deno.writeTextFile(join(dir, TEMPLATE_MEM_FILE_NAME), MEM_BYTES);
    await Deno.remove(join(dir, TEMPLATE_SNAPSHOT_FILE_NAME));
    await assertRejects(
      () => store.resolve(HASH_A, { schemaSha256: SCHEMA }),
      TemplateStoreError,
      "missing",
    );
  });
});

Deno.test("resolve on an absent template rejects", async () => {
  await withRoot(async (store) => {
    await assertRejects(
      () => store.resolve(HASH_A, { schemaSha256: SCHEMA }),
      TemplateStoreError,
      "not present",
    );
    assertEquals(await store.isValid(HASH_A, { schemaSha256: SCHEMA }), false);
  });
});

Deno.test("refcount acquire/release guards a template; release below zero throws", async () => {
  await withRoot(async (store, root) => {
    const files = await makeSources(root);
    await store.publish({ metadata: metadata(), files });

    assertEquals(await store.refcount(HASH_A), 0);
    assertEquals(await store.acquire(HASH_A), 1);
    assertEquals(await store.acquire(HASH_A), 2);
    // While a live restore holds a ref the count stays above zero — a GC that
    // honours the refcount cannot reclaim it out from under the restore.
    assertEquals(await store.refcount(HASH_A), 2);
    assertEquals(await store.release(HASH_A), 1);
    assertEquals(await store.release(HASH_A), 0);
    await assertRejects(
      () => store.release(HASH_A),
      TemplateStoreError,
      "below zero",
    );
  });
});

Deno.test("acquire on an absent template throws", async () => {
  await withRoot(async (store) => {
    await assertRejects(
      () => store.acquire(HASH_A),
      TemplateStoreError,
      "not present",
    );
  });
});

Deno.test("a copy failure leaves no partial template and no temp dir", async () => {
  const root = await Deno.makeTempDir();
  try {
    const templateRoot = join(root, "templates");
    const store = new TemplateStore({
      root: templateRoot,
      // Fail on the second artifact so the temp dir is half-assembled.
      copyFile: async (src, dst) => {
        if (dst.endsWith(TEMPLATE_MEM_FILE_NAME)) {
          throw new Error("injected copy failure");
        }
        await Deno.copyFile(src, dst);
      },
    });
    const files = await makeSources(root);

    await assertRejects(
      () => store.publish({ metadata: metadata(), files }),
      Error,
      "injected copy failure",
    );
    assertEquals(await store.has(HASH_A), false);
    // No `.tmp-*` directory is left behind under the store root.
    const leftovers: string[] = [];
    for await (const entry of Deno.readDir(templateRoot)) {
      leftovers.push(entry.name);
    }
    assertEquals(leftovers, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("templateDir rejects a non-sha256 key", () => {
  const store = new TemplateStore({ root: "/tmp/does-not-matter" });
  assertThrows(() => store.templateDir("not-a-hash"), TemplateStoreError);
  assertThrows(() => store.templateDir("A".repeat(64)), TemplateStoreError); // uppercase
});

Deno.test("validateTemplateMetadata is strict + fail-closed", () => {
  const good = {
    schemaVersion: 1,
    manifestHash: HASH_A,
    schemaSha256: SCHEMA,
    firecrackerVersion: "1.16.1",
    arch: "aarch64",
    vcpuCount: 1,
    memSizeMib: 512,
    vsockPort: 1024,
    sizes: { snapshot: 10, mem: 20, overlay: 30 },
    createdAt: FIXED_AT,
  };
  // Baseline: the well-formed record validates.
  assertEquals(validateTemplateMetadata(good).manifestHash, HASH_A);

  assertThrows(
    () => validateTemplateMetadata({ ...good, schemaVersion: 2 }),
    TypeError,
  );
  assertThrows(
    () => validateTemplateMetadata({ ...good, extra: "nope" }),
    TypeError,
  );
  assertThrows(
    () => validateTemplateMetadata({ ...good, manifestHash: "short" }),
    TypeError,
  );
  assertThrows(
    () => validateTemplateMetadata({ ...good, arch: "riscv" }),
    TypeError,
  );
  assertThrows(
    () => validateTemplateMetadata({ ...good, vcpuCount: 0 }),
    TypeError,
  );
  assertThrows(
    () =>
      validateTemplateMetadata({
        ...good,
        sizes: { snapshot: 0, mem: 20, overlay: 30 },
      }),
    TypeError,
  );
});
