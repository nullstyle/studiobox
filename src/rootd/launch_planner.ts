/**
 * The real studiobox-rootd launch planner (PLAN.md §M5).
 *
 * {@linkcode SupervisorCore} resolves every launch through a
 * {@linkcode SupervisorLaunchPlanner}: logical `artifactId`/`allocationId`
 * in, a concrete jailer + stage + `VmConfig` plan out. Until M5 the only
 * planner was the `SBX_SUP_UNAVAILABLE` stub in `main.ts`; this module is
 * the real one. It:
 *
 * 1. resolves the request's `artifactId` to a manifest hash in the M4
 *    artifact cache (`images/cache.ts`);
 * 2. **acquires the cache refcount BEFORE the plan is journaled** — the M4
 *    adversarial note: a GC sweep in the store→journal window would
 *    otherwise reap a just-stored set and fail the launch closed at
 *    staging. The refcount is a belt alongside the journal reference for
 *    the whole sandbox life; {@linkcode ArtifactReclaimHook} releases it
 *    (and deletes the per-boot overlay) when the record reaches a terminal
 *    phase, via the {@linkcode ReclaimHook} seam;
 * 3. stages the golden kernel + rootfs (copy-only, enforced by the adapter)
 *    plus a fresh sparse overlay into the jail, and emits the boot recipe
 *    proven on real hardware in the M5 boot gate: `root=/dev/vda ro`,
 *    `init=/sbin/overlay-init`, and the `studiobox.vsock_port` /
 *    `studiobox.token` cmdline contract the guest `overlay-init` parses
 *    (see `images/overlay_init/overlay-init.sh`);
 * 4. mints a fresh per-boot credential, bakes its hex onto the kernel
 *    cmdline, and remembers the raw bytes so the supervisor's host-side
 *    peer can authenticate to studioboxd over vsock.
 *
 * Everything host-specific stays here; the `SupervisorApi` surface still
 * only ever sees logical identifiers.
 *
 * @module
 */

import { join } from "@std/path";
import type { VmConfig } from "@nullstyle/firecracker";
import {
  type ArtifactCache,
  ArtifactCacheError,
  KERNEL_FILE_NAME,
  ROOTFS_FILE_NAME,
} from "../../images/cache.ts";
import type { ArtifactReference, SandboxRecord } from "../state/model.ts";
import type {
  ReclaimHook,
  SupervisorLaunchPlan,
  SupervisorLaunchPlanner,
} from "./supervisor_core.ts";
import type { SupervisorLaunchRequest } from "./supervisor_core_api.ts";
import { SupervisorError } from "./supervisor_core_api.ts";

/** Guest AF_VSOCK port studioboxd listens on (see overlay-init). */
export const DEFAULT_AGENT_VSOCK_PORT = 1024;
/** Fresh per-boot overlay size; matches the M5 boot-gate recipe. */
export const DEFAULT_OVERLAY_SIZE_BYTES = 256 * 1024 * 1024;
/** In-jail file names (short: they prefix the host-view sun_path). */
const KERNEL_JAIL_PATH = "/vmlinux";
const ROOTFS_JAIL_PATH = "/rootfs.ext4";
const OVERLAY_JAIL_PATH = "/overlay.ext4";
/** In-jail vsock socket name — short on purpose (host view is ~104-byte). */
const VSOCK_JAIL_PATH = "v.sock";
const CREDENTIAL_BYTES = 32;
const GUEST_CID = 3;

/** Everything a {@linkcode GoldenArtifactLaunchPlanner} needs from the host. */
export interface GoldenArtifactLaunchPlannerOptions {
  /** The M4 artifact cache holding the golden set(s). */
  readonly cache: ArtifactCache;
  /**
   * Resolve a request's logical `artifactId` to a cached manifest hash.
   * Defaults to {@linkcode GoldenArtifactLaunchPlannerOptions.manifestHash}
   * for every request (the single-golden-set M5 shape).
   */
  readonly resolveManifestHash?: (
    request: SupervisorLaunchRequest,
  ) => string | Promise<string>;
  /** The single golden set's manifest hash (used by the default resolver). */
  readonly manifestHash?: string;
  /** Architecture the golden set was built for (journaled onto the record). */
  readonly arch: ArtifactReference["arch"];
  /** Absolute path to the `jailer` binary. */
  readonly jailerBin: string;
  /** Absolute path to the `firecracker` binary (name must contain it). */
  readonly firecrackerBin: string;
  /** Uid firecracker drops to inside the jail. */
  readonly uid: number;
  /** Gid firecracker drops to inside the jail. */
  readonly gid: number;
  /** `--chroot-base-dir` (keep short: it prefixes every in-jail socket). */
  readonly chrootBaseDir: string;
  /** Host directory for the fresh per-boot sparse overlays. */
  readonly overlayDir: string;
  /** Cgroup hierarchy version (the package + this planner default to 2). */
  readonly cgroupVersion?: 1 | 2;
  /** Guest vCPU count. @default 1 */
  readonly vcpuCount?: number;
  /** Guest memory in MiB. @default 512 */
  readonly memSizeMib?: number;
  /** Per-boot overlay size. @default {@link DEFAULT_OVERLAY_SIZE_BYTES} */
  readonly overlaySizeBytes?: number;
  /** Guest AF_VSOCK port. @default {@link DEFAULT_AGENT_VSOCK_PORT} */
  readonly agentVsockPort?: number;
  /** Machine-readiness budget for the package API socket. @default 15_000 */
  readonly readinessTimeoutMs?: number;
  /** Seam: random credential bytes (32). Defaults to CSPRNG. */
  readonly mintCredential?: () => Uint8Array;
}

