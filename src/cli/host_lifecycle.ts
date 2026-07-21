/**
 * {@linkcode HostLifecycle} — the module `host up|down|status|provision|doctor`
 * drive (PLAN.md §M9; DESIGN.md §11).
 *
 * It composes the {@linkcode HostEnv} (limactl/bash seam), the provisioner
 * (`./provision.ts`), and the doctor (`./doctor.ts` + `./host_client.ts`) into
 * the five verbs. Everything external flows through injected seams — the
 * command runner, the local filesystem, the template writer, and the doctor
 * probe factory — so the whole flow is exercised against a FAKE `limactl` with
 * no VM present, exactly as PLAN.md §M9 requires; a real cold `host up` is
 * validated manually (see `docs/host-lifecycle.md`).
 *
 * Idempotency: `up` reuses a present VM (start is a no-op when running) and only
 * recreates on `--recreate`; `provision`'s steps are each idempotent and never
 * rotate an existing token unless asked. `down` stops the VM (lima) or the
 * systemd units (`--no-lima`).
 *
 * @module
 */

import { type ArtifactArch, assertArtifactArch } from "../../images/pins.ts";
import type { ContractIdentity } from "../wire/contract.ts";
import { buildHostContractIdentity } from "../hostd/service.ts";
import type { HostCompatIdentitySource } from "../hostd/service.ts";
import type { CommandRunner } from "@nullstyle/lima";
import { HostEnv, type HostMode } from "./host_env.ts";
import {
  DEFAULT_PORTS,
  type HostPortConfig,
  hostVmName,
  type LimaTemplateOptions,
  renderLimaTemplate,
} from "./host_template.ts";
import { DenoLocalFs, type LocalFs } from "./local_fs.ts";
import {
  type BakeRequest,
  defaultCompatPath,
  defaultDaemonBinary,
  defaultHostTokenPath,
  type LaunchConfigInput,
  provisionHost,
  type ProvisionResult,
} from "./provision.ts";
import { BakeSourceUnavailableError, defaultSourceRoot } from "./bake.ts";
import { type DoctorReport, type HostProbe, runDoctor } from "./doctor.ts";
import { createHostProbe } from "./host_client.ts";

/**
 * Bake inputs a caller supplies WITHOUT the source root — the lifecycle resolves
 * that itself (via {@linkcode HostLifecycleOptions.resolveSourceRoot}) so it can
 * fail fast on a from-JSR invocation before touching the VM.
 */
export interface HostBakeOptions {
  /** Ignore the cache and force a fresh bake. @default false */
  readonly rebuild?: boolean;
  /** Optional dataplane/strategy fields to fold into the launch config. */
  readonly launch?: Omit<LaunchConfigInput, "manifestHash">;
}

