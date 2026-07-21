/**
 * The committed studiobox-host Lima template + its generator (DESIGN.md §11;
 * PLAN.md §M9).
 *
 * {@linkcode renderLimaTemplate} is the single source of truth for the Lima
 * instance config `host up` starts on macOS: a `vz` VM with nested
 * virtualization, NO host mounts (`mounts: []`, so a hostile guest workload can
 * never reach the developer's filesystem), containerd disabled, and the three
 * static loopback port forwards the topology needs — control (40000), tunnel
 * (40001), and the exposeHttp range (40100–40199). The YAML itself is rendered
 * by `@nullstyle/lima`'s deterministic
 * {@linkcode import("@nullstyle/lima").renderLimaYaml}; this module owns only
 * the studiobox choices. The rendered default is committed at
 * `tools/lima/studiobox-host.yaml`; a unit test asserts the file is
 * byte-identical to `renderLimaTemplate(DEFAULT_LIMA_TEMPLATE_OPTIONS)`, so
 * the committed artifact can never drift from the generator.
 *
 * The template composes Lima's builtin `ubuntu-24.04` base
 * (`base: template://ubuntu-24.04`), which supplies the arch-appropriate cloud
 * image, so a single committed file serves both aarch64 and x86_64 hosts. The
 * Lima instance NAME is not part of the template — it is passed to
 * `limactl start --name`, so the same config backs `studiobox-host-aarch64` and
 * `studiobox-host-x86_64`.
 *
 * On a Linux host there is no Lima layer at all: `host up --no-lima` provisions
 * the machine directly (a Linux workstation, or CI). A Linux developer who does
 * want Lima would flip `vmType` to `qemu` (KVM-accelerated) — studiobox does
 * not commit that variant because the first-class Linux path is `--no-lima`.
 *
 * @module
 */

import type { ArtifactArch } from "../../images/pins.ts";
import { type LimaConfig, renderLimaYaml } from "@nullstyle/lima";

/** The three static loopback port forwards (DESIGN.md §3/§11). */
export interface HostPortConfig {
  /** HostControl plane (client ↔ hostd). */
  readonly control: number;
  /** Ticketed agent tunnel (client ↔ studioboxd, spliced by rootd). */
  readonly tunnel: number;
  /** Inclusive exposeHttp forward range `[start, end]` (Tier B). */
  readonly exposeRange: readonly [number, number];
}

/** DESIGN.md §11: control 40000, tunnel 40001, expose 40100–40199. */
export const DEFAULT_PORTS: HostPortConfig = Object.freeze({
  control: 40000,
  tunnel: 40001,
  exposeRange: [40100, 40199] as readonly [number, number],
});

/** Inputs to {@linkcode renderLimaTemplate}. */
export interface LimaTemplateOptions {
  /** Port forwards to publish on the host loopback. */
  readonly ports?: HostPortConfig;
  /** vCPUs assigned to the host VM (the microVM budget lives inside it). */
  readonly cpus?: number;
  /** Host VM memory (Lima size grammar, e.g. `"6GiB"`). */
  readonly memory?: string;
  /** Host VM system-disk size (Lima size grammar, e.g. `"40GiB"`). */
  readonly disk?: string;
}

/** The committed defaults (what `tools/lima/studiobox-host.yaml` renders from). */
export const DEFAULT_LIMA_TEMPLATE_OPTIONS: Required<LimaTemplateOptions> =
  Object.freeze({
    ports: DEFAULT_PORTS,
    cpus: 4,
    memory: "6GiB",
    disk: "40GiB",
  });

/** The Lima instance name for a host of the given arch: `studiobox-host-<arch>`. */
export function hostVmName(arch: ArtifactArch): string {
  return `studiobox-host-${arch}`;
}

const HEADER = `studiobox-host — committed Lima template (macOS host).

Source of truth: src/cli/host_template.ts renderLimaTemplate(). Do NOT edit by
hand — regenerate from the generator (see tools/lima_template_write.ts). A unit
test pins this file byte-for-byte to renderLimaTemplate() so it cannot drift.

The Lima instance name is supplied by \`limactl start --name studiobox-host-<arch>\`
(aarch64 / x86_64), so this single config serves both architectures.

Linux hosts do NOT use this file: \`studiobox host up --no-lima\` provisions the
machine directly. A Linux developer who wants a Lima VM would set vmType: qemu
(KVM-accelerated) instead of vz.`;

/**
 * Render the studiobox-host Lima template YAML. Deterministic — the byte
 * output is `@nullstyle/lima`'s render contract, so the committed artifact is
 * stable and the drift test is exact.
 */
export function renderLimaTemplate(
  options: LimaTemplateOptions = {},
): string {
  const ports = options.ports ?? DEFAULT_LIMA_TEMPLATE_OPTIONS.ports;
  const cpus = options.cpus ?? DEFAULT_LIMA_TEMPLATE_OPTIONS.cpus;
  const memory = options.memory ?? DEFAULT_LIMA_TEMPLATE_OPTIONS.memory;
  const disk = options.disk ?? DEFAULT_LIMA_TEMPLATE_OPTIONS.disk;
  const [exposeStart, exposeEnd] = ports.exposeRange;

  const config: LimaConfig = {
    base: "template://ubuntu-24.04",
    vmType: "vz",
    nestedVirtualization: true,
    rosetta: { enabled: false },
    cpus,
    memory,
    disk,
    mounts: [],
    containerd: { system: false, user: false },
    portForwards: [
      {
        guestPort: ports.control,
        hostIP: "127.0.0.1",
        hostPort: ports.control,
        comment: "HostControl plane (client -> studiobox-hostd).",
      },
      {
        guestPort: ports.tunnel,
        hostIP: "127.0.0.1",
        hostPort: ports.tunnel,
        comment:
          "Ticketed agent tunnel (client -> studioboxd, spliced by studiobox-rootd).",
      },
      {
        guestPortRange: [exposeStart, exposeEnd],
        hostIP: "127.0.0.1",
        hostPortRange: [exposeStart, exposeEnd],
        comment: "exposeHttp reserved range (Tier B).",
      },
    ],
  };

  return renderLimaYaml(config, {
    header: HEADER,
    comments: {
      base:
        "Compose Lima's builtin Ubuntu 24.04 base for the arch-appropriate cloud image.",
      vmType:
        "Apple Virtualization.framework + nested virtualization: the microVMs studiobox\n" +
        "launches run inside this VM, so /dev/kvm must be present (Apple Silicon M3+,\n" +
        "macOS 15+).",
      cpus: "",
      mounts:
        "No host mounts. A sandbox workload is hostile (DESIGN.md §8); the VM must never\n" +
        "have a path back to the developer's filesystem.",
      containerd: "studiobox launches Firecracker microVMs, not containers.",
      portForwards:
        "Static loopback forwards (DESIGN.md §3/§11). Each binds the HOST side to\n" +
        "127.0.0.1 only — the control token rides this loopback, never a public iface.",
    },
  });
}
