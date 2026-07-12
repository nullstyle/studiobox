/**
 * The host execution environment: the thin translation layer between the
 * lifecycle's semantic operations (create/start/stop/delete the VM, run a
 * script in the guest, copy a file in) and the concrete `limactl`/`bash`/`cp`
 * argv the {@linkcode HostCommandRunner} executes (PLAN.md §M9; DESIGN.md §11).
 *
 * Two modes, one interface:
 *
 * - **`lima`** (macOS): VM ops are `limactl start|stop|delete`; guest scripts
 *   run as `limactl shell <name> -- bash -lc <script>`; files land in the guest
 *   via `limactl cp <src> <name>:<dst>` — the pinned token path (DESIGN.md §8),
 *   NEVER the forwarded control port.
 * - **`no-lima`** (Linux workstation / CI): there is no VM, so the VM ops are
 *   no-ops; guest scripts run as `bash -lc <script>` directly on the machine;
 *   `copyIn` installs the file locally with `install -m`.
 *
 * The lifecycle depends only on {@linkcode HostEnv}, so a fake runner drives the
 * whole flow with no VM present and the tests assert the exact argv order.
 *
 * @module
 */

import {
  type HostCommandResult,
  type HostCommandRunner,
  runChecked,
} from "./exec.ts";

/** The provisioning target. */
export type HostMode = "lima" | "no-lima";

/** Options for {@linkcode HostEnv}. */
export interface HostEnvOptions {
  readonly runner: HostCommandRunner;
  readonly mode: HostMode;
  /** Lima instance name (ignored in `no-lima` mode). */
  readonly name: string;
  /** `limactl` binary. @default "limactl" */
  readonly limactlBin?: string;
  /** `sudo` binary for privileged guest steps. @default "sudo" */
  readonly sudoBin?: string;
}

/** A guest exec that failed a required-success contract. */
export interface GuestExecOptions {
  /** When true, a nonzero exit throws instead of returning the result. */
  readonly check?: boolean;
  /** Prefix the script with `sudo -E bash -lc` semantics. @default false */
  readonly sudo?: boolean;
}

/**
 * Wrap a bash body so it runs with a predictable shell: `set -euo pipefail` and
 * a login shell, matching the reference smoke drivers.
 */
function wrapScript(script: string): string {
  return `set -euo pipefail; ${script}`;
}

export class HostEnv {
  readonly #runner: HostCommandRunner;
  readonly #mode: HostMode;
  readonly #name: string;
  readonly #limactl: string;
  readonly #sudo: string;

  constructor(options: HostEnvOptions) {
    this.#runner = options.runner;
    this.#mode = options.mode;
    this.#name = options.name;
    this.#limactl = options.limactlBin ?? "limactl";
    this.#sudo = options.sudoBin ?? "sudo";
  }

  get mode(): HostMode {
    return this.#mode;
  }

  get name(): string {
    return this.#name;
  }

  /** Whether the Lima instance exists (always `true` in `no-lima` mode). */
  async vmExists(): Promise<boolean> {
    if (this.#mode === "no-lima") return true;
    const result = await this.#runner.run(this.#limactl, ["list", "-q"]);
    return result.stdout.split("\n").map((s) => s.trim()).includes(this.#name);
  }

  /** Whether the Lima instance reports `Running` (always `true` in no-lima). */
  async vmRunning(): Promise<boolean> {
    if (this.#mode === "no-lima") return true;
    const result = await this.#runner.run(this.#limactl, [
      "list",
      "--format",
      "{{.Name}}\t{{.Status}}",
    ]);
    for (const line of result.stdout.split("\n")) {
      const [name, status] = line.split("\t");
      if (name?.trim() === this.#name) {
        return status?.trim().toLowerCase() === "running";
      }
    }
    return false;
  }

  /** Create + boot the Lima instance from a rendered template file. No-op in no-lima. */
  async createVm(templatePath: string): Promise<void> {
    if (this.#mode === "no-lima") return;
    await runChecked(this.#runner, this.#limactl, [
      "start",
      `--name=${this.#name}`,
      "--tty=false",
      templatePath,
    ]);
  }

  /** Start (a no-op when already running) the Lima instance. No-op in no-lima. */
  async startVm(): Promise<void> {
    if (this.#mode === "no-lima") return;
    await runChecked(this.#runner, this.#limactl, ["start", this.#name]);
  }

  /** Stop the Lima instance. No-op in no-lima (daemons are stopped separately). */
  async stopVm(): Promise<void> {
    if (this.#mode === "no-lima") return;
    await runChecked(this.#runner, this.#limactl, ["stop", this.#name]);
  }

  /** Delete the Lima instance (forced). No-op in no-lima. */
  async deleteVm(): Promise<void> {
    if (this.#mode === "no-lima") return;
    await runChecked(this.#runner, this.#limactl, ["delete", "-f", this.#name]);
  }

  /**
   * Run a bash script "in the guest": via `limactl shell` (lima) or directly
   * (no-lima). Returns the raw result unless `check` throws on a nonzero exit.
   */
  async guestExec(
    script: string,
    options: GuestExecOptions = {},
  ): Promise<HostCommandResult> {
    const body = options.sudo === true
      ? `${this.#sudo} -E bash -lc ${shellQuote(wrapScript(script))}`
      : wrapScript(script);
    const [bin, args] = this.#mode === "lima"
      ? [this.#limactl, [
        "shell",
        this.#name,
        "--",
        "bash",
        "-lc",
        body,
      ]] as const
      : ["bash", ["-lc", body]] as const;
    if (options.check === true) {
      return await runChecked(this.#runner, bin, args);
    }
    return await this.#runner.run(bin, args);
  }

  /**
   * Deliver a host-side file into the target. In lima mode this is
   * `limactl cp <local> <name>:<remote>` — the pinned token-delivery path
   * (DESIGN.md §8), never the forwarded port. In no-lima mode it is a local
   * `install -m <mode> <local> <remote>` so ownership/mode match.
   */
  async copyIn(
    localPath: string,
    remotePath: string,
    mode = "0600",
  ): Promise<void> {
    if (this.#mode === "no-lima") {
      await runChecked(this.#runner, this.#sudo, [
        "install",
        "-m",
        mode,
        localPath,
        remotePath,
      ]);
      return;
    }
    await runChecked(this.#runner, this.#limactl, [
      "cp",
      localPath,
      `${this.#name}:${remotePath}`,
    ]);
    // limactl cp lands the file mode 0644; tighten it in the guest.
    await this.guestExec(`chmod ${mode} ${shellQuote(remotePath)}`, {
      check: true,
      sudo: true,
    });
  }
}

/** Single-quote a string for safe embedding in a bash command line. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
