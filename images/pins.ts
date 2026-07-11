/**
 * `images/pins.json` — the input pins for the M4 artifact pipeline.
 *
 * Everything a golden artifact set is built *from* is pinned here: the
 * Firecracker-CI guest kernel per arch (url + sha256), the rootfs recipe
 * (Debian suite/variant, the exact `snapshot.debian.org` epoch, package
 * list, sandbox user), and the guest Deno release per arch. The manifest
 * hash (`manifest.ts`) is derived from these pins, so editing this file
 * produces a new artifact identity.
 */

import { fromFileUrl } from "@std/path";
import {
  assertKeys,
  assertRecord,
  assertSha256,
  assertText,
  assertUnsignedInteger,
} from "./validate.ts";

export type ArtifactArch = "aarch64" | "x86_64";

export const ARTIFACT_ARCHES: readonly ArtifactArch[] = ["aarch64", "x86_64"];

export const IMAGE_PINS_VERSION = 1 as const;

/** A single sha256-pinned download. */
export interface PinnedDownload {
  url: string;
  sha256: string;
}

export interface KernelPins {
  /** The Firecracker release the CI kernel dir is derived from. */
  firecrackerPinned: string;
  /** CI bucket directory the kernels were published under. */
  ciDirectory: string;
  /** Guest kernel version (same for every arch). */
  version: string;
  perArch: Record<ArtifactArch, PinnedDownload>;
}

export interface SandboxUserPin {
  name: string;
  uid: number;
  home: string;
}

export interface RootfsPins {
  suite: string;
  variant: string;
  /** Exact `snapshot.debian.org` epoch, e.g. `20260630T210956Z`. */
  snapshotEpoch: string;
  /** Mirror URL derived from the epoch; recorded whole for the builder. */
  mirror: string;
  /** Extra packages over minbase; sorted, unique. */
  packages: string[];
  /** Golden rootfs ext4 image size. */
  imageSizeMiB: number;
  sandboxUser: SandboxUserPin;
}

export interface GuestDenoPins {
  version: string;
  perArch: Record<ArtifactArch, PinnedDownload>;
}

