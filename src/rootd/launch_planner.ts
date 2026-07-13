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
import type { SnapshotLoadParams, VmConfig } from "@nullstyle/firecracker";
import {
  type ArtifactCache,
  ArtifactCacheError,
  KERNEL_FILE_NAME,
  ROOTFS_FILE_NAME,
} from "../../images/cache.ts";
import type { GuestNetworkConfig } from "../agent/personalize.ts";
import { type TemplateStore, TemplateStoreError } from "./template/mod.ts";
import {
  compareFirecrackerVersions,
  firecrackerSupportsSnapshotRestore,
} from "./firecracker_version.ts";
import type {
  ArtifactReference,
  SandboxRecord,
  SandboxResources,
} from "../state/model.ts";
import type {
  ColdSupervisorLaunchPlan,
  ReclaimHook,
  RestoreSupervisorLaunchPlan,
  SupervisorLaunchPlan,
  SupervisorLaunchPlanner,
} from "./supervisor_core.ts";
import type { SupervisorLaunchRequest } from "./supervisor_core_api.ts";
import { SupervisorError } from "./supervisor_core_api.ts";
import { NetworkReclaimHook, parseAllowNet } from "./network/mod.ts";
import type {
  DnsmasqController,
  EgressController,
  NetworkController,
  PortForwardController,
  SubnetAllocation,
  SubnetAllocator,
} from "./network/mod.ts";

/** Guest AF_VSOCK port studioboxd listens on (see overlay-init). */
export const DEFAULT_AGENT_VSOCK_PORT = 1024;
/** Fresh per-boot overlay size; matches the M5 boot-gate recipe. */
export const DEFAULT_OVERLAY_SIZE_BYTES = 256 * 1024 * 1024;
/** In-jail file names (short: they prefix the host-view sun_path). */
const KERNEL_JAIL_PATH = "/vmlinux";
const ROOTFS_JAIL_PATH = "/rootfs.ext4";
const OVERLAY_JAIL_PATH = "/overlay.ext4";
/** In-jail snapshot-restore artifact names (snapshot-restore §4 step 2/3). */
const SNAPSHOT_JAIL_PATH = "/snapshot";
const MEM_JAIL_PATH = "/mem";
/** In-jail vsock socket name — short on purpose (host view is ~104-byte). */
const VSOCK_JAIL_PATH = "v.sock";
/** Guest NIC the restore's `network_overrides`/`personalize` re-point (§4). */
const GUEST_IFACE = "eth0";
const CREDENTIAL_BYTES = 32;
const GUEST_CID = 3;
/** Dotted `/30` netmask for the kernel `ip=` cmdline token (§4). */
const NETMASK_30_DOTTED = "255.255.255.252";

/**
 * The Tier-B network dataplane the planner wires into each non-netless launch
 * (DESIGN networking-dataplane.md §3, §4, §W4). Every field is one of the W1
 * injected-runner controllers; when the whole object is absent the planner is
 * vsock-only (no NIC), exactly as before M10.
 */
export interface LaunchPlannerDataplane {
  /** Hands out (and reclaims) the per-sandbox `/30` subnet + TAP slot. */
  readonly allocator: SubnetAllocator;
  /** Provisions / tears down the host-side TAP + gateway address. */
  readonly network: NetworkController;
  /** Spawns / reaps the per-sandbox dnsmasq. */
  readonly dnsmasq: DnsmasqController;
  /** Applies / reclaims the per-sandbox nftables egress table. */
  readonly egress: EgressController;
  /**
   * Reclaims the per-sandbox exposeHttp forward table (`sbx_pf_<id>`) on
   * terminate + cold reconcile (§6, §8). exposeHttp itself INSTALLS forwards
   * through {@linkcode import("./supervisor_core.ts").SupervisorCore} (which
   * holds the same controller); the planner only needs it to compose the
   * {@linkcode NetworkReclaimHook}. Absent ⇒ no port-forward reclaim step.
   */
  readonly portForward?: PortForwardController;
  /** Upstream resolver the per-sandbox dnsmasq forwards to (`--server`). */
  readonly upstreamDns: string;
}

