/**
 * `manifest.json` for a built artifact set (PLAN.md M4 item 2, DESIGN.md §7).
 *
 * The manifest records every input pin an artifact set was built from plus
 * the observed rootfs identity. The **manifest hash** — the cache key under
 * `~/.studiobox/artifacts/<hash>/` and, later, the artifact component of
 * `ContractIdentity` — is a sha256 over the canonical JSON of the *input
 * pins only*: kernel sha, rootfs recipe (suite/variant/snapshot epoch/
 * packages/sandbox user/image size), builder + overlay-init script shas,
 * guest Deno pin, and agent binary sha. Build *outputs* (`rootfs.identity`,
 * `rootfs.sizeBytes`, `createdAt`) are excluded so that rebuilding from
 * identical pins lands in the same cache slot; output drift across builds
 * from the same pins is a verification failure, not a new identity.
 *
 * Reading is strict in the `src/state/model.ts` style: bounded fields,
 * unknown keys rejected, fail closed.
 */

import type { ArtifactArch, ImagePins, SandboxUserPin } from "./pins.ts";
import { assertArtifactArch, validateSandboxUser } from "./pins.ts";
import {
  assertKeys,
  assertRecord,
  assertSha256,
  assertText,
  assertTimestamp,
  assertUnsignedInteger,
  canonicalJson,
  sha256HexOfText,
} from "./validate.ts";

export const ARTIFACT_MANIFEST_VERSION = 1 as const;

export interface KernelArtifact {
  version: string;
  url: string;
  sha256: string;
}

export interface RootfsRecipe {
  suite: string;
  variant: string;
  snapshotEpoch: string;
  mirror: string;
  packages: string[];
  imageSizeMiB: number;
  sandboxUser: SandboxUserPin;
  /** sha256 of `images/build_rootfs.sh` as run. */
  builderScriptSha256: string;
  /** sha256 of the overlay-init stub baked into the image. */
  overlayInitSha256: string;
}

export interface GuestDenoArtifact {
  version: string;
  sha256: string;
}

/**
 * How the golden rootfs bytes are identified.
 *
 * `imageBytes` — sha256 of the raw ext4 image (only when builds are
 * byte-reproducible). `contentManifest` — sha256 of the canonical sorted
 * content manifest (`content_manifest.ts`: path, type, mode, uid/gid, size,
 * per-file sha256), the documented fallback when raw-image byte identity is
 * not achievable across builds.
 */
export interface RootfsIdentity {
  kind: "imageBytes" | "contentManifest";
  sha256: string;
}

export interface RootfsArtifact {
  recipe: RootfsRecipe;
  guestDeno: GuestDenoArtifact;
  identity: RootfsIdentity;
  sizeBytes: number;
}

export interface AgentBinaryArtifact {
  /** File name inside the artifact set, e.g. `studioboxd`. */
  filename: string;
  sha256: string;
  /**
   * True while the committed placeholder stands in for the compiled
   * studioboxd (the M3/M5 swap point — see `images/agent/`).
   */
  placeholder: boolean;
}

export interface ArtifactManifest {
  schemaVersion: typeof ARTIFACT_MANIFEST_VERSION;
  arch: ArtifactArch;
  kernel: KernelArtifact;
  rootfs: RootfsArtifact;
  agentBinary: AgentBinaryArtifact;
  createdAt: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IDENTITY_KINDS = ["imageBytes", "contentManifest"] as const;

export function assertArtifactFileName(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !FILENAME_PATTERN.test(value)) {
    throw new TypeError(
      `${field} must be a plain file name (no separators, at most 64 chars)`,
    );
  }
}

function validateKernelArtifact(value: unknown): KernelArtifact {
  const kernel = assertRecord(value, "manifest kernel") as Partial<
    KernelArtifact
  >;
  assertKeys(kernel, ["version", "url", "sha256"], "manifest kernel");
  if (
    typeof kernel.version !== "string" || !VERSION_PATTERN.test(kernel.version)
  ) {
    throw new TypeError("manifest kernel version must be X.Y.Z");
  }
  assertText(kernel.url, "manifest kernel url", 2_048);
  assertSha256(kernel.sha256, "manifest kernel sha256");
  return { version: kernel.version, url: kernel.url, sha256: kernel.sha256 };
}