/** Options for {@linkcode HostLifecycle}. */
export interface HostLifecycleOptions {
  /** The subprocess seam (REQUIRED — the one dependency with no default). */
  readonly runner: CommandRunner;
  /** `lima` (macOS) or `no-lima` (Linux/CI). @default "lima" */
  readonly mode?: HostMode;
  /** Target arch. @default this host's arch */
  readonly arch?: ArtifactArch;
  /** Lima instance name. @default studiobox-host-<arch> */
  readonly name?: string;
  /** Loopback ports. @default DEFAULT_PORTS */
  readonly ports?: HostPortConfig;
  /** Local filesystem seam. @default DenoLocalFs */
  readonly fs?: LocalFs;
  /** Home directory for `~/.studiobox`. @default $HOME */
  readonly homeDir?: string;
  /** Directory holding the compiled daemons. @default ".build" */
  readonly buildDir?: string;
  /** Explicit host source for the `studiobox-hostd` binary. */
  readonly hostdBinarySource?: string;
  /** Explicit host source for the `studiobox-rootd` binary. */
  readonly rootdBinarySource?: string;
  /** Host source of `compat/wire.json`. @default the committed pin */
  readonly compatSource?: string;
  /**
   * Enable rootd's launch planner so `Sandbox.create` boots a real microVM.
   * The one required field is the baked golden set's `manifestHash` (printed by
   * `tools/build_golden_set.ts`); omit to bring up a control-plane-only host.
   * Mutually exclusive with {@linkcode bake}.
   */
  readonly launchConfig?: LaunchConfigInput;
  /**
   * Bake the golden set in-guest and auto-wire its hash (the `--bake` path). The
   * source root is resolved via {@linkcode resolveSourceRoot} (fails fast from
   * JSR). Mutually exclusive with {@linkcode launchConfig}.
   */
  readonly bake?: HostBakeOptions;
  /**
   * Resolve the host source-tree root for {@linkcode bake} (test seam).
   * @default {@linkcode import("./bake.ts").defaultSourceRoot}
   */
  readonly resolveSourceRoot?: () => string | undefined;
  /** Overrides passed to {@linkcode renderLimaTemplate}. */
  readonly templateOptions?: LimaTemplateOptions;
  /** Render the template to a path `createVm` consumes. @default temp file */
  readonly writeTemplate?: (yaml: string) => Promise<string>;
  /** Bootstrap-token source (32 bytes). */
  readonly tokenFactory?: () => Uint8Array;
  /** Progress sink. @default no-op */
  readonly log?: (line: string) => void;
  /** `limactl` binary. @default "limactl" */
  readonly limactlBin?: string;
  /** `sudo` binary. @default "sudo" */
  readonly sudoBin?: string;
  /** Doctor probe factory (test seam). @default dial the forwarded port */
  readonly probeFactory?: () => HostProbe | Promise<HostProbe>;
}

/** VM readiness one `up` established (macOS). */
export interface HostUpResult {
  readonly created: boolean;
  readonly kvmPresent: boolean;
  readonly provision: ProvisionResult;
}

/** Structured `status` output. */
export interface HostStatus {
  readonly mode: HostMode;
  readonly name: string;
  readonly arch: ArtifactArch;
  readonly vmExists: boolean;
  readonly vmRunning: boolean;
  readonly daemons: { readonly hostd: string; readonly rootd: string };
  readonly tokenPresent: boolean;
  readonly ports: HostPortConfig;
}

/** This host's arch, validated against the artifact-arch set. */
function hostDefaultArch(): ArtifactArch {
  const arch = Deno.build.arch;
  assertArtifactArch(arch, "Deno.build.arch");
  return arch;
}

async function defaultWriteTemplate(yaml: string): Promise<string> {
  const path = await Deno.makeTempFile({
    prefix: "studiobox-host-",
    suffix: ".yaml",
  });
  await Deno.writeTextFile(path, yaml);
  return path;
}

export class HostLifecycle {
  readonly #mode: HostMode;
  readonly #arch: ArtifactArch;
  readonly #name: string;
  readonly #ports: HostPortConfig;
  readonly #fs: LocalFs;
  readonly #env: HostEnv;
  readonly #homeDir: string;
  readonly #hostTokenPath: string;
  readonly #hostdBinarySource: string;
  readonly #rootdBinarySource: string;
  readonly #compatSource: string;
  readonly #launchConfig: LaunchConfigInput | undefined;
  readonly #bake: HostBakeOptions | undefined;
  readonly #resolveSourceRoot: () => string | undefined;
  readonly #templateOptions: LimaTemplateOptions;
  readonly #writeTemplate: (yaml: string) => Promise<string>;
  readonly #tokenFactory: (() => Uint8Array) | undefined;
  readonly #log: (line: string) => void;
  readonly #probeFactory: (() => HostProbe | Promise<HostProbe>) | undefined;

