/**
 * The host execution environment: the thin translation layer between the
 * lifecycle's semantic operations (create/start/stop/delete the VM, run a
 * script in the guest, copy a file in) and how they execute on each target
 * (PLAN.md §M9; DESIGN.md §11).
 *
 * Two modes, one interface:
 *
 * - **`lima`** (macOS): every operation delegates to `@nullstyle/lima`
 *   ({@linkcode Limactl} / {@linkcode LimaInstance}) — the extracted,
 *   generalized home of the argv shapes this module used to own. Files land
 *   in the guest via `limactl cp` — the pinned token path (DESIGN.md §8),
 *   NEVER the forwarded control port.
 * - **`no-lima`** (Linux workstation / CI): there is no VM, so the VM ops are
 *   no-ops; guest scripts run as `bash -lc <script>` directly on the machine;
 *   `copyIn` installs the file locally with `install -m`.
 *
 * The lifecycle depends only on {@linkcode HostEnv}, so a fake runner drives
 * the whole flow with no VM present and the tests assert the exact argv order.
 *
 * @module
 */

import {
  type CommandResult,
  type CommandRunner,
  Limactl,
  type LimaInstance,
  runChecked,
  shellQuote,
  strictWrap,
  sudoWrap,
} from "@nullstyle/lima";

export { shellQuote };

/** The provisioning target. */
export type HostMode = "lima" | "no-lima";

/** Options for {@linkcode HostEnv}. */
export interface HostEnvOptions {
  readonly runner: CommandRunner;
  readonly mode: HostMode;
  /** Lima instance name (ignored in `no-lima` mode). */
  readonly name: string;
  /** `limactl` binary. @default "limactl" */
  readonly limactlBin?: string;
  /** `sudo` binary for privileged guest steps. @default "sudo" */
  readonly sudoBin?: string;
}

/** Options for {@linkcode HostEnv.guestExec}. */
export interface GuestExecOptions {
  /** When true, a nonzero exit throws instead of returning the result. */
  readonly check?: boolean;
  /** Prefix the script with `sudo -E bash -lc` semantics. @default false */
  readonly sudo?: boolean;
}

export class HostEnv {
  readonly #runner: CommandRunner;
  readonly #mode: HostMode;
  readonly #name: string;
  readonly #sudo: string;
  readonly #lima: Limactl;
  readonly #vm: LimaInstance;

  constructor(options: HostEnvOptions) {
    this.#runner = options.runner;
    this.#mode = options.mode;
    this.#name = options.name;
    this.#sudo = options.sudoBin ?? "sudo";
    this.#lima = new Limactl({
      runner: options.runner,
      ...(options.limactlBin === undefined ? {} : { bin: options.limactlBin }),
      ...(options.sudoBin === undefined ? {} : { sudoBin: options.sudoBin }),
    });
    this.#vm = this.#lima.instance(this.#name);
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
    return await this.#vm.exists();
  }

  /** Whether the Lima instance reports `Running` (always `true` in no-lima). */
  async vmRunning(): Promise<boolean> {
    if (this.#mode === "no-lima") return true;
    return await this.#vm.isRunning();
  }

  /** Create + boot the Lima instance from a rendered template file. No-op in no-lima. */
  async createVm(templatePath: string): Promise<void> {
    if (this.#mode === "no-lima") return;
    await this.#lima.create(this.#name, { file: templatePath });
  }

  /** Start (a no-op when already running) the Lima instance. No-op in no-lima. */
  async startVm(): Promise<void> {
    if (this.#mode === "no-lima") return;
    await this.#vm.start();
  }

  /** Stop the Lima instance. No-op in no-lima (daemons are stopped separately). */
  async stopVm(): Promise<void> {
    if (this.#mode === "no-lima") return;
    await this.#vm.stop();
  }

  /** Delete the Lima instance (forced). No-op in no-lima. */
  async deleteVm(): Promise<void> {
    if (this.#mode === "no-lima") return;
    await this.#vm.delete();
  }

  /**
   * Run a bash script "in the guest": via `limactl shell` (lima) or directly
   * (no-lima). Returns the raw result unless `check` throws on a nonzero exit.
   */
  async guestExec(
    script: string,
    options: GuestExecOptions = {},
  ): Promise<CommandResult> {
    if (this.#mode === "lima") {
      return await this.#vm.exec(script, {
        ...(options.check === undefined ? {} : { check: options.check }),
        ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
      });
    }
    const wrapped = strictWrap(script);
    const body = options.sudo === true
      ? sudoWrap(wrapped, { sudoBin: this.#sudo })
      : wrapped;
    const args = ["-lc", body] as const;
    if (options.check === true) {
      return await runChecked(this.#runner, "bash", args);
    }
    return await this.#runner.run("bash", args);
  }

  /**
   * Run a command on the HOST machine (the mac under `lima`; the local box
   * under `no-lima`) — NOT in the guest. Used by the golden bake to build the
   * source tarball with `git` + `tar` before shipping it in. Identical in both
   * modes because the host IS the CLI machine. Flows through the same runner so
   * a fake records the argv.
   */
  async hostExec(
    bin: string,
    args: readonly string[],
    options: { check?: boolean; uncapped?: boolean } = {},
  ): Promise<CommandResult> {
    const runOptions = options.uncapped === true ? { uncapped: true } : {};
    return options.check === true
      ? await runChecked(this.#runner, bin, args, runOptions)
      : await this.#runner.run(bin, args, runOptions);
  }

  /**
   * Deliver a host file to a USER-WRITABLE guest path with a plain copy — no
   * `sudo install` staging (unlike {@link copyIn}). Used for the bake tarball,
   * which lands under `/tmp` (owned by the unprivileged lima user), so a single
   * `limactl cp` is both correct and trivially assertable. In `no-lima` mode the
   * host is the guest, so it is a local `cp`.
   */
  async copyFileIn(localPath: string, remotePath: string): Promise<void> {
    if (this.#mode === "no-lima") {
      await runChecked(this.#runner, "cp", [localPath, remotePath]);
      return;
    }
    await this.#vm.copyIn(localPath, remotePath);
  }

  /**
   * Deliver a host-side file into the target. In lima mode this delegates to
   * {@linkcode LimaInstance.copyInAsRoot} — `limactl cp` into a user-writable
   * staging path, then `sudo install -m <mode>` into place (the pinned
   * token-delivery path, DESIGN.md §8 — never the forwarded port). In no-lima
   * mode it is a local `install -m <mode> <local> <remote>` so ownership/mode
   * match.
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
    await this.#vm.copyInAsRoot(localPath, remotePath, { mode });
  }
}