/** The host-side agent coordinates the planner minted for one execution. */
export interface AgentLaunchCoordinates {
  readonly sandboxId: string;
  readonly executionId: string;
  /** Raw credential the host presents to studioboxd `authenticate`. */
  readonly credential: Uint8Array;
  readonly vsockPort: number;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Resolve real jailed launches against a golden artifact set. One instance
 * per rootd process; pair its {@linkcode GoldenArtifactLaunchPlanner.reclaimHook}
 * with the {@linkcode SupervisorCore} `reclaimHooks` so the refcount and
 * overlay are released on terminate.
 */
export class GoldenArtifactLaunchPlanner implements SupervisorLaunchPlanner {
  readonly #cache: ArtifactCache;
  readonly #resolveHash: (
    request: SupervisorLaunchRequest,
  ) => string | Promise<string>;
  readonly #arch: ArtifactReference["arch"];
  readonly #jailerBin: string;
  readonly #firecrackerBin: string;
  readonly #uid: number;
  readonly #gid: number;
  readonly #chrootBaseDir: string;
  readonly #overlayDir: string;
  readonly #cgroupVersion: 1 | 2;
  readonly #vcpuCount: number;
  readonly #memSizeMib: number;
  readonly #overlaySizeBytes: number;
  readonly #agentVsockPort: number;
  readonly #readinessTimeoutMs: number;
  readonly #mintCredential: () => Uint8Array;
  readonly #coordinates = new Map<string, AgentLaunchCoordinates>();