  constructor(options: HostLifecycleOptions) {
    this.#mode = options.mode ?? "lima";
    this.#arch = options.arch ?? hostDefaultArch();
    this.#name = options.name ?? hostVmName(this.#arch);
    this.#ports = options.ports ?? DEFAULT_PORTS;
    this.#fs = options.fs ?? new DenoLocalFs();
    this.#homeDir = options.homeDir ?? Deno.env.get("HOME") ?? "/root";
    this.#hostTokenPath = defaultHostTokenPath(this.#homeDir);
    const buildDir = options.buildDir ?? ".build";
    this.#hostdBinarySource = options.hostdBinarySource ??
      defaultDaemonBinary(buildDir, "studiobox-hostd", this.#arch);
    this.#rootdBinarySource = options.rootdBinarySource ??
      defaultDaemonBinary(buildDir, "studiobox-rootd", this.#arch);
    this.#compatSource = options.compatSource ?? defaultCompatPath();
    this.#launchConfig = options.launchConfig;
    this.#bake = options.bake;
    this.#resolveSourceRoot = options.resolveSourceRoot ?? defaultSourceRoot;
    this.#templateOptions = options.templateOptions ??
      { ports: this.#ports };
    this.#writeTemplate = options.writeTemplate ?? defaultWriteTemplate;
    this.#tokenFactory = options.tokenFactory;
    this.#log = options.log ?? (() => {});
    this.#probeFactory = options.probeFactory;
    this.#env = new HostEnv({
      runner: options.runner,
      mode: this.#mode,
      name: this.#name,
      ...(options.limactlBin === undefined
        ? {}
        : { limactlBin: options.limactlBin }),
      ...(options.sudoBin === undefined ? {} : { sudoBin: options.sudoBin }),
    });
  }

  get name(): string {
    return this.#name;
  }

  get mode(): HostMode {
    return this.#mode;
  }

  /**
   * Create/start the host VM (macOS) and provision it. Idempotent: a present,
   * running VM is reused; `recreate` deletes it first. Verifies `/dev/kvm`
   * before provisioning so a non-nested-virt Mac fails with a clear message.
   */
  async up(
    options: { recreate?: boolean; rotateToken?: boolean } = {},
  ): Promise<HostUpResult> {
    // Resolve --bake's source root BEFORE any VM create so a from-JSR --bake
    // fails fast instead of orphaning a half-created host. (Discarded here; the
    // provision() call below re-resolves and threads it.)
    this.#resolveBake();
    const recreate = options.recreate ?? false;
    let created = false;
    if (this.#mode === "lima") {
      if (recreate && await this.#env.vmExists()) {
        this.#log(`host up: recreating ${this.#name}`);
        await this.#env.deleteVm();
      }
      if (!(await this.#env.vmExists())) {
        this.#log(
          `host up: creating ${this.#name} (first run downloads Ubuntu)`,
        );
        const yaml = renderLimaTemplate(this.#templateOptions);
        const templatePath = await this.#writeTemplate(yaml);
        await this.#env.createVm(templatePath);
        created = true;
      } else {
        this.#log(`host up: starting ${this.#name}`);
        await this.#env.startVm();
      }
    }

    let kvmPresent = true;
    if (this.#mode === "lima") {
      kvmPresent = (await this.#env.guestExec("test -e /dev/kvm")).success;
      if (!kvmPresent) {
        throw new Error(
          `/dev/kvm missing in ${this.#name}: nested virtualization needs an ` +
            `M3+ Mac on macOS 15+ with vmType vz. The instance is kept for ` +
            `inspection (limactl shell ${this.#name}).`,
        );
      }
    }

    const provision = await this.provision(options.rotateToken ?? false);
    return { created, kvmPresent, provision };
  }

  /** Run the ordered, idempotent provisioning sequence. */
  provision(rotateToken = false): Promise<ProvisionResult> {
    const bake = this.#resolveBake();
    return provisionHost({
      env: this.#env,
      fs: this.#fs,
      arch: this.#arch,
      ports: this.#ports,
      hostTokenPath: this.#hostTokenPath,
      hostdBinarySource: this.#hostdBinarySource,
      rootdBinarySource: this.#rootdBinarySource,
      compatSource: this.#compatSource,
      // bake and launchConfig are mutually exclusive (enforced at the CLI); pass
      // bake when requested, else the supplied launch config.
      ...(bake !== undefined
        ? { bake }
        : this.#launchConfig === undefined
        ? {}
        : { launchConfig: this.#launchConfig }),
      rotateToken,
      log: this.#log,
      ...(this.#tokenFactory === undefined
        ? {}
        : { tokenFactory: this.#tokenFactory }),
    });
  }

  /**
   * Resolve a full {@linkcode BakeRequest} (with source root) when `--bake` was
   * requested, else `undefined`. Throws {@linkcode BakeSourceUnavailableError}
   * when there is no local source tree to bake from (a from-JSR invocation).
   */
  #resolveBake(): BakeRequest | undefined {
    if (this.#bake === undefined) return undefined;
    const sourceRoot = this.#resolveSourceRoot();
    if (sourceRoot === undefined) throw new BakeSourceUnavailableError();
    return {
      sourceRoot,
      ...(this.#bake.rebuild === undefined
        ? {}
        : { rebuild: this.#bake.rebuild }),
      ...(this.#bake.launch === undefined ? {} : { launch: this.#bake.launch }),
    };
  }

  /** Stop the VM (lima) or the systemd units (`--no-lima`). */
  async down(): Promise<void> {
    if (this.#mode === "lima") {
      if (await this.#env.vmExists()) {
        this.#log(`host down: stopping ${this.#name}`);
        await this.#env.stopVm();
      }
      return;
    }
    this.#log("host down: stopping studiobox daemons");
    await this.#env.guestExec(
      "systemctl stop studiobox-hostd.service studiobox-rootd.service",
      { sudo: true },
    );
  }

  /** Report VM + daemon + token state. */
  async status(): Promise<HostStatus> {
    const vmExists = await this.#env.vmExists();
    const vmRunning = vmExists ? await this.#env.vmRunning() : false;
    const daemons = vmRunning
      ? {
        hostd: await this.#daemonState("studiobox-hostd.service"),
        rootd: await this.#daemonState("studiobox-rootd.service"),
      }
      : { hostd: "unknown", rootd: "unknown" };
    const tokenPresent = await this.#fs.exists(this.#hostTokenPath);
    return {
      mode: this.#mode,
      name: this.#name,
      arch: this.#arch,
      vmExists,
      vmRunning,
      daemons,
      tokenPresent,
      ports: this.#ports,
    };
  }

  /** Full end-to-end health: negotiate, capacity, canary, quarantine. */
  async doctor(): Promise<DoctorReport> {
    const probe = await this.#makeProbe();
    return await runDoctor(probe);
  }

  async #daemonState(unit: string): Promise<string> {
    const result = await this.#env.guestExec(`systemctl is-active ${unit}`);
    const text = result.stdout.trim();
    return text.length > 0 ? text : (result.success ? "active" : "inactive");
  }

  async #makeProbe(): Promise<HostProbe> {
    if (this.#probeFactory !== undefined) {
      return await this.#probeFactory();
    }
    const identity = await this.#buildProbeIdentity();
    const credential = await this.#readHostToken();
    return createHostProbe({
      port: this.#ports.control,
      identity,
      credential,
    });
  }

  async #buildProbeIdentity(): Promise<ContractIdentity> {
    const compat = JSON.parse(
      await Deno.readTextFile(this.#compatSource),
    ) as HostCompatIdentitySource;
    return await buildHostContractIdentity(compat, {
      buildId: "studiobox-host",
    });
  }

  async #readHostToken(): Promise<Uint8Array> {
    const text = await Deno.readTextFile(this.#hostTokenPath);
    const trimmed = text.trim();
    if (!/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
      throw new Error(
        `host token at ${this.#hostTokenPath} must be 64 hex characters ` +
          `(run \`studiobox host provision\` first)`,
      );
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
}