function validateRecipe(value: unknown): RootfsRecipe {
  const recipe = assertRecord(value, "rootfs recipe") as Partial<RootfsRecipe>;
  assertKeys(recipe, [
    "suite",
    "variant",
    "snapshotEpoch",
    "mirror",
    "packages",
    "imageSizeMiB",
    "sandboxUser",
    "builderScriptSha256",
    "overlayInitSha256",
  ], "rootfs recipe");
  assertText(recipe.suite, "recipe suite", 64);
  assertText(recipe.variant, "recipe variant", 64);
  if (
    typeof recipe.snapshotEpoch !== "string" ||
    !/^\d{8}T\d{6}Z$/.test(recipe.snapshotEpoch)
  ) {
    throw new TypeError("recipe snapshotEpoch must match YYYYMMDDTHHMMSSZ");
  }
  assertText(recipe.mirror, "recipe mirror", 2_048);
  if (!Array.isArray(recipe.packages) || recipe.packages.length > 128) {
    throw new TypeError("recipe packages must be an array of at most 128");
  }
  for (let i = 0; i < recipe.packages.length; i++) {
    assertText(recipe.packages[i], `recipe packages[${i}]`, 128);
    if (i > 0 && recipe.packages[i - 1] >= recipe.packages[i]) {
      throw new TypeError("recipe packages must be sorted and unique");
    }
  }
  assertUnsignedInteger(recipe.imageSizeMiB, "recipe imageSizeMiB", 65_536, 64);
  const sandboxUser = validateSandboxUser(
    recipe.sandboxUser,
    "recipe.sandboxUser",
  );
  assertSha256(recipe.builderScriptSha256, "recipe builderScriptSha256");
  assertSha256(recipe.overlayInitSha256, "recipe overlayInitSha256");
  return {
    suite: recipe.suite,
    variant: recipe.variant,
    snapshotEpoch: recipe.snapshotEpoch,
    mirror: recipe.mirror,
    packages: [...recipe.packages],
    imageSizeMiB: recipe.imageSizeMiB,
    sandboxUser,
    builderScriptSha256: recipe.builderScriptSha256,
    overlayInitSha256: recipe.overlayInitSha256,
  };
}

function validateRootfsArtifact(value: unknown): RootfsArtifact {
  const rootfs = assertRecord(value, "manifest rootfs") as Partial<
    RootfsArtifact
  >;
  assertKeys(
    rootfs,
    ["recipe", "guestDeno", "identity", "sizeBytes"],
    "manifest rootfs",
  );
  const guestDeno = assertRecord(
    rootfs.guestDeno,
    "rootfs guestDeno",
  ) as Partial<GuestDenoArtifact>;
  assertKeys(guestDeno, ["version", "sha256"], "rootfs guestDeno");
  if (
    typeof guestDeno.version !== "string" ||
    !VERSION_PATTERN.test(guestDeno.version)
  ) {
    throw new TypeError("rootfs guestDeno version must be X.Y.Z");
  }
  assertSha256(guestDeno.sha256, "rootfs guestDeno sha256");
  const identity = assertRecord(rootfs.identity, "rootfs identity") as Partial<
    RootfsIdentity
  >;
  assertKeys(identity, ["kind", "sha256"], "rootfs identity");
  if (!IDENTITY_KINDS.includes(identity.kind as RootfsIdentity["kind"])) {
    throw new TypeError("rootfs identity kind is invalid");
  }
  assertSha256(identity.sha256, "rootfs identity sha256");
  assertUnsignedInteger(
    rootfs.sizeBytes,
    "rootfs sizeBytes",
    Number.MAX_SAFE_INTEGER,
    1,
  );
  return {
    recipe: validateRecipe(rootfs.recipe),
    guestDeno: { version: guestDeno.version, sha256: guestDeno.sha256 },
    identity: {
      kind: identity.kind as RootfsIdentity["kind"],
      sha256: identity.sha256,
    },
    sizeBytes: rootfs.sizeBytes,
  };
}

function validateAgentBinary(value: unknown): AgentBinaryArtifact {
  const agent = assertRecord(value, "manifest agentBinary") as Partial<
    AgentBinaryArtifact
  >;
  assertKeys(
    agent,
    ["filename", "sha256", "placeholder"],
    "manifest agentBinary",
  );
  assertArtifactFileName(agent.filename, "agentBinary filename");
  assertSha256(agent.sha256, "agentBinary sha256");
  if (typeof agent.placeholder !== "boolean") {
    throw new TypeError("agentBinary placeholder must be a boolean");
  }
  return {
    filename: agent.filename,
    sha256: agent.sha256,
    placeholder: agent.placeholder,
  };
}

