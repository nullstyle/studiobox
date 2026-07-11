import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  ABANDONED_TEMP_MAX_AGE_MS,
  ArtifactCache,
  ArtifactCacheError,
  type ArtifactReferenceReader,
  MANIFEST_FILE_NAME,
  REFCOUNT_FILE_NAME,
} from "../../../images/cache.ts";
import type { ArtifactManifest } from "../../../images/manifest.ts";
import { manifestHash } from "../../../images/manifest.ts";
import { sha256HexOfText } from "../../../images/validate.ts";
import { makeTestManifest, SHA_A } from "./helpers.ts";

const KERNEL_FIXTURE = "kernel fixture";

function reader(hashes: string[]): ArtifactReferenceReader {
  return { listReferencedManifestHashes: () => Promise.resolve(hashes) };
}

/** A manifest whose kernel pin matches the on-disk kernel fixture bytes. */
async function makeVerifiableManifest(): Promise<ArtifactManifest> {
  const manifest = makeTestManifest();
  manifest.kernel.sha256 = await sha256HexOfText(KERNEL_FIXTURE);
  return manifest;
}

async function makeStoredSet(root: string, cache: ArtifactCache) {
  const dir = await Deno.makeTempDir();
  const kernel = join(dir, "vmlinux");
  await Deno.writeTextFile(kernel, KERNEL_FIXTURE);
  const manifest = await makeVerifiableManifest();
  const result = await cache.store({
    manifest,
    files: { vmlinux: kernel },
  });
  await Deno.remove(dir, { recursive: true });
  return { manifest, ...result, root };
}

