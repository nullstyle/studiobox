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
import type {
  ArtifactReference,
  SandboxRecord,
  SandboxResources,
} from "../state/model.ts";
import type {
  ReclaimHook,
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
/** In-jail vsock socket name — short on purpose (host view is ~104-byte). */
const VSOCK_JAIL_PATH = "v.sock";
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
    this.#dataplane = options.dataplane;
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
      ];

      // Provision the Tier-B dataplane (TAP + egress seal + dnsmasq) unless the
      // request is netless or no dataplane is configured. There must be NO
      // window where the guest boots with a NIC but no egress filter, so a
      // provisioning failure fully unwinds before it rethrows (§3, §W4).
      const network = await this.#provisionNetwork(request);
      if (network !== undefined) {
        unwindNetwork = network.unwind;
        // Kernel `ip=` is the belt for CONFIG_IP_PNP kernels; the studiobox.*
        // tokens are what W5's overlay-init configures eth0 from explicitly.
        bootArgs.push(
          `ip=${network.alloc.guestIp}::${network.alloc.hostIp}:${NETMASK_30_DOTTED}::eth0:off`,
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
              iface_id: "eth0",
              host_dev_name: network.alloc.tapName,
              guest_mac: network.alloc.guestMac,
            },
          ],
        }),
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
    } catch (error) {
      // The plan never reached the journal, so nothing else will release
      // this belt: undo the acquire and drop the coordinates/overlay, then
      // best-effort unwind any network state provisioned before the throw.
      await this.#cache.release(manifestHash).catch(() => {});
      this.#coordinates.delete(request.executionId);
      await Deno.remove(this.#overlayPath(request.executionId)).catch(() => {});
      if (unwindNetwork !== undefined) await unwindNetwork().catch(() => {});
      throw error;
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
