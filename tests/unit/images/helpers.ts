/** Shared fixtures for the artifact pipeline unit tests. */

import type { ArtifactManifest } from "../../../images/manifest.ts";
import type { ImagePins } from "../../../images/pins.ts";

export const SHA_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SHA_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const SHA_C =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
export const SHA_D =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
export const SHA_E =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function makeTestPins(): ImagePins {
  return {
    schemaVersion: 1,
    kernel: {
      firecrackerPinned: "v1.16.1",
      ciDirectory: "firecracker-ci/v1.15",
      version: "6.1.155",
      perArch: {
        aarch64: { url: "https://example.com/vmlinux-a64", sha256: SHA_A },
        x86_64: { url: "https://example.com/vmlinux-x64", sha256: SHA_B },
      },
    },
    rootfs: {
      suite: "bookworm",
      variant: "minbase",
      snapshotEpoch: "20260630T210956Z",
      mirror: "https://snapshot.debian.org/archive/debian/20260630T210956Z/",
      packages: ["ca-certificates", "e2fsprogs"],
      imageSizeMiB: 1024,
      sandboxUser: { name: "sandbox", uid: 1000, home: "/home/app" },
    },
    guestDeno: {
      version: "2.9.1",
      perArch: {
        aarch64: { url: "https://example.com/deno-a64.zip", sha256: SHA_C },
        x86_64: { url: "https://example.com/deno-x64.zip", sha256: SHA_D },
      },
    },
  };
}

export function makeTestManifest(
  overrides: Partial<ArtifactManifest> = {},
): ArtifactManifest {
  return {
    schemaVersion: 1,
    arch: "aarch64",
    kernel: {
      version: "6.1.155",
      url: "https://example.com/vmlinux-a64",
      sha256: SHA_A,
    },
    rootfs: {
      recipe: {
        suite: "bookworm",
        variant: "minbase",
        snapshotEpoch: "20260630T210956Z",
        mirror: "https://snapshot.debian.org/archive/debian/20260630T210956Z/",
        packages: ["ca-certificates", "e2fsprogs"],
        imageSizeMiB: 1024,
        sandboxUser: { name: "sandbox", uid: 1000, home: "/home/app" },
        builderScriptSha256: SHA_B,
        overlayInitSha256: SHA_C,
      },
      guestDeno: { version: "2.9.1", sha256: SHA_D },
      identity: { kind: "contentManifest", sha256: SHA_E },
      sizeBytes: 1024 * 1024 * 1024,
    },
    agentBinary: { filename: "studioboxd", sha256: SHA_E, placeholder: true },
    createdAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}