export interface ImagePins {
  schemaVersion: typeof IMAGE_PINS_VERSION;
  kernel: KernelPins;
  rootfs: RootfsPins;
  guestDeno: GuestDenoPins;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const SNAPSHOT_EPOCH_PATTERN = /^\d{8}T\d{6}Z$/;
const DEBIAN_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;
const USER_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

export function assertArtifactArch(
  value: unknown,
  field: string,
): asserts value is ArtifactArch {
  if (!ARTIFACT_ARCHES.includes(value as ArtifactArch)) {
    throw new TypeError(
      `${field} must be one of ${ARTIFACT_ARCHES.join(", ")}`,
    );
  }
}

function assertHttpsUrl(
  value: unknown,
  field: string,
): asserts value is string {
  assertText(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new TypeError(`${field} must use https`);
  }
}

function validatePinnedDownload(value: unknown, field: string): PinnedDownload {
  const pin = assertRecord(value, field) as Partial<PinnedDownload>;
  assertKeys(pin, ["url", "sha256"], field);
  assertHttpsUrl(pin.url, `${field}.url`);
  assertSha256(pin.sha256, `${field}.sha256`);
  return { url: pin.url, sha256: pin.sha256 };
}

function validatePerArch(
  value: unknown,
  field: string,
): Record<ArtifactArch, PinnedDownload> {
  const perArch = assertRecord(value, field);
  assertKeys(perArch, ARTIFACT_ARCHES, field);
  const result = {} as Record<ArtifactArch, PinnedDownload>;
  for (const arch of ARTIFACT_ARCHES) {
    result[arch] = validatePinnedDownload(perArch[arch], `${field}.${arch}`);
  }
  return result;
}

export function validateSandboxUser(
  value: unknown,
  field = "sandboxUser",
): SandboxUserPin {
  const user = assertRecord(value, field) as Partial<SandboxUserPin>;
  assertKeys(user, ["name", "uid", "home"], field);
  if (typeof user.name !== "string" || !USER_NAME_PATTERN.test(user.name)) {
    throw new TypeError(`${field}.name must be a valid unix user name`);
  }
  assertUnsignedInteger(user.uid, `${field}.uid`, 0xffff, 1);
  assertText(user.home, `${field}.home`, 256);
  if (!user.home.startsWith("/")) {
    throw new TypeError(`${field}.home must be an absolute path`);
  }
  return { name: user.name, uid: user.uid, home: user.home };
}

export function validateRootfsPins(
  value: unknown,
  field = "rootfs",
): RootfsPins {
  const rootfs = assertRecord(value, field) as Partial<RootfsPins>;
  assertKeys(rootfs, [
    "suite",
    "variant",
    "snapshotEpoch",
    "mirror",
    "packages",
    "imageSizeMiB",
    "sandboxUser",
  ], field);
  assertText(rootfs.suite, `${field}.suite`, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(rootfs.suite)) {
    throw new TypeError(`${field}.suite must be a debian suite name`);
  }
  assertText(rootfs.variant, `${field}.variant`, 64);
  if (
    typeof rootfs.snapshotEpoch !== "string" ||
    !SNAPSHOT_EPOCH_PATTERN.test(rootfs.snapshotEpoch)
  ) {
    throw new TypeError(
      `${field}.snapshotEpoch must match YYYYMMDDTHHMMSSZ exactly`,
    );
  }
  assertHttpsUrl(rootfs.mirror, `${field}.mirror`);
  if (!rootfs.mirror.includes(rootfs.snapshotEpoch)) {
    throw new TypeError(`${field}.mirror must embed the pinned snapshot epoch`);
  }
  if (!Array.isArray(rootfs.packages) || rootfs.packages.length > 128) {
    throw new TypeError(`${field}.packages must be an array of at most 128`);
  }
  for (let i = 0; i < rootfs.packages.length; i++) {
    const pkg = rootfs.packages[i];
    assertText(pkg, `${field}.packages[${i}]`, 128);
    if (!DEBIAN_PACKAGE_PATTERN.test(pkg)) {
      throw new TypeError(
        `${field}.packages[${i}] is not a debian package name`,
      );
    }
    if (i > 0 && rootfs.packages[i - 1] >= pkg) {
      throw new TypeError(`${field}.packages must be sorted and unique`);
    }
  }
  assertUnsignedInteger(
    rootfs.imageSizeMiB,
    `${field}.imageSizeMiB`,
    65_536,
    64,
  );
  const sandboxUser = validateSandboxUser(
    rootfs.sandboxUser,
    `${field}.sandboxUser`,
  );
  return {
    suite: rootfs.suite,
    variant: rootfs.variant,
    snapshotEpoch: rootfs.snapshotEpoch,
    mirror: rootfs.mirror,
    packages: [...rootfs.packages],
    imageSizeMiB: rootfs.imageSizeMiB,
    sandboxUser,
  };
}

export function validateImagePins(value: unknown): ImagePins {
  const pins = assertRecord(value, "image pins") as Partial<ImagePins>;
  assertKeys(
    pins,
    ["schemaVersion", "kernel", "rootfs", "guestDeno"],
    "image pins",
  );
  if (pins.schemaVersion !== IMAGE_PINS_VERSION) {
    throw new TypeError("unsupported image pins schema version");
  }
  const kernel = assertRecord(pins.kernel, "kernel pins") as Partial<
    KernelPins
  >;
  assertKeys(kernel, [
    "firecrackerPinned",
    "ciDirectory",
    "version",
    "perArch",
  ], "kernel pins");
  if (
    typeof kernel.firecrackerPinned !== "string" ||
    !RELEASE_TAG_PATTERN.test(kernel.firecrackerPinned)
  ) {
    throw new TypeError("kernel pins firecrackerPinned must be a vX.Y.Z tag");
  }
  assertText(kernel.ciDirectory, "kernel pins ciDirectory", 128);
  if (
    typeof kernel.version !== "string" || !VERSION_PATTERN.test(kernel.version)
  ) {
    throw new TypeError("kernel pins version must be X.Y.Z");
  }
  const guestDeno = assertRecord(
    pins.guestDeno,
    "guestDeno pins",
  ) as Partial<GuestDenoPins>;
  assertKeys(guestDeno, ["version", "perArch"], "guestDeno pins");
  if (
    typeof guestDeno.version !== "string" ||
    !VERSION_PATTERN.test(guestDeno.version)
  ) {
    throw new TypeError("guestDeno pins version must be X.Y.Z");
  }
  return {
    schemaVersion: IMAGE_PINS_VERSION,
    kernel: {
      firecrackerPinned: kernel.firecrackerPinned,
      ciDirectory: kernel.ciDirectory,
      version: kernel.version,
      perArch: validatePerArch(kernel.perArch, "kernel pins perArch"),
    },
    rootfs: validateRootfsPins(pins.rootfs),
    guestDeno: {
      version: guestDeno.version,
      perArch: validatePerArch(guestDeno.perArch, "guestDeno pins perArch"),
    },
  };
}

/** Repo-relative default location of the committed pins. */
export function defaultImagePinsPath(): string {
  return fromFileUrl(new URL("./pins.json", import.meta.url));
}

export async function loadImagePins(path?: string): Promise<ImagePins> {
  const source = path ?? defaultImagePinsPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(source));
  } catch (cause) {
    throw new TypeError(`image pins at ${source} are unreadable`, { cause });
  }
  return validateImagePins(parsed);
}