  constructor(options: GoldenArtifactLaunchPlannerOptions) {
    this.#cache = options.cache;
    const fixedHash = options.manifestHash;
    this.#resolveHash = options.resolveManifestHash ??
      ((): string => {
        if (fixedHash === undefined) {
          throw new SupervisorError(
            "SBX_SUP_UNAVAILABLE",
            "launch planner has no golden artifact hash configured",
          );
        }
        return fixedHash;
      });
    this.#arch = options.arch;
    this.#jailerBin = options.jailerBin;
    this.#firecrackerBin = options.firecrackerBin;
    this.#uid = options.uid;
    this.#gid = options.gid;
    this.#chrootBaseDir = options.chrootBaseDir;
    this.#overlayDir = options.overlayDir;
    this.#cgroupVersion = options.cgroupVersion ?? 2;
    this.#vcpuCount = options.vcpuCount ?? 1;
    this.#memSizeMib = options.memSizeMib ?? 512;
    this.#overlaySizeBytes = options.overlaySizeBytes ??
      DEFAULT_OVERLAY_SIZE_BYTES;
    this.#agentVsockPort = options.agentVsockPort ?? DEFAULT_AGENT_VSOCK_PORT;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
    this.#mintCredential = options.mintCredential ??
      (() => crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES)));
  }

  /** Host path of the fresh overlay for one execution. */
  #overlayPath(executionId: string): string {
    return join(this.#overlayDir, `ov-${executionId}.ext4`);
  }

  /**
   * The credential + vsock coordinates minted for a live execution, so the
   * supervisor's host-side peer (M5 tests; the M7 tunnel later) can
   * authenticate to studioboxd. Undefined once the execution is forgotten.
   */
  coordinatesFor(executionId: string): AgentLaunchCoordinates | undefined {
    return this.#coordinates.get(executionId);
  }

  async resolve(
    request: SupervisorLaunchRequest,
  ): Promise<SupervisorLaunchPlan> {
    const manifestHash = await this.#resolveHash(request);
    if (!(await this.#cache.has(manifestHash))) {
      throw new SupervisorError(
        "SBX_SUP_UNAVAILABLE",
        `golden artifact set ${manifestHash} is not cached`,
      );
    }
    // Acquire BEFORE returning: the plan is journaled by SupervisorCore in
    // the staging→booting commit, so this refcount closes the store→journal
    // GC window (M4 adversarial note). ArtifactReclaimHook releases it.
    await this.#cache.acquire(manifestHash);

    try {
      const setDir = this.#cache.setPath(manifestHash);
      const overlayPath = this.#overlayPath(request.executionId);
      await this.#createOverlay(overlayPath);

      const credential = this.#mintCredential();
      if (credential.byteLength !== CREDENTIAL_BYTES) {
        throw new SupervisorError(
          "SBX_SUP_VALIDATION",
          `minted credential must be ${CREDENTIAL_BYTES} bytes`,
        );
      }
      const bootArgs = [
        "console=ttyS0",
        "reboot=k",
        "panic=1",
        "pci=off",
        "root=/dev/vda",
        "ro",
        "init=/sbin/overlay-init",
        `studiobox.vsock_port=${this.#agentVsockPort}`,
        `studiobox.token=${toHex(credential)}`,
      ].join(" ");

      const config: VmConfig = {
        machine_config: {
          vcpu_count: this.#vcpuCount,
          mem_size_mib: this.#memSizeMib,
        },
        boot_source: {
          kernel_image_path: KERNEL_JAIL_PATH,
          boot_args: bootArgs,
        },
        drives: [
          {
            drive_id: "rootfs",
            path_on_host: ROOTFS_JAIL_PATH,
            is_root_device: true,
            is_read_only: true,
          },
          {
            drive_id: "overlay",
            path_on_host: OVERLAY_JAIL_PATH,
            is_root_device: false,
            is_read_only: false,
          },
        ],
        vsock: { guest_cid: GUEST_CID, uds_path: VSOCK_JAIL_PATH },
      };

      this.#coordinates.set(request.executionId, {
        sandboxId: request.sandboxId,
        executionId: request.executionId,
        credential,
        vsockPort: this.#agentVsockPort,
      });

      return {
        jailer: {
          jailerBin: this.#jailerBin,
          firecrackerBin: this.#firecrackerBin,
          uid: this.#uid,
          gid: this.#gid,
          chrootBaseDir: this.#chrootBaseDir,
          cgroupVersion: this.#cgroupVersion,
        },
        stage: [
          {
            hostPath: join(setDir, KERNEL_FILE_NAME),
            jailPath: KERNEL_JAIL_PATH,
          },
          {
            hostPath: join(setDir, ROOTFS_FILE_NAME),
            jailPath: ROOTFS_JAIL_PATH,
          },
          {
            hostPath: overlayPath,
            jailPath: OVERLAY_JAIL_PATH,
            readWrite: true,
          },
        ],
        config,
        readinessTimeoutMs: this.#readinessTimeoutMs,
        agentVsockPort: this.#agentVsockPort,
        artifact: { manifestHash, arch: this.#arch },
      };
    } catch (error) {
      // The plan never reached the journal, so nothing else will release
      // this belt: undo the acquire and drop the coordinates/overlay.
      await this.#cache.release(manifestHash).catch(() => {});
      this.#coordinates.delete(request.executionId);
      await Deno.remove(this.#overlayPath(request.executionId)).catch(() => {});
      throw error;
    }
  }

  /** Create a fresh sparse, unformatted overlay (guest formats it). */
  async #createOverlay(path: string): Promise<void> {
    await Deno.mkdir(this.#overlayDir, { recursive: true });
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new SupervisorError(
          "SBX_SUP_STATE",
          `overlay ${path} already exists (execution id reuse?)`,
          error,
        );
      }
      throw error;
    }
    try {
      await file.truncate(this.#overlaySizeBytes);
    } finally {
      file.close();
    }
  }

  /**
   * The {@linkcode ReclaimHook} that releases the artifact refcount and
   * deletes the per-boot overlay when a record reaches a terminal phase.
   * Register it on the {@linkcode SupervisorCore}.
   */
  get reclaimHook(): ReclaimHook {
    return new ArtifactReclaimHook(this.#cache, (executionId) => {
      this.#coordinates.delete(executionId);
      return this.#overlayPath(executionId);
    });
  }
}

/**
 * Releases the artifact-cache refcount and removes the per-boot overlay for
 * a terminating record. Best-effort: the journal reference (dropped when
 * the record reaches `terminated`) is the authoritative GC guard, so a
 * failed release must NOT quarantine the record — it is logged and swept
 * next reconcile.
 */
export class ArtifactReclaimHook implements ReclaimHook {
  readonly name = "artifact-refcount";
  readonly #cache: ArtifactCache;
  readonly #overlayPathFor: (executionId: string) => string;

  constructor(
    cache: ArtifactCache,
    overlayPathFor: (executionId: string) => string,
  ) {
    this.#cache = cache;
    this.#overlayPathFor = overlayPathFor;
  }

  async reclaim(record: SandboxRecord): Promise<void> {
    const executionId = record.machine?.executionId;
    if (executionId !== undefined) {
      await Deno.remove(this.#overlayPathFor(executionId)).catch(() => {});
    }
    const hash = record.artifact?.manifestHash;
    if (hash === undefined) return;
    try {
      if ((await this.#cache.refcount(hash)) > 0) {
        await this.#cache.release(hash);
      }
    } catch (error) {
      // A missing set or corrupt/zero refcount is fail-closed on the cache
      // side; never turn a best-effort release into a quarantine.
      if (!(error instanceof ArtifactCacheError)) throw error;
    }
  }
}