Deno.test("store lays out <root>/<manifest-hash> and is idempotent", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root: join(root, "artifacts") });
    const stored = await makeStoredSet(root, cache);

    assertEquals(stored.created, true);
    assertEquals(stored.hash, await manifestHash(stored.manifest));
    assertEquals(stored.dir, cache.setPath(stored.hash));
    assertEquals(await cache.has(stored.hash), true);
    assertEquals(await cache.list(), [stored.hash]);
    assertEquals(await cache.readManifest(stored.hash), stored.manifest);
    assertEquals(
      await Deno.readTextFile(join(stored.dir, "vmlinux")),
      "kernel fixture",
    );
    assertEquals(await cache.refcount(stored.hash), 0);

    const again = await makeStoredSet(root, cache);
    assertEquals(again.created, false, "existing sets are left untouched");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reserved and traversal file names are rejected", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    for (const name of [MANIFEST_FILE_NAME, REFCOUNT_FILE_NAME]) {
      await assertRejects(
        () =>
          cache.store({
            manifest: makeTestManifest(),
            files: { [name]: "/dev/null" },
          }),
        ArtifactCacheError,
        "reserved",
      );
    }
    await assertRejects(
      () =>
        cache.store({
          manifest: makeTestManifest(),
          files: { "../escape": "/dev/null" },
        }),
      TypeError,
      "file name",
    );
    assertEquals(await cache.list(), [], "failed stores leave no sets behind");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("refcounts acquire/release with a floor at zero", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const { hash } = await makeStoredSet(root, cache);

    assertEquals(await cache.acquire(hash), 1);
    assertEquals(await cache.acquire(hash), 2);
    assertEquals(await cache.release(hash), 1);
    assertEquals(await cache.release(hash), 0);
    await assertRejects(
      () => cache.release(hash),
      ArtifactCacheError,
      "below zero",
    );
    await assertRejects(
      () => cache.acquire(SHA_A),
      ArtifactCacheError,
      "not cached",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc deletes only unreferenced, refcount-zero sets", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const { hash } = await makeStoredSet(root, cache);

    // Journal-referenced: survives even at refcount zero.
    assertEquals(await cache.refcount(hash), 0);
    let result = await cache.gc(reader([hash]));
    assertEquals(result, { deleted: [], kept: [hash] });
    assertEquals(await cache.has(hash), true);

    // Refcounted: survives even with no journal reference.
    await cache.acquire(hash);
    result = await cache.gc(reader([]));
    assertEquals(result, { deleted: [], kept: [hash] });

    // Neither guard: reaped.
    await cache.release(hash);
    result = await cache.gc(reader([]));
    assertEquals(result, { deleted: [hash], kept: [] });
    assertEquals(await cache.has(hash), false);
    assertEquals(await cache.list(), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc keeps sets whose refcount file is corrupt", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const { hash, dir } = await makeStoredSet(root, cache);
    await Deno.writeTextFile(join(dir, REFCOUNT_FILE_NAME), '{"count":-1}');

    await assertRejects(
      () => cache.refcount(hash),
      ArtifactCacheError,
      "corrupt",
    );
    const result = await cache.gc(reader([]));
    assertEquals(result, { deleted: [], kept: [hash] });
    assertEquals(await cache.has(hash), true, "fail closed, never reap blind");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc ignores foreign directory names and missing roots", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    await Deno.mkdir(join(root, "not-a-hash"));
    await Deno.mkdir(join(root, ".tmp-abandoned"));
    const result = await cache.gc(reader([]));
    assertEquals(result, { deleted: [], kept: [] });
    assertEquals(
      await Deno.stat(join(root, "not-a-hash")).then((s) => s.isDirectory),
      true,
    );

    const missing = new ArtifactCache({ root: join(root, "does-not-exist") });
    assertEquals(await missing.list(), []);
    assertEquals(await missing.gc(reader([])), { deleted: [], kept: [] });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent acquires and releases serialize exactly", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const { hash, dir } = await makeStoredSet(root, cache);

    // Regression (repro_cache_race.ts race A): unserialized read-modify-
    // write lost updates, so Promise.all acquires returned duplicates.
    const acquired = await Promise.all(
      Array.from({ length: 5 }, () => cache.acquire(hash)),
    );
    assertEquals(acquired, [1, 2, 3, 4, 5]);
    assertEquals(await cache.refcount(hash), 5);

    const released = await Promise.all([
      cache.release(hash),
      cache.release(hash),
    ]);
    assertEquals(released, [4, 3]);
    assertEquals(await cache.refcount(hash), 3);

    // Durable refcount writes leave no temp files behind in the set dir.
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.sort(), [
      MANIFEST_FILE_NAME,
      REFCOUNT_FILE_NAME,
      "vmlinux",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc cannot reap a set out from under a concurrent acquire", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const { hash } = await makeStoredSet(root, cache);

    // Regression (repro_cache_race.ts race B): gc's refcount read and its
    // recursive remove used to straddle an await, so an acquire landing in
    // the gap returned success while gc deleted the set dir. With the
    // mutex, an acquire issued mid-gc is ordered strictly after it: the
    // set is already reaped and the acquire fails closed.
    const slowReader: ArtifactReferenceReader = {
      listReferencedManifestHashes: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [];
      },
    };
    const gcPromise = cache.gc(slowReader);
    const acquireOutcome = cache.acquire(hash).then(
      (count) => ({ count, error: null as unknown }),
      (error) => ({ count: null, error }),
    );
    const gcResult = await gcPromise;
    const acquired = await acquireOutcome;

    assertEquals(gcResult, { deleted: [hash], kept: [] });
    assertEquals(
      acquired.count,
      null,
      "acquire must never succeed against a reaped set",
    );
    assertInstanceOf(acquired.error, ArtifactCacheError);
    assertEquals(await cache.has(hash), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent stores of the same manifest yield a single set", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const dir = await Deno.makeTempDir();
    const kernel = join(dir, "vmlinux");
    await Deno.writeTextFile(kernel, KERNEL_FIXTURE);
    const manifest = await makeVerifiableManifest();

    const [first, second] = await Promise.all([
      cache.store({ manifest, files: { vmlinux: kernel } }),
      cache.store({ manifest, files: { vmlinux: kernel } }),
    ]);
    assertEquals([first.created, second.created].sort(), [false, true]);
    assertEquals(first.hash, second.hash);
    assertEquals(await cache.list(), [first.hash]);
    await Deno.remove(dir, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("store verifies copied files against the manifest sha256 pins", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const dir = await Deno.makeTempDir();
    const kernel = join(dir, "vmlinux");
    await Deno.writeTextFile(kernel, "not the pinned kernel bytes");

    // Kernel pin mismatch: typed error, nothing becomes visible, and the
    // partial temp dir is removed.
    await assertRejects(
      () =>
        cache.store({
          manifest: makeTestManifest(), // kernel.sha256 = SHA_A, never matches
          files: { vmlinux: kernel },
        }),
      ArtifactCacheError,
      "sha256",
    );
    assertEquals(await cache.list(), []);
    for await (const entry of Deno.readDir(root)) {
      throw new Error(`failed store left ${entry.name} behind`);
    }

    // Agent binary pin mismatch is caught the same way.
    const agent = join(dir, "studioboxd");
    await Deno.writeTextFile(agent, "agent fixture");
    const badAgent = await makeVerifiableManifest();
    badAgent.agentBinary = { ...badAgent.agentBinary, sha256: SHA_A };
    await Deno.writeTextFile(kernel, KERNEL_FIXTURE);
    await assertRejects(
      () =>
        cache.store({
          manifest: badAgent,
          files: { vmlinux: kernel, studioboxd: agent },
        }),
      ArtifactCacheError,
      "sha256",
    );

    // Matching pins for kernel + agent binary succeed.
    const good = await makeVerifiableManifest();
    good.agentBinary = {
      ...good.agentBinary,
      sha256: await sha256HexOfText("agent fixture"),
    };
    const stored = await cache.store({
      manifest: good,
      files: { vmlinux: kernel, studioboxd: agent },
    });
    assertEquals(stored.created, true);
    await Deno.remove(dir, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("store verifies rootfs bytes only when the identity covers bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const dir = await Deno.makeTempDir();
    const kernel = join(dir, "vmlinux");
    await Deno.writeTextFile(kernel, KERNEL_FIXTURE);
    const rootfs = join(dir, "rootfs.ext4");
    await Deno.writeTextFile(rootfs, "rootfs fixture");

    // identity.kind === "imageBytes" pins the raw bytes: mismatch fails.
    const pinned = await makeVerifiableManifest();
    pinned.rootfs = {
      ...pinned.rootfs,
      identity: { kind: "imageBytes", sha256: SHA_A },
    };
    await assertRejects(
      () =>
        cache.store({
          manifest: pinned,
          files: { vmlinux: kernel, "rootfs.ext4": rootfs },
        }),
      ArtifactCacheError,
      "sha256",
    );

    // ...and a matching pin passes.
    pinned.rootfs = {
      ...pinned.rootfs,
      identity: {
        kind: "imageBytes",
        sha256: await sha256HexOfText("rootfs fixture"),
      },
    };
    const storedPinned = await cache.store({
      manifest: pinned,
      files: { vmlinux: kernel, "rootfs.ext4": rootfs },
    });
    assertEquals(storedPinned.created, true);

    // identity.kind === "contentManifest" does not pin the ext4 bytes, so
    // arbitrary rootfs bytes are accepted (identity is over the content
    // manifest, not the image). Vary an input pin so this set gets its own
    // manifest hash — identity itself is a build output, excluded from it.
    const unpinned = await makeVerifiableManifest();
    unpinned.rootfs = {
      ...unpinned.rootfs,
      recipe: { ...unpinned.rootfs.recipe, suite: "trixie" },
    };
    assertEquals(unpinned.rootfs.identity.kind, "contentManifest");
    const storedUnpinned = await cache.store({
      manifest: unpinned,
      files: { vmlinux: kernel, "rootfs.ext4": rootfs },
    });
    assertEquals(storedUnpinned.created, true);
    await Deno.remove(dir, { recursive: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc sweeps abandoned temp dirs only after they age out", async () => {
  const root = await Deno.makeTempDir();
  try {
    const cache = new ArtifactCache({ root });
    const abandoned = join(root, ".tmp-abandoned");
    await Deno.mkdir(abandoned);
    await Deno.writeTextFile(join(abandoned, "partial"), "x");
    const past = new Date(Date.now() - ABANDONED_TEMP_MAX_AGE_MS - 60_000);
    await Deno.utime(abandoned, past, past);
    const inFlight = join(root, ".tmp-in-flight");
    await Deno.mkdir(inFlight);

    const result = await cache.gc(reader([]));
    assertEquals(result, { deleted: [], kept: [] });
    await assertRejects(() => Deno.stat(abandoned), Deno.errors.NotFound);
    assertEquals((await Deno.stat(inFlight)).isDirectory, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cache root is overridable (tests never touch the real home)", () => {
  // defaultArtifactCacheRoot() reads HOME lazily and would need --allow-env;
  // every test above overrides `root`, so no env permission is required.
  const cache = new ArtifactCache({ root: "/tmp/sbx-test-artifacts" });
  assertEquals(cache.root, "/tmp/sbx-test-artifacts");
});