/** What {@linkcode GoldenArtifactLaunchPlanner.#provisionNetwork} installed. */
interface ProvisionedNetwork {
  readonly alloc: SubnetAllocation;
  /** Resource fields journaled onto the record BEFORE boot (§9). */
  readonly resources: Partial<SandboxResources>;
  /** Best-effort unwind of everything provisioned, for a later-step failure. */
  readonly unwind: () => Promise<void>;
}

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
  /**
   * The Tier-B network dataplane (§W4). When present a non-netless launch is
   * given a TAP-backed `eth0` NIC, a sealed nftables egress table, and a
   * per-sandbox dnsmasq; when absent (or for a `netless` request) the launch is
   * vsock-only exactly as before M10.
   */
  readonly dataplane?: LaunchPlannerDataplane;
  /**
   * Launch strategy (snapshot-restore §5.1). `"cold"` (the default) always
   * cold-boots — the byte-identical pre-snapshot path. `"snapshot"` OPTS IN to
   * warm-template restore, but only when a template exists + validates, the
   * request is networked, and a dataplane is configured; otherwise it FALLS SAFE
   * to cold per request (§5.3, §5.4). The Firecracker ≥ v1.16 version gate (§5.5)
   * lives in the caller ({@linkcode import("./main.ts")}) — it only passes
   * `"snapshot"` here on a capable host.
   * @default "cold"
   */
  readonly launchStrategy?: "cold" | "snapshot";
  /**
   * The on-disk warm-template store (snapshot-restore §1.2). Required for the
   * `"snapshot"` strategy to resolve a restore plan; absent ⇒ always cold.
   */
  readonly templateStore?: TemplateStore;
  /**
   * The running studioboxd's `compat/wire.json.schemaSha256`. A template
   * captured under a DIFFERENT schema is stale and rejected (→ cold), because a
   * schema change rolls the compiled agent and thus the whole snapshot. Required
   * with {@linkcode GoldenArtifactLaunchPlannerOptions.templateStore}.
   */
  readonly schemaSha256?: string;
  /**
   * The ACTUAL installed Firecracker version, probed from the binary by the
   * caller ({@linkcode import("./main.ts")}) — NOT a config default
   * (snapshot-restore §5.5, FINDING 3). Two fail-safe gates depend on it:
   * (a) DEFENSE-IN-DEPTH — without a known version ≥ v1.16 (which `vsock_override`
   * needs) the planner resolves COLD even if `launchStrategy` is `"snapshot"`;
   * (b) TEMPLATE COMPAT — a template whose captured `firecrackerVersion` is
   * < v1.16, or newer than this host can restore, is rejected (→ cold; FINDING 5).
   * Required (with the template store) for a restore to resolve; any uncertainty
   * ⇒ cold.
   */
  readonly firecrackerVersion?: string;
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
  readonly #dataplane: LaunchPlannerDataplane | undefined;
  readonly #launchStrategy: "cold" | "snapshot";
  readonly #templateStore: TemplateStore | undefined;
  readonly #schemaSha256: string | undefined;
  readonly #firecrackerVersion: string | undefined;
  readonly #coordinates = new Map<string, AgentLaunchCoordinates>();
  /**
   * ExecutionId → template manifest hash for every restore this process pinned
   * (`templateStore.acquire`). {@linkcode TemplateReclaimHook} consults + clears
   * it so a live restore's template ref is released EXACTLY once on teardown and
   * a cold launch (which pinned nothing) never touches a template refcount.
   */
  readonly #templatePins = new Map<string, string>();

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
    this.#dataplane = options.dataplane;
    this.#launchStrategy = options.launchStrategy ?? "cold";
    this.#templateStore = options.templateStore;
    this.#schemaSha256 = options.schemaSha256;
    this.#firecrackerVersion = options.firecrackerVersion;
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

    // Set once the network dataplane is fully provisioned; the catch runs it so
    // a failure in a LATER step never strands a TAP / dnsmasq / nft table / slot
    // (§8). A failure DURING provisioning unwinds itself before rethrowing.
    let unwindNetwork: (() => Promise<void>) | undefined;
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

      // Provision the Tier-B dataplane (TAP + egress seal + dnsmasq) unless the
      // request is netless or no dataplane is configured. There must be NO
      // window where the guest boots with a NIC but no egress filter, so a
      // provisioning failure fully unwinds before it rethrows (§3, §W4). The
      // SAME provisioned network backs a cold boot, a restore, AND a restore's
      // cold fallback — it is generic per-sandbox, not strategy-specific (§5.3).
      const network = await this.#provisionNetwork(request);
      if (network !== undefined) unwindNetwork = network.unwind;

      // The credential the host presents to studioboxd — the SAME bytes the
      // cold cmdline bakes AND the restore injects over `personalize`, returned
      // by every openBridge grant (PLAN.md §M8; snapshot-restore §2.3).
      this.#coordinates.set(request.executionId, {
        sandboxId: request.sandboxId,
        executionId: request.executionId,
        credential,
        vsockPort: this.#agentVsockPort,
      });

      // Snapshot-restore is OPT-IN and resolved BELOW the supervisor surface
      // (hard rule 1). Only a snapshot-strategy, networked request with a valid
      // template resolves to a restore plan; everything else falls SAFE to the
      // byte-identical cold plan (§5.3, §5.4).
      if (await this.#shouldRestore(request, manifestHash, network)) {
        try {
          return await this.#resolveRestorePlan(
            request,
            manifestHash,
            setDir,
            credential,
            // #shouldRestore guarantees a provisioned network for a restore.
            network!,
            overlayPath,
          );
        } catch (error) {
          // TOCTOU: the template validated in #shouldRestore but vanished /
          // corrupted before we could resolve + pin it (a concurrent GC). A
          // template problem NEVER fails a create (§5.3): drop any partial pin
          // and fall SAFE to a cold plan reusing the same provisioned network.
          if (!(error instanceof TemplateStoreError)) throw error;
          await this.#releaseTemplatePin(request.executionId).catch(() => {});
        }
      }
      return this.#buildColdPlan(
        request,
        manifestHash,
        setDir,
        credential,
        network,
        overlayPath,
      );
    } catch (error) {
      // The plan never reached the journal, so nothing else will release
      // this belt: undo the acquire and drop the coordinates/overlay, then
      // best-effort unwind any network state provisioned before the throw.
      await this.#cache.release(manifestHash).catch(() => {});
      this.#coordinates.delete(request.executionId);
      // Release a template ref this resolve pinned (restore branch) before it
      // could reach the reclaim hook — else a failed restore-plan resolve would
      // leak the template pin forever.
      await this.#releaseTemplatePin(request.executionId).catch(() => {});
      await Deno.remove(this.#overlayPath(request.executionId)).catch(() => {});
      if (unwindNetwork !== undefined) await unwindNetwork().catch(() => {});
      throw error;
    }
  }

  /**
   * Would this request resolve to a warm-template restore? Snapshot is opt-in
   * and FAILS SAFE toward cold (§5.3, §5.4, §5.5): it requires the `"snapshot"`
   * strategy, a networked request (a restore re-points `eth0` via
   * `network_overrides`, so netless / vsock-only is always cold), a configured
   * template store + running schema, and a template that PRESENT-AND-VALIDATES
   * under that schema. A real I/O fault reading the template is swallowed to
   * cold — a template problem must never fail a create.
   */
  async #shouldRestore(
    request: SupervisorLaunchRequest,
    manifestHash: string,
    network: ProvisionedNetwork | undefined,
  ): Promise<boolean> {
    const store = this.#templateStore;
    const schema = this.#schemaSha256;
    const hostFc = this.#firecrackerVersion;
    if (
      this.#launchStrategy !== "snapshot" ||
      request.netless === true ||
      network === undefined ||
      store === undefined ||
      schema === undefined ||
      // FINDING 3 (defense-in-depth): a restore needs `vsock_override`, so
      // without a known host Firecracker ≥ v1.16 the strategy FALLS SAFE to
      // cold even if the caller selected "snapshot". Any uncertainty ⇒ cold.
      hostFc === undefined ||
      !firecrackerSupportsSnapshotRestore(hostFc)
    ) {
      // Only a "snapshot" deploy that DECLINES is worth a line; the default
      // cold path stays silent (it would log on every create otherwise).
      if (this.#launchStrategy === "snapshot") {
        const reason = request.netless === true
          ? "netless (always cold, §9.5)"
          : network === undefined
          ? "no dataplane"
          : store === undefined
          ? "no template store"
          : schema === undefined
          ? "no running schema"
          : hostFc === undefined
          ? "host firecracker version unknown"
          : `host firecracker ${hostFc} < v1.16`;
        console.error(`[rootd] snapshot strategy fell back to cold: ${reason}`);
      }
      return false;
    }
    try {
      // Validity (schema / size / present), then Firecracker compatibility
      // (FINDING 5): a template captured under an fc version the host cannot
      // restore is rejected → cold. `isValid` is kept (not folded into a single
      // `resolve`) so the metadata read is a distinct step — the fc gate layers
      // on top of the existing validity contract.
      if (!(await store.isValid(manifestHash, { schemaSha256: schema }))) {
        console.error(
          `[rootd] snapshot strategy fell back to cold: template invalid or absent`,
        );
        return false;
      }
      const metadata = await store.readMetadata(manifestHash);
      const compatible = this.#templateFirecrackerCompatible(
        metadata.firecrackerVersion,
        hostFc,
      );
      if (!compatible) {
        console.error(
          `[rootd] snapshot strategy fell back to cold: template firecracker ${metadata.firecrackerVersion} incompatible with host ${hostFc}`,
        );
      }
      return compatible;
    } catch (error) {
      // A real I/O fault on the template dir: fail safe toward cold (§5.5).
      console.error(
        `[rootd] snapshot strategy fell back to cold: template read error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Is a template captured under `templateFc` restorable on this `hostFc` host
   * (snapshot-restore §5.5, FINDING 5)? Requires the template support
   * `vsock_override` (≥ v1.16) AND the host be able to load it (host fc ≥ the
   * template's capture version — a Firecracker snapshot restores on the same or
   * newer minor, never older). Any uncertainty ⇒ `false` (cold).
   */
  #templateFirecrackerCompatible(templateFc: string, hostFc: string): boolean {
    return firecrackerSupportsSnapshotRestore(templateFc) &&
      compareFirecrackerVersions(hostFc, templateFc) >= 0;
  }

  /**
   * Build a COLD launch plan (the byte-identical pre-snapshot path). Pure over
   * the already-minted `credential`, the already-provisioned `network`, and the
   * fresh `overlayPath` — those side effects live in {@linkcode
   * GoldenArtifactLaunchPlanner.resolve}. It is ALSO the restore fallback recipe
   * (§5.3): a template problem then boots exactly today's cold create.
   */
  #buildColdPlan(
    request: SupervisorLaunchRequest,
    manifestHash: string,
    setDir: string,
    credential: Uint8Array,
    network: ProvisionedNetwork | undefined,
    overlayPath: string,
  ): ColdSupervisorLaunchPlan {
    const bootArgs = [
      // `quiet loglevel=1` suppresses the kernel's verbose boot printk. Each
      // printk blocks on the ttyS0 UART, so a chatty boot is a well-known
      // Firecracker slow-start cause; init's own echoes still reach ttyS0.
      "console=ttyS0",
      "quiet",
      "loglevel=1",
      "reboot=k",
      "panic=1",
      "pci=off",
      "root=/dev/vda",
      "ro",
      "init=/sbin/overlay-init",
      `studiobox.vsock_port=${this.#agentVsockPort}`,
      `studiobox.token=${toHex(credential)}`,
    ];
    if (network !== undefined) {
      // Kernel `ip=` is the belt for CONFIG_IP_PNP kernels; the studiobox.*
      // tokens are what W5's overlay-init configures eth0 from explicitly.
      bootArgs.push(
        `ip=${network.alloc.guestIp}::${network.alloc.hostIp}:${NETMASK_30_DOTTED}::${GUEST_IFACE}:off`,
        `studiobox.ip=${network.alloc.guestCidr}`,
        `studiobox.gw=${network.alloc.hostIp}`,
        `studiobox.dns=${network.alloc.hostIp}`,
      );
    }

    const config: VmConfig = {
      machine_config: {
        // The per-launch request.vcpus (validated 1..64 by
        // validateLaunchRequest) wins over the planner's static default, so a
        // caller's requested vCPU count actually reaches the guest.
        vcpu_count: request.vcpus ?? this.#vcpuCount,
        mem_size_mib: this.#memSizeMib,
      },
      boot_source: {
        kernel_image_path: KERNEL_JAIL_PATH,
        boot_args: bootArgs.join(" "),
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
      // Exactly one TAP-backed NIC; the adapter's putNetworkInterface needs
      // the TAP to already exist, which #provisionNetwork guaranteed (§4).
      ...(network === undefined ? {} : {
        network_interfaces: [
          {
            iface_id: GUEST_IFACE,
            host_dev_name: network.alloc.tapName,
            guest_mac: network.alloc.guestMac,
          },
        ],
      }),
    };

    return {
      jailer: this.#jailerOptions(),
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
      // The guest bakes exactly this credential (studiobox.token) at boot;
      // surfacing it on the plan lets the supervisor return it in every
      // openBridge grant so the tunnel client can authenticate to studioboxd
      // (PLAN.md §M8).
      agentCredential: credential.slice(),
      artifact: { manifestHash, arch: this.#arch },
      // Journaled in the staging→booting commit (BEFORE boot) so a cold
      // reconcile can reclaim the TAP / egress table / dnsmasq from the
      // journal alone (§8, §9).
      ...(network === undefined ? {} : { resources: network.resources }),
    };
  }

  /**
   * Build a RESTORE launch plan (snapshot-restore §4): resolve + PIN the warm
   * template (`templateStore.acquire`, released on teardown by {@linkcode
   * TemplateReclaimHook}), stage snapshot/mem/rootfs(ro)/overlay-COPY into the
   * fresh jail, and emit the `SnapshotLoadParams` re-pointing `eth0` to this
   * sandbox's TAP + rebinding the in-jail vsock UDS. It carries a `fallback`
   * cold recipe REUSING this same provisioned network (§5.3) so a restore or
   * personalize failure never fails the create. The credential is injected over
   * `personalize` after resume; the fallback bakes the SAME credential on the
   * cmdline, so openBridge returns one credential that works for either path.
   */
  async #resolveRestorePlan(
    request: SupervisorLaunchRequest,
    manifestHash: string,
    setDir: string,
    credential: Uint8Array,
    network: ProvisionedNetwork,
    overlayPath: string,
  ): Promise<RestoreSupervisorLaunchPlan> {
    const store = this.#templateStore!;
    const schema = this.#schemaSha256!;
    const hostFc = this.#firecrackerVersion;
    const template = await store.resolve(manifestHash, {
      schemaSha256: schema,
    });
    // FINDING 5 (TOCTOU-safe re-check): the template validated in #shouldRestore,
    // but re-assert Firecracker compatibility here, BEFORE the pin, so a template
    // captured under an incompatible fc version resolves to COLD via resolve()'s
    // TemplateStoreError catch (§5.3) rather than being restored.
    if (
      hostFc === undefined ||
      !this.#templateFirecrackerCompatible(
        template.metadata.firecrackerVersion,
        hostFc,
      )
    ) {
      throw new TemplateStoreError(
        `template ${manifestHash} captured under firecracker ${template.metadata.firecrackerVersion} ` +
          `is incompatible with host firecracker ${hostFc ?? "(unknown)"}`,
      );
    }
    // Pin the template BEFORE the restore is journaled/spawned so GC can never
    // reap it out from under a live restore (§1.2). The pin is released exactly
    // once on teardown (TemplateReclaimHook) or by resolve()'s catch on failure.
    await store.acquire(manifestHash);
    this.#templatePins.set(request.executionId, manifestHash);

    const guestNetwork: GuestNetworkConfig = {
      guestCidr: network.alloc.guestCidr,
      gateway: network.alloc.hostIp,
      dns: network.alloc.hostIp,
      iface: GUEST_IFACE,
    };

    const snapshot: SnapshotLoadParams = {
      snapshot_path: SNAPSHOT_JAIL_PATH,
      mem_backend: { backend_type: "File", backend_path: MEM_JAIL_PATH },
      resume_vm: true,
      // `clock_realtime` re-seeds the guest wall-clock on resume so restores of
      // one snapshot don't all share its frozen clock — but Firecracker only
      // supports it on x86_64; the aarch64 VMM REJECTS the snapshot load with
      // "clock_realtime is not supported on aarch64" (mirrors SendCtrlAltDel
      // being x86_64-only). On aarch64 the restored guest inherits the captured
      // clock until it re-syncs — acceptable for 1.0.
      ...(this.#arch === "x86_64" ? { clock_realtime: true } : {}),
      network_overrides: [
        { iface_id: GUEST_IFACE, host_dev_name: network.alloc.tapName },
      ],
      vsock_override: { uds_path: VSOCK_JAIL_PATH },
    };

    return {
      kind: "restore",
      jailer: this.#jailerOptions(),
      // Copy mode is forced by the adapter; the overlay is a per-restore COPY of
      // the template's EXACT captured overlay (§3), rootfs is shared read-only.
      stage: [
        { hostPath: template.snapshotPath, jailPath: SNAPSHOT_JAIL_PATH },
        { hostPath: template.memPath, jailPath: MEM_JAIL_PATH },
        {
          hostPath: join(setDir, ROOTFS_FILE_NAME),
          jailPath: ROOTFS_JAIL_PATH,
        },
        {
          hostPath: template.overlayPath,
          jailPath: OVERLAY_JAIL_PATH,
          readWrite: true,
        },
      ],
      snapshot,
      readinessTimeoutMs: this.#readinessTimeoutMs,
      agentVsockPort: this.#agentVsockPort,
      agentCredential: credential.slice(),
      artifact: { manifestHash, arch: this.#arch },
      resources: network.resources,
      personalize: {
        network: guestNetwork,
        // The tunnel client presents request.bootNonce at authenticate, so the
        // guest must bind exactly it; the sandbox id is the rootd sandbox id.
        bootNonce: request.bootNonce.slice(),
        sandboxId: request.sandboxId,
      },
      // The fallback reuses the SAME provisioned network (already journaled by
      // the staging→booting commit) and a fresh unformatted overlay — cold
      // semantics — baking the same credential so cold readiness proves it (§5.3).
      fallback: this.#buildColdPlan(
        request,
        manifestHash,
        setDir,
        credential,
        network,
        overlayPath,
      ),
    };
  }

  /** The jailer options shared by every plan this planner emits. */
  #jailerOptions(): SupervisorLaunchPlan["jailer"] {
    return {
      jailerBin: this.#jailerBin,
      firecrackerBin: this.#firecrackerBin,
      uid: this.#uid,
      gid: this.#gid,
      chrootBaseDir: this.#chrootBaseDir,
      cgroupVersion: this.#cgroupVersion,
    };
  }

  /**
   * Release a template ref an in-flight resolve pinned, clearing the in-process
   * pin so it releases EXACTLY once. This covers ONLY the resolve-failure paths
   * (a throw BEFORE the durable `templatePinned` marker reaches the journal): an
   * execution that never pinned ⇒ no-op. The durable teardown path is
   * {@linkcode GoldenArtifactLaunchPlanner.templateReclaimHook}, which reads the
   * record — not this map.
   */
  async #releaseTemplatePin(executionId: string): Promise<void> {
    const hash = this.#templatePins.get(executionId);
    if (hash === undefined) return;
    this.#templatePins.delete(executionId);
    await this.#releaseTemplateByHash(hash);
  }

  /**
   * Decrement a template's refcount, gone-tolerant like {@linkcode
   * ArtifactReclaimHook}: a missing / below-zero template refcount is swallowed,
   * never turned into a quarantine. Shared by the resolve-failure path (keyed off
   * the in-process pin) and the durable teardown hook (keyed off the record).
   */
  async #releaseTemplateByHash(hash: string): Promise<void> {
    const store = this.#templateStore;
    if (store === undefined) return;
    try {
      if ((await store.refcount(hash)) > 0) await store.release(hash);
    } catch (error) {
      if (!(error instanceof TemplateStoreError)) throw error;
    }
  }

  /**
   * Provision the per-sandbox Tier-B dataplane, or `undefined` when the launch
   * is `netless` or no dataplane is configured (the vsock-only path). Ordered
   * TAP → egress seal → dnsmasq (§3, §5): the egress table's wildcard sets must
   * exist before dnsmasq references them. Any failure unwinds everything it
   * installed — in reverse — before rethrowing, so a failed launch never leaves
   * a TAP up with no egress filter (§8).
   */
  async #provisionNetwork(
    request: SupervisorLaunchRequest,
  ): Promise<ProvisionedNetwork | undefined> {
    const dataplane = this.#dataplane;
    if (dataplane === undefined || request.netless === true) return undefined;

    // a. Lowest free slot → TAP name + `/30` addresses (journaled below).
    const alloc = dataplane.allocator.allocate(request.executionId);
    let pidfile: string | undefined;
    try {
      // b. Host-side TAP owned by the firecracker uid/gid, gateway addr, up.
      await dataplane.network.provision(alloc, {
        uid: this.#uid,
        gid: this.#gid,
      });
      // c. Unset allowNet ⇒ unrestricted; a list ⇒ restricted (still a table).
      const spec = parseAllowNet(request.allowNet);
      // d. Seal egress on the TAP. An EgressApplyError (or ANY throw) is fatal:
      //    the engine already installed the deny-all seal, so the catch below
      //    tears the TAP down + releases the slot and the launch aborts.
      const applied = await dataplane.egress.apply(
        spec,
        {
          sandboxId: request.sandboxId,
          tapDevice: alloc.tapName,
          guestIp: alloc.guestIp,
        },
        { resolvers: [alloc.hostIp] },
      );
      // e. Spawn the per-sandbox dnsmasq; its pidfile is the teardown key.
      const instance = await dataplane.dnsmasq.install(alloc, {
        fragment: applied.dnsmasqFragment,
        upstream: dataplane.upstreamDns,
      });
      pidfile = instance.pidfile;
      return {
        alloc,
        resources: {
          tapName: alloc.tapName,
          hostIp: alloc.hostIp,
          guestIp: alloc.guestIp,
          subnet: alloc.subnet,
          dnsmasqPidfile: pidfile,
        },
        unwind: () => this.#unwindNetwork(request.sandboxId, alloc),
      };
    } catch (error) {
      await this.#unwindNetwork(request.sandboxId, alloc);
      throw error;
    }
  }

  /**
   * Best-effort reverse of {@linkcode GoldenArtifactLaunchPlanner.#provisionNetwork}
   * (§8 reclaim order: dnsmasq → egress table → TAP → slot). Each step tolerates
   * "already gone" so a partial provision (or a later-step failure) reclaims
   * exactly what was installed, with no TAP / dnsmasq / nft / slot leak.
   */
  async #unwindNetwork(
    sandboxId: string,
    alloc: SubnetAllocation,
  ): Promise<void> {
    const dataplane = this.#dataplane;
    if (dataplane === undefined) return;
    // Reap by the DETERMINISTIC pidfile path (derived from the slot), never a
    // caller-passed handle: dnsmasq.install writes the `<slot>.conf` BEFORE it
    // spawns and can throw before returning a pidfile, so keying off the slot is
    // the only way to unlink a conf-file a mid-install failure left behind. reap
    // reads the pidfile (absent ⇒ no signal) and unlinks both pid + conf.
    await dataplane.dnsmasq.reap(dataplane.dnsmasq.pidfilePath(alloc.slot))
      .catch(() => {});
    // Reclaim the egress table UNCONDITIONALLY (not gated on a "did apply
    // return?" flag): EgressController.apply installs the deny-all SEAL table
    // (`sbx_eg_<id>`) and THEN throws on its failure paths, so on a throw the
    // seal is already live even though apply never returned. reclaim is
    // gone-tolerant (an absent table is a no-op), so this is safe when apply
    // installed nothing and load-bearing when it sealed-then-threw.
    await dataplane.egress.reclaim({ sandboxId }).catch(() => {});
    await dataplane.network.teardown(alloc).catch(() => {});
    dataplane.allocator.release(alloc.slot);
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

  /**
   * The {@linkcode ReclaimHook} that reaps a terminating record's Tier-B
   * dataplane (dnsmasq → egress table → TAP → slot), keyed off the journaled
   * `resources.tapName`. `undefined` when no dataplane is configured (nothing
   * to reclaim). Register it BEFORE {@linkcode GoldenArtifactLaunchPlanner.reclaimHook}
   * so the network is torn down before the overlay/refcount (§8).
   */
  get networkReclaimHook(): NetworkReclaimHook | undefined {
    if (this.#dataplane === undefined) return undefined;
    return new NetworkReclaimHook({
      allocator: this.#dataplane.allocator,
      network: this.#dataplane.network,
      dnsmasq: this.#dataplane.dnsmasq,
      egress: this.#dataplane.egress,
      // The exposeHttp forward table (`sbx_pf_<id>`) is reaped alongside the
      // rest of the dataplane (§8 step 3). Absent ⇒ pre-W6 config, no step.
      ...(this.#dataplane.portForward === undefined
        ? {}
        : { portForward: this.#dataplane.portForward }),
    });
  }

  /**
   * The {@linkcode ReclaimHook} that releases a restored sandbox's warm-template
   * refcount (`templateStore.release`) when its record reaches a terminal phase
   * (snapshot-restore §1.2, §7; FINDING 1). `undefined` when no template store is
   * configured (nothing to reclaim). Register it alongside the other reclaim
   * hooks.
   *
   * The DURABLE record field is the SOURCE OF TRUTH — NOT the in-process pin map,
   * which is empty after a rootd crash. It releases the refcount iff the record
   * journaled `templatePinned` (so a COLD record, which pinned nothing, is a
   * no-op), keyed off the SAME manifest hash the artifact reference carries. This
   * mirrors {@linkcode ArtifactReclaimHook} EXACTLY: because the marker + hash
   * live in the SURVIVING record, a fresh planner (empty map) after a destructive
   * reconcile still drives the refcount to zero. The in-process pin is cleared
   * opportunistically for a live same-process teardown. Best-effort: a missing /
   * below-zero template refcount is swallowed, never a quarantine.
   */
  get templateReclaimHook(): ReclaimHook | undefined {
    if (this.#templateStore === undefined) return undefined;
    const pins = this.#templatePins;
    const releaseByHash = (hash: string): Promise<void> =>
      this.#releaseTemplateByHash(hash);
    return {
      name: "template-refcount",
      async reclaim(record: SandboxRecord): Promise<void> {
        // Only a record that durably pinned a template releases one; a cold
        // record pinned nothing.
        if (record.templatePinned !== true) return;
        const hash = record.artifact?.manifestHash;
        if (hash === undefined) return;
        // Clear the in-process optimization pin (same-process teardown); a
        // fresh planner after a crash simply has no entry — harmless.
        const executionId = record.machine?.executionId;
        if (executionId !== undefined) pins.delete(executionId);
        await releaseByHash(hash);
      },
    };
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
