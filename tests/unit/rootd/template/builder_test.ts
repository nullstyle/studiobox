import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  buildWarmTemplate,
  DEFAULT_TEMPLATE_MEM_SIZE_MIB,
  DEFAULT_TEMPLATE_VCPU_COUNT,
  DEFAULT_TEMPLATE_VSOCK_PORT,
  type TemplateBakeArtifacts,
  type TemplateBaker,
  type TemplateBakeRequest,
} from "../../../../src/rootd/template/builder.ts";
import { TemplateStore } from "../../../../src/rootd/template/store.ts";

const HASH = "a".repeat(64);
const SCHEMA = "c".repeat(64);
const FIXED_AT = "2026-07-13T00:00:00.000Z";

/** A fake baker that writes placeholder artifact files — no VM. */
class FakeBaker implements TemplateBaker {
  calls = 0;
  lastRequest: TemplateBakeRequest | undefined;
  constructor(
    readonly scratch: string,
    readonly firecrackerVersion = "1.16.1",
  ) {}

  async bake(request: TemplateBakeRequest): Promise<TemplateBakeArtifacts> {
    this.calls++;
    this.lastRequest = request;
    const dir = join(this.scratch, `bake-${this.calls}`);
    await Deno.mkdir(dir, { recursive: true });
    const snapshotPath = join(dir, "snapshot");
    const memPath = join(dir, "mem");
    const overlayPath = join(dir, "overlay.ext4");
    await Deno.writeTextFile(snapshotPath, `snapshot:${request.manifestHash}`);
    await Deno.writeTextFile(memPath, "mem-image-bytes");
    await Deno.writeTextFile(overlayPath, "overlay-bytes");
    return {
      snapshotPath,
      memPath,
      overlayPath,
      firecrackerVersion: this.firecrackerVersion,
    };
  }
}

async function withStore(
  body: (store: TemplateStore, baker: FakeBaker, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const store = new TemplateStore({ root: join(root, "templates") });
    const baker = new FakeBaker(join(root, "scratch"));
    await body(store, baker, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("buildWarmTemplate bakes + publishes when absent, stamping metadata", async () => {
  await withStore(async (store, baker, root) => {
    const result = await buildWarmTemplate({
      store,
      baker,
      manifestHash: HASH,
      arch: "aarch64",
      setDir: join(root, "golden"),
      workDir: join(root, "work"),
      schemaSha256: SCHEMA,
      createdAt: FIXED_AT,
    });

    assertEquals(result.created, true);
    assertEquals(result.reused, false);
    assertEquals(result.hash, HASH);
    assertEquals(baker.calls, 1);

    // The template is now valid + resolvable under the running schema.
    assertEquals(await store.isValid(HASH, { schemaSha256: SCHEMA }), true);
    const meta = await store.readMetadata(HASH);
    assertEquals(meta.schemaSha256, SCHEMA);
    assertEquals(meta.firecrackerVersion, "1.16.1");
    assertEquals(meta.arch, "aarch64");
    assertEquals(meta.vcpuCount, DEFAULT_TEMPLATE_VCPU_COUNT);
    assertEquals(meta.memSizeMib, DEFAULT_TEMPLATE_MEM_SIZE_MIB);
    assertEquals(meta.vsockPort, DEFAULT_TEMPLATE_VSOCK_PORT);
    assertEquals(meta.createdAt, FIXED_AT);

    // The bake request carried the resolved defaults through.
    assertEquals(baker.lastRequest?.manifestHash, HASH);
    assertEquals(baker.lastRequest?.vcpuCount, DEFAULT_TEMPLATE_VCPU_COUNT);
    assertEquals(baker.lastRequest?.memSizeMib, DEFAULT_TEMPLATE_MEM_SIZE_MIB);
    assertEquals(baker.lastRequest?.vsockPort, DEFAULT_TEMPLATE_VSOCK_PORT);
  });
});

Deno.test("buildWarmTemplate reuses a valid template without baking again", async () => {
  await withStore(async (store, baker, root) => {
    const opts = {
      store,
      baker,
      manifestHash: HASH,
      arch: "aarch64" as const,
      setDir: join(root, "golden"),
      workDir: join(root, "work"),
      schemaSha256: SCHEMA,
      createdAt: FIXED_AT,
    };
    await buildWarmTemplate(opts);
    const second = await buildWarmTemplate(opts);

    assertEquals(second.created, false);
    assertEquals(second.reused, true);
    assertEquals(second.hash, HASH);
    // No second bake — the store already had a valid template.
    assertEquals(baker.calls, 1);
  });
});

Deno.test("buildWarmTemplate rebakes AND replaces when the existing template is a different schema", async () => {
  await withStore(async (store, baker, root) => {
    const base = {
      store,
      baker,
      manifestHash: HASH,
      arch: "aarch64" as const,
      setDir: join(root, "golden"),
      workDir: join(root, "work"),
      createdAt: FIXED_AT,
    };
    await buildWarmTemplate({ ...base, schemaSha256: SCHEMA });
    // A different running schema makes the existing template INVALID, so isValid
    // is false and a bake is attempted. The fresh bake must actually REPLACE the
    // stale template (not no-op behind a false reuse) — FINDING 4.
    const otherSchema = "e".repeat(64);
    const other = await buildWarmTemplate({
      ...base,
      schemaSha256: otherSchema,
    });
    assertEquals(baker.calls, 2);
    // The rebuild replaced the stale template: a truthful outcome (created /
    // replaced), never a false `reused`.
    assertEquals(other.created, true);
    assertEquals(other.replaced, true);
    assertEquals(other.reused, false);
    // The store now holds a template VALID under the new schema (the replace
    // actually landed) — and stale under the old one.
    assertEquals(
      await store.isValid(HASH, { schemaSha256: otherSchema }),
      true,
    );
    assertEquals(await store.isValid(HASH, { schemaSha256: SCHEMA }), false);
    assertEquals((await store.readMetadata(HASH)).schemaSha256, otherSchema);
  });
});

Deno.test("buildWarmTemplate honours explicit vcpu/mem/vsock overrides", async () => {
  await withStore(async (store, baker, root) => {
    await buildWarmTemplate({
      store,
      baker,
      manifestHash: HASH,
      arch: "x86_64",
      setDir: join(root, "golden"),
      workDir: join(root, "work"),
      schemaSha256: SCHEMA,
      vcpuCount: 4,
      memSizeMib: 2048,
      vsockPort: 2048,
      createdAt: FIXED_AT,
    });
    const meta = await store.readMetadata(HASH);
    assertEquals(meta.arch, "x86_64");
    assertEquals(meta.vcpuCount, 4);
    assertEquals(meta.memSizeMib, 2048);
    assertEquals(meta.vsockPort, 2048);
    assertEquals(baker.lastRequest?.vcpuCount, 4);
    assertEquals(baker.lastRequest?.memSizeMib, 2048);
  });
});