export function validateArtifactManifest(value: unknown): ArtifactManifest {
  const manifest = assertRecord(value, "artifact manifest") as Partial<
    ArtifactManifest
  >;
  assertKeys(manifest, [
    "schemaVersion",
    "arch",
    "kernel",
    "rootfs",
    "agentBinary",
    "createdAt",
  ], "artifact manifest");
  if (manifest.schemaVersion !== ARTIFACT_MANIFEST_VERSION) {
    throw new TypeError("unsupported artifact manifest schema version");
  }
  assertArtifactArch(manifest.arch, "manifest arch");
  assertTimestamp(manifest.createdAt, "manifest createdAt");
  return {
    schemaVersion: ARTIFACT_MANIFEST_VERSION,
    arch: manifest.arch,
    kernel: validateKernelArtifact(manifest.kernel),
    rootfs: validateRootfsArtifact(manifest.rootfs),
    agentBinary: validateAgentBinary(manifest.agentBinary),
    createdAt: manifest.createdAt,
  };
}

/**
 * The exact input-pin subset the manifest hash covers. Build outputs
 * (`rootfs.identity`, `rootfs.sizeBytes`) and `createdAt` are excluded on
 * purpose — see the module doc.
 */
export function manifestPins(manifest: ArtifactManifest): unknown {
  const validated = validateArtifactManifest(manifest);
  return {
    schemaVersion: validated.schemaVersion,
    arch: validated.arch,
    kernel: validated.kernel,
    rootfs: {
      recipe: validated.rootfs.recipe,
      guestDeno: validated.rootfs.guestDeno,
    },
    agentBinary: validated.agentBinary,
  };
}

/** Deterministic sha256 over the canonical JSON of {@link manifestPins}. */
export async function manifestHash(
  manifest: ArtifactManifest,
): Promise<string> {
  return await sha256HexOfText(canonicalJson(manifestPins(manifest)));
}

export interface ManifestFromPinsInputs {
  pins: ImagePins;
  arch: ArtifactArch;
  builderScriptSha256: string;
  overlayInitSha256: string;
  agentBinary: AgentBinaryArtifact;
  identity: RootfsIdentity;
  rootfsSizeBytes: number;
  createdAt?: string;
}

/** Assemble (and validate) a manifest from the committed input pins. */
export function manifestFromPins(
  inputs: ManifestFromPinsInputs,
): ArtifactManifest {
  const { pins, arch } = inputs;
  const kernelPin = pins.kernel.perArch[arch];
  const denoPin = pins.guestDeno.perArch[arch];
  return validateArtifactManifest(
    {
      schemaVersion: ARTIFACT_MANIFEST_VERSION,
      arch,
      kernel: {
        version: pins.kernel.version,
        url: kernelPin.url,
        sha256: kernelPin.sha256,
      },
      rootfs: {
        recipe: {
          suite: pins.rootfs.suite,
          variant: pins.rootfs.variant,
          snapshotEpoch: pins.rootfs.snapshotEpoch,
          mirror: pins.rootfs.mirror,
          packages: [...pins.rootfs.packages],
          imageSizeMiB: pins.rootfs.imageSizeMiB,
          sandboxUser: pins.rootfs.sandboxUser,
          builderScriptSha256: inputs.builderScriptSha256,
          overlayInitSha256: inputs.overlayInitSha256,
        },
        guestDeno: {
          version: pins.guestDeno.version,
          sha256: denoPin.sha256,
        },
        identity: inputs.identity,
        sizeBytes: inputs.rootfsSizeBytes,
      },
      agentBinary: inputs.agentBinary,
      createdAt: inputs.createdAt ?? new Date().toISOString(),
    } satisfies ArtifactManifest,
  );
}

export async function readArtifactManifest(
  path: string,
): Promise<ArtifactManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new TypeError(`artifact manifest at ${path} is unreadable`, {
      cause,
    });
  }
  return validateArtifactManifest(parsed);
}

export async function writeArtifactManifest(
  path: string,
  manifest: ArtifactManifest,
): Promise<void> {
  const validated = validateArtifactManifest(manifest);
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(
      tempPath,
      JSON.stringify(validated, null, 2) + "\n",
    );
    await Deno.rename(tempPath, path);
  } catch (error) {
    await Deno.remove(tempPath).catch(() => {});
    throw error;
  }
}
