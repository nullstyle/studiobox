/**
 * The real warm-template microVM bake (`docs/snapshot-restore.md` §1.5, WI-5).
 *
 * {@linkcode MachineTemplateBaker} implements the host-safe {@linkcode
 * TemplateBaker} seam (`builder.ts`) by driving `@nullstyle/firecracker`
 * `Machine`: stage the golden set + a fresh overlay into a template jail →
 * `Machine.launch` in template mode (studiobox.mode=template, a placeholder NIC
 * so `network_overrides` has an `eth0` to re-point on restore, NO credential)
 * → wait until template-mode studioboxd answers → `Machine.pause` →
 * `Machine.snapshot` (`snapshot` + `mem`) → copy `{snapshot, mem, overlay.ext4}`
 * out of the chroot BEFORE disposal reclaims it → kill.
 *
 * This runs ONLY inside the fc-smoke Lima VM (real KVM, jailed, root); it is
 * proven by WI-8, not by a host-safe unit test. It stays typecheck-clean
 * without a VM because every effectful collaborator — the microVM launch, the
 * readiness probe, and the copy — is an injected seam whose default is the real
 * package call. The build orchestration + store it feeds are host-safe and
 * unit-tested (`builder.ts`, `store.ts`).
 *
 * The placeholder host TAP the template's `eth0` attaches to (§1.4) is NOT
 * owned here: the caller (the `template:build` tool / fc-smoke) provisions a
 * throwaway TAP, passes its name, and tears it down after the bake. Restores
 * never use it — each restore's `network_overrides` re-points `eth0` to its own
 * `sbxtap<slot>`.
 *
 * @module
 */

import { join } from "@std/path";
import {
  type JailerOptions,
  Machine,
  type MachineOptions,
  type VmConfig,
  type VmRegistry,
} from "@nullstyle/firecracker";
import type {
  TemplateBakeArtifacts,
  TemplateBaker,
  TemplateBakeRequest,
} from "./builder.ts";

/** In-jail file names (short — they prefix the host-view sun_path). */
const KERNEL_JAIL_PATH = "/vmlinux";
const ROOTFS_JAIL_PATH = "/rootfs.ext4";
const OVERLAY_JAIL_PATH = "/overlay.ext4";
const SNAPSHOT_JAIL_PATH = "/snapshot";
const MEM_JAIL_PATH = "/mem";
/** In-jail vsock socket name — short on purpose (host view is ~104-byte). */
const VSOCK_JAIL_PATH = "v.sock";
const GUEST_CID = 3;
/** Golden in-set file names (mirrors `images/cache.ts`). */
const KERNEL_FILE_NAME = "vmlinux";
const ROOTFS_FILE_NAME = "rootfs.ext4";
/** Fresh per-bake overlay size; matches the cold launch planner default. */
const DEFAULT_OVERLAY_SIZE_BYTES = 256 * 1024 * 1024;
/** Locally-administered placeholder MAC for the template NIC (arbitrary). */
const DEFAULT_TEMPLATE_GUEST_MAC = "02:fc:00:00:00:01";
/** Default deadline for template-mode studioboxd to answer on the vsock. */
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;

