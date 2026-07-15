/**
 * Guest image toolchain: pinned kernel/rootfs artifact identity, the per-boot
 * overlay, and the content-addressed artifact cache.
 *
 * Published as the `./images` subpath of `@nullstyle/studiobox`. This barrel
 * re-exports the public surface of the `images/` modules; it has no
 * dependency on the capnp wire layer.
 *
 * @module
 */

// Pins: the committed input pins that define an artifact set.
export { ARTIFACT_ARCHES, loadImagePins, validateImagePins } from "./pins.ts";
export type { ArtifactArch, ImagePins } from "./pins.ts";

// Kernel: fetch-and-verify against the pinned sha256.
export {
  ensureKernel,
  KernelVerificationError,
  verifyKernelFile,
} from "./kernel.ts";

// Artifact manifest: pin-addressed identity for a kernel+rootfs set.
export {
  manifestFromPins,
  manifestHash,
  readArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest,
} from "./manifest.ts";
export type { ArtifactManifest, RootfsIdentity } from "./manifest.ts";

// Content manifest: canonical sorted listing used for rootfs identity.
export {
  collectContentManifest,
  contentManifestHash,
  formatContentManifest,
  parseContentManifest,
} from "./content_manifest.ts";
export type { ContentEntry } from "./content_manifest.ts";

// Overlay: the host half of the per-boot overlay contract (the guest half is
// the `overlay-init` stub the rootfs bakes in).
export {
  assertOverlaySizeBytes,
  createSparseOverlay,
  OVERLAY_MAX_BYTES,
  OVERLAY_MIN_BYTES,
} from "./overlay.ts";

// Cache: manifest-hash-addressed artifact sets with refcount-aware GC.
export {
  ArtifactCache,
  ArtifactCacheError,
  defaultArtifactCacheRoot,
} from "./cache.ts";
export type { ArtifactReferenceReader } from "./cache.ts";
