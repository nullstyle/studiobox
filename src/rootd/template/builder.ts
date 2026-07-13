/**
 * Warm-template build orchestration for snapshot-restore
 * (`docs/snapshot-restore.md` §1.3, §1.5, WI-5).
 *
 * {@linkcode buildWarmTemplate} is the reusable primitive both the explicit
 * prewarm entrypoint (`tools/build_warm_template.ts`, the `template:build`
 * task) and the lazy-on-first-restore trigger (WI-6) call: given a golden
 * manifest hash it produces a validated template in the {@linkcode
 * TemplateStore}, cold-booting exactly ONE template microVM only when the store
 * has no valid template already (§1.3 lazy-first-use, persistently cached).
 *
 * The actual microVM bake — `Machine.launch` in template mode → wait ready →
 * `Machine.pause` → `Machine.snapshot` → copy `{snapshot, mem, overlay.ext4}`
 * out → kill — lives behind the {@linkcode TemplateBaker} seam
 * (`machine_baker.ts` for the real one) so this orchestration, the store, and
 * their tests are HOST-SAFE: a fake baker that writes placeholder artifact
 * files exercises the whole store/validation/refcount contract with no VM.
 *
 * @module
 */

import type { ArtifactArch } from "../../../images/pins.ts";
import type { TemplateStore } from "./store.ts";

/** Guest AF_VSOCK port studioboxd listens on (mirrors the launch planner). */
export const DEFAULT_TEMPLATE_VSOCK_PORT = 1024;
/** Default guest vCPU count for a template bake. */
export const DEFAULT_TEMPLATE_VCPU_COUNT = 1;
/** Default guest memory (MiB) for a template bake. */
export const DEFAULT_TEMPLATE_MEM_SIZE_MIB = 512;

/** What a {@linkcode TemplateBaker} is asked to capture. */
export interface TemplateBakeRequest {
  /** Golden manifest hash the template is built for (its store key). */
  readonly manifestHash: string;
  readonly arch: ArtifactArch;
  /** Golden artifact set directory (holds `vmlinux` + `rootfs.ext4`). */
  readonly setDir: string;
  readonly vcpuCount: number;
  readonly memSizeMib: number;
  readonly vsockPort: number;
  /** Scratch directory the baker may use for the jail + copied-out artifacts. */
  readonly workDir: string;
  readonly signal?: AbortSignal;
}

/**
 * Host paths of the freshly-captured artifacts. These MUST outlive the template
 * microVM (a real baker copies them out of the chroot BEFORE it kills the VMM,
 * whose disposal reclaims the chroot), because {@linkcode buildWarmTemplate}
 * publishes them into the store after `bake()` returns.
 */
export interface TemplateBakeArtifacts {
  readonly snapshotPath: string;
  readonly memPath: string;
  readonly overlayPath: string;
  /** Firecracker version the snapshot was captured under (≥ v1.16 gate). */
  readonly firecrackerVersion: string;
}

/**
 * The microVM-bake seam. The real implementation ({@linkcode
 * import("./machine_baker.ts").MachineTemplateBaker}) drives `@nullstyle/
 * firecracker` `Machine`; a fake drives the host-safe tests.
 */
export interface TemplateBaker {
  bake(request: TemplateBakeRequest): Promise<TemplateBakeArtifacts>;
}

export interface BuildWarmTemplateOptions {
  readonly store: TemplateStore;
  readonly baker: TemplateBaker;
  /** Golden manifest hash to build a template for. */
  readonly manifestHash: string;
  readonly arch: ArtifactArch;
  /** Golden artifact set directory (holds `vmlinux` + `rootfs.ext4`). */
  readonly setDir: string;
  /** Scratch directory handed to the baker. */
  readonly workDir: string;
  /**
   * The running studioboxd's schema hash (`compat/wire.json.schemaSha256`).
   * Stamped into `template.json` AND used to short-circuit when a valid
   * template already exists under the same schema.
   */
  readonly schemaSha256: string;
  /** @default {@link DEFAULT_TEMPLATE_VCPU_COUNT} */
  readonly vcpuCount?: number;
  /** @default {@link DEFAULT_TEMPLATE_MEM_SIZE_MIB} */
  readonly memSizeMib?: number;
  /** @default {@link DEFAULT_TEMPLATE_VSOCK_PORT} */
  readonly vsockPort?: number;
  /** Created marker for `template.json`; defaults to now. Test seam. */
  readonly createdAt?: string;
  readonly signal?: AbortSignal;
}

export interface BuildWarmTemplateResult {
  readonly hash: string;
  readonly dir: string;
  /**
   * True when this call baked + published a template — a fresh install OR an
   * atomic REPLACE of a present-but-invalid one (FINDING 4). Mutually exclusive
   * with {@linkcode BuildWarmTemplateResult.reused}.
   */
  readonly created: boolean;
  /**
   * True when this call REPLACED a present-but-invalid (corrupt / stale)
   * template rather than freshly installing one. Implies `created` (FINDING 4).
   */
  readonly replaced: boolean;
  /** True when an already-valid template was reused (no bake ran). */
  readonly reused: boolean;
}

/**
 * Ensure a valid warm template exists for `manifestHash`, baking one only if
 * needed. Idempotent + lazy: when the store already holds a template valid
 * under `schemaSha256` it returns `reused: true` without touching a VM.
 * Otherwise it bakes exactly one template microVM through the injected
 * {@linkcode TemplateBaker} and publishes the captured artifacts atomically
 * into the store. (Because the schema hash is folded into the manifest hash —
 * §2.1 — a given hash's template is never schema-stale under normal operation;
 * a golden-set change lands under a NEW hash and thus a new template dir.)
 */
export async function buildWarmTemplate(
  options: BuildWarmTemplateOptions,
): Promise<BuildWarmTemplateResult> {
  const {
    store,
    baker,
    manifestHash,
    arch,
    setDir,
    workDir,
    schemaSha256,
  } = options;
  const vcpuCount = options.vcpuCount ?? DEFAULT_TEMPLATE_VCPU_COUNT;
  const memSizeMib = options.memSizeMib ?? DEFAULT_TEMPLATE_MEM_SIZE_MIB;
  const vsockPort = options.vsockPort ?? DEFAULT_TEMPLATE_VSOCK_PORT;

  if (await store.isValid(manifestHash, { schemaSha256 })) {
    const dir = store.templateDir(manifestHash);
    return {
      hash: manifestHash,
      dir,
      created: false,
      replaced: false,
      reused: true,
    };
  }

  const artifacts = await baker.bake({
    manifestHash,
    arch,
    setDir,
    vcpuCount,
    memSizeMib,
    vsockPort,
    workDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const published = await store.publish({
    metadata: {
      manifestHash,
      schemaSha256,
      firecrackerVersion: artifacts.firecrackerVersion,
      arch,
      vcpuCount,
      memSizeMib,
      vsockPort,
      ...(options.createdAt === undefined
        ? {}
        : { createdAt: options.createdAt }),
    },
    files: {
      snapshot: artifacts.snapshotPath,
      mem: artifacts.memPath,
      overlay: artifacts.overlayPath,
    },
  });

  return {
    hash: published.hash,
    dir: published.dir,
    created: published.created,
    replaced: published.replaced,
    // A replace reports created:true → reused:false. Only a VALID existing
    // template reused untouched (created:false) is a true reuse — a corrupt one
    // was replaced, never a false `reused` (FINDING 4).
    reused: !published.created,
  };
}
