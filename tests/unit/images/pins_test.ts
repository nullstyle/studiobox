import { assertEquals, assertThrows } from "@std/assert";
import { loadImagePins, validateImagePins } from "../../../images/pins.ts";
import { makeTestPins } from "./helpers.ts";

Deno.test("committed pins.json loads and validates", async () => {
  const pins = await loadImagePins();
  assertEquals(pins.schemaVersion, 1);
  assertEquals(pins.kernel.perArch.aarch64.sha256.length, 64);
  assertEquals(pins.kernel.perArch.x86_64.sha256.length, 64);
  assertEquals(pins.rootfs.sandboxUser.uid, 1000);
  assertEquals(pins.rootfs.sandboxUser.home, "/home/app");
  assertEquals(pins.rootfs.variant, "minbase");
  // The mirror must be pinned to the exact snapshot epoch.
  assertEquals(pins.rootfs.mirror.includes(pins.rootfs.snapshotEpoch), true);
});

Deno.test("pins validation is strict", () => {
  validateImagePins(makeTestPins());

  assertThrows(
    () => validateImagePins({ ...makeTestPins(), extra: true }),
    TypeError,
    "unknown field",
  );
  assertThrows(
    () => validateImagePins({ ...makeTestPins(), schemaVersion: 2 }),
    TypeError,
    "schema version",
  );

  const badSha = makeTestPins();
  badSha.kernel.perArch.aarch64.sha256 = "abc";
  assertThrows(() => validateImagePins(badSha), TypeError, "sha256");

  const httpUrl = makeTestPins();
  httpUrl.guestDeno.perArch.x86_64.url = "http://example.com/deno.zip";
  assertThrows(() => validateImagePins(httpUrl), TypeError, "https");

  const badEpoch = makeTestPins();
  badEpoch.rootfs.snapshotEpoch = "2026-06-30T21:09:56Z";
  assertThrows(() => validateImagePins(badEpoch), TypeError, "snapshotEpoch");

  const unpinnedMirror = makeTestPins();
  unpinnedMirror.rootfs.mirror = "https://deb.debian.org/debian/";
  assertThrows(() => validateImagePins(unpinnedMirror), TypeError, "epoch");

  const unsortedPackages = makeTestPins();
  unsortedPackages.rootfs.packages = ["e2fsprogs", "ca-certificates"];
  assertThrows(
    () => validateImagePins(unsortedPackages),
    TypeError,
    "sorted",
  );

  const duplicatePackages = makeTestPins();
  duplicatePackages.rootfs.packages = ["ca-certificates", "ca-certificates"];
  assertThrows(
    () => validateImagePins(duplicatePackages),
    TypeError,
    "sorted and unique",
  );

  const missingArch = makeTestPins() as unknown as {
    kernel: { perArch: Record<string, unknown> };
  };
  delete missingArch.kernel.perArch.x86_64;
  assertThrows(() => validateImagePins(missingArch), TypeError, "x86_64");

  const relativeHome = makeTestPins();
  relativeHome.rootfs.sandboxUser.home = "home/app";
  assertThrows(() => validateImagePins(relativeHome), TypeError, "absolute");

  const rootUid = makeTestPins();
  rootUid.rootfs.sandboxUser.uid = 0;
  assertThrows(() => validateImagePins(rootUid), TypeError, "uid");
});