/** Waits until template-mode studioboxd is serving on the guest vsock (§1.5). */
export interface TemplateReadinessProbe {
  waitReady(
    machine: Machine,
    options: {
      readonly vsockPort: number;
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<void>;
}

/** Copy a whole file, host path → host path (default `Deno.copyFile`). */
export type BakeCopyFile = (src: string, dst: string) => Promise<void>;

export interface MachineTemplateBakerOptions {
  /** Jailer configuration minus `id`/`stage` (the baker fills those). */
  readonly jailer: Omit<JailerOptions, "id" | "stage">;
  /** Crash-recovery journal — required for jailed machines (journal-before-spawn). */
  readonly registry: VmRegistry;
  /** Waits for template-mode readiness after launch. */
  readonly readiness: TemplateReadinessProbe;
  /** Pre-provisioned throwaway host TAP the template `eth0` attaches to (§1.4). */
  readonly placeholderTapName: string;
  /** Guest MAC for the template NIC. @default {@link DEFAULT_TEMPLATE_GUEST_MAC} */
  readonly guestMac?: string;
  /** Fresh overlay size staged in. @default {@link DEFAULT_OVERLAY_SIZE_BYTES} */
  readonly overlaySizeBytes?: number;
  /** Readiness deadline. @default {@link DEFAULT_READINESS_TIMEOUT_MS} */
  readonly readinessTimeoutMs?: number;
  /** microVM launch seam. @default `Machine.launch` */
  readonly launch?: (options: MachineOptions) => Promise<Machine>;
  /** Copy-out seam. @default `Deno.copyFile` */
  readonly copyFile?: BakeCopyFile;
}

/** Drives a real Firecracker `Machine` to capture a warm template (fc-smoke). */
export class MachineTemplateBaker implements TemplateBaker {
  readonly #jailer: Omit<JailerOptions, "id" | "stage">;
  readonly #registry: VmRegistry;
  readonly #readiness: TemplateReadinessProbe;
  readonly #placeholderTapName: string;
  readonly #guestMac: string;
  readonly #overlaySizeBytes: number;
  readonly #readinessTimeoutMs: number;
  readonly #launch: (options: MachineOptions) => Promise<Machine>;
  readonly #copyFile: BakeCopyFile;

  constructor(options: MachineTemplateBakerOptions) {
    this.#jailer = options.jailer;
    this.#registry = options.registry;
    this.#readiness = options.readiness;
    this.#placeholderTapName = options.placeholderTapName;
    this.#guestMac = options.guestMac ?? DEFAULT_TEMPLATE_GUEST_MAC;
    this.#overlaySizeBytes = options.overlaySizeBytes ??
      DEFAULT_OVERLAY_SIZE_BYTES;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ??
      DEFAULT_READINESS_TIMEOUT_MS;
    this.#launch = options.launch ?? ((o) => Machine.launch(o));
    this.#copyFile = options.copyFile ??
      ((src, dst) => Deno.copyFile(src, dst));
  }

  async bake(request: TemplateBakeRequest): Promise<TemplateBakeArtifacts> {
    await Deno.mkdir(request.workDir, { recursive: true });
    // Fresh, unformatted, sparse overlay — overlay-init formats it in-guest on
    // first boot, exactly as the cold path (`launch_planner.ts #createOverlay`).
    const freshOverlayHost = join(request.workDir, "overlay-fresh.ext4");
    await this.#createSparseOverlay(freshOverlayHost);

    const bootArgs = [
      "console=ttyS0",
      "quiet",
      "loglevel=1",
      "reboot=k",
      "panic=1",
      "pci=off",
      "root=/dev/vda",
      "ro",
      "init=/sbin/overlay-init",
      `studiobox.vsock_port=${request.vsockPort}`,
      // The ONLY per-template cmdline switch: no token/ip/gw/dns (personalize
      // injects identity after restore). overlay-init execs `studioboxd
      // --template` with no credential and eth0 present-but-unconfigured.
      "studiobox.mode=template",
    ].join(" ");

    const config: VmConfig = {
      machine_config: {
        vcpu_count: request.vcpuCount,
        mem_size_mib: request.memSizeMib,
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
      // A NIC DEVICE must exist at snapshot time so `network_overrides` has an
      // `eth0` to re-point on restore (§1.4); the placeholder TAP is its
      // backend at boot. overlay-init leaves it unconfigured (no studiobox.ip).
      network_interfaces: [
        {
          iface_id: "eth0",
          host_dev_name: this.#placeholderTapName,
          guest_mac: this.#guestMac,
        },
      ],
    };

    const launchOptions: MachineOptions = {
      jailer: {
        ...this.#jailer,
        // Distinct, deterministic jail id for a template bake (never a sandbox
        // execution id): `tmpl-<first 32 hex of the manifest hash>`.
        id: `tmpl-${request.manifestHash.slice(0, 32)}`,
        stage: [
          {
            hostPath: join(request.setDir, KERNEL_FILE_NAME),
            jailPath: KERNEL_JAIL_PATH,
          },
          {
            hostPath: join(request.setDir, ROOTFS_FILE_NAME),
            jailPath: ROOTFS_JAIL_PATH,
          },
          {
            hostPath: freshOverlayHost,
            jailPath: OVERLAY_JAIL_PATH,
            readWrite: true,
          },
        ],
      },
      config,
      registry: this.#registry,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      metadata: { "studiobox.template": request.manifestHash },
    };

    const snapshotOut = join(request.workDir, "snapshot");
    const memOut = join(request.workDir, "mem");
    const overlayOut = join(request.workDir, "overlay.ext4");

    const machine = await this.#launch(launchOptions);
    try {
      await this.#readiness.waitReady(machine, {
        vsockPort: request.vsockPort,
        timeoutMs: this.#readinessTimeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const version = await machine.client.getVersion();
      // Firecracker requires a paused VM for snapshot (§1.5 step 4).
      await machine.pause();
      await machine.snapshot({
        snapshot_path: SNAPSHOT_JAIL_PATH,
        mem_file_path: MEM_JAIL_PATH,
        snapshot_type: "Full",
      });
      const chrootRoot = machine.paths.chrootRoot;
      if (chrootRoot === undefined) {
        throw new Error(
          "template bake expected a jailed machine with a chroot root",
        );
      }
      // Copy the captured artifacts OUT of the chroot before disposal reclaims
      // it. The in-jail `/snapshot`, `/mem`, `/overlay.ext4` land under the
      // chroot root on the host.
      await this.#copyFile(join(chrootRoot, "snapshot"), snapshotOut);
      await this.#copyFile(join(chrootRoot, "mem"), memOut);
      await this.#copyFile(join(chrootRoot, "overlay.ext4"), overlayOut);
      return {
        snapshotPath: snapshotOut,
        memPath: memOut,
        overlayPath: overlayOut,
        firecrackerVersion: version.firecracker_version,
      };
    } finally {
      // Kill + dispose: dispose confirms death and reclaims the chroot (which
      // is why the copy-out above must have already run).
      await machine.kill().catch(() => {});
      await machine[Symbol.asyncDispose]().catch(() => {});
    }
  }

  /** Create a fresh sparse, unformatted overlay (guest formats it on boot). */
  async #createSparseOverlay(path: string): Promise<void> {
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        await Deno.remove(path);
        file = await Deno.open(path, {
          createNew: true,
          write: true,
          mode: 0o600,
        });
      } else {
        throw error;
      }
    }
    try {
      await file.truncate(this.#overlaySizeBytes);
    } finally {
      file.close();
    }
  }
}
