import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  type ArtifactManifest,
  manifestFromPins,
  manifestHash,
  readArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest,
} from "../../../images/manifest.ts";
import {
  makeTestManifest,
  makeTestPins,
  SHA_A,
  SHA_B,
  SHA_C,
} from "./helpers.ts";

Deno.test("manifest validation is strict and unknown-key-rejecting", () => {
  validateArtifactManifest(makeTestManifest());

  assertThrows(
    () => validateArtifactManifest({ ...makeTestManifest(), extra: 1 }),
    TypeError,
    "unknown field",
  );
  assertThrows(
    () => validateArtifactManifest({ ...makeTestManifest(), schemaVersion: 9 }),
    TypeError,
    "schema version",
  );
  assertThrows(
    () =>
      validateArtifactManifest({
        ...makeTestManifest(),
        arch: "riscv64" as never,
      }),
    TypeError,
    "arch",
  );

  const badIdentity = makeTestManifest();
  badIdentity.rootfs.identity.kind = "raw" as never;
  assertThrows(() => validateArtifactManifest(badIdentity), TypeError, "kind");

  const badAgentName = makeTestManifest();
  badAgentName.agentBinary.filename = "../studioboxd";
  assertThrows(
    () => validateArtifactManifest(badAgentName),
    TypeError,
    "file name",
  );

  const badBuilderSha = makeTestManifest();
  badBuilderSha.rootfs.recipe.builderScriptSha256 = "nope";
  assertThrows(
    () => validateArtifactManifest(badBuilderSha),
    TypeError,
    "builderScriptSha256",
  );

  const zeroSize = makeTestManifest();
  zeroSize.rootfs.sizeBytes = 0;
  assertThrows(
    () => validateArtifactManifest(zeroSize),
    TypeError,
    "sizeBytes",
  );
});

Deno.test("manifest hash is deterministic and key-order independent", async () => {
  const manifest = makeTestManifest();
  const hash = await manifestHash(manifest);
  assertEquals(hash.length, 64);

  // Same data, different property insertion order.
  const reordered = JSON.parse(JSON.stringify({
    createdAt: manifest.createdAt,
    agentBinary: manifest.agentBinary,
    rootfs: manifest.rootfs,
    kernel: manifest.kernel,
    arch: manifest.arch,
    schemaVersion: manifest.schemaVersion,
  })) as ArtifactManifest;
  assertEquals(await manifestHash(reordered), hash);
});

Deno.test("manifest hash covers input pins only", async () => {
  const base = await manifestHash(makeTestManifest());

  // Build outputs and timestamps do not change the identity...
  const outputsChanged = makeTestManifest({
    createdAt: "2027-01-01T00:00:00.000Z",
  });
  outputsChanged.rootfs.identity = { kind: "imageBytes", sha256: SHA_A };
  outputsChanged.rootfs.sizeBytes = 42;
  assertEquals(await manifestHash(outputsChanged), base);

  // ...but every input pin does.
  const kernelChanged = makeTestManifest();
  kernelChanged.kernel.sha256 = SHA_B;
  assertNotEquals(await manifestHash(kernelChanged), base);

  const epochChanged = makeTestManifest();
  epochChanged.rootfs.recipe.snapshotEpoch = "20250101T000000Z";
  assertNotEquals(await manifestHash(epochChanged), base);

  const packagesChanged = makeTestManifest();
  packagesChanged.rootfs.recipe.packages = ["ca-certificates"];
  assertNotEquals(await manifestHash(packagesChanged), base);

  const denoChanged = makeTestManifest();
  denoChanged.rootfs.guestDeno.version = "2.10.0";
  assertNotEquals(await manifestHash(denoChanged), base);

  const agentChanged = makeTestManifest();
  agentChanged.agentBinary.sha256 = SHA_C;
  assertNotEquals(await manifestHash(agentChanged), base);

  const builderChanged = makeTestManifest();
  builderChanged.rootfs.recipe.builderScriptSha256 = SHA_A;
  assertNotEquals(await manifestHash(builderChanged), base);
});

Deno.test("manifestFromPins mirrors the committed pins", async () => {
  const pins = makeTestPins();
  const manifest = manifestFromPins({
    pins,
    arch: "x86_64",
    builderScriptSha256: SHA_A,
    overlayInitSha256: SHA_B,
    agentBinary: { filename: "studioboxd", sha256: SHA_C, placeholder: true },
    identity: { kind: "contentManifest", sha256: SHA_A },
    rootfsSizeBytes: 1024,
    createdAt: "2026-07-11T00:00:00.000Z",
  });
  assertEquals(manifest.kernel.sha256, pins.kernel.perArch.x86_64.sha256);
  assertEquals(
    manifest.rootfs.guestDeno.sha256,
    pins.guestDeno.perArch.x86_64.sha256,
  );
  assertEquals(manifest.rootfs.recipe.snapshotEpoch, pins.rootfs.snapshotEpoch);
  assertEquals(manifest.rootfs.recipe.sandboxUser, pins.rootfs.sandboxUser);
  assertEquals((await manifestHash(manifest)).length, 64);
});

Deno.test("manifest write/read round-trips and read fails closed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "manifest.json");
    const manifest = makeTestManifest();
    await writeArtifactManifest(path, manifest);
    assertEquals(await readArtifactManifest(path), manifest);

    await Deno.writeTextFile(path, "{not json");
    await assertRejects(
      () => readArtifactManifest(path),
      TypeError,
      "unreadable",
    );

    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...makeTestManifest(), injected: true }),
    );
    await assertRejects(
      () => readArtifactManifest(path),
      TypeError,
      "unknown field",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
