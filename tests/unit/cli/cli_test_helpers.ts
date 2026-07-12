/**
 * Host-safe fakes for the CLI lifecycle tests: a recording `limactl`/`bash`
 * command runner and an in-memory local filesystem. Together they model a
 * coherent host — instances, running state, guest files, `/dev/kvm`, daemon
 * activeness — so the lifecycle module can be driven end to end with NO VM and
 * the exact argv sequence asserted (PLAN.md §M9).
 */

import type {
  HostCommandOptions,
  HostCommandResult,
  HostCommandRunner,
} from "../../../src/cli/exec.ts";
import type { LocalFs } from "../../../src/cli/local_fs.ts";

/** One recorded invocation. */
export interface RecordedCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

function ok(stdout = ""): HostCommandResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

function failed(code = 1): HostCommandResult {
  return { success: false, code, stdout: "", stderr: "" };
}

/** A recording, stateful fake for {@linkcode HostCommandRunner}. */
export class FakeHostRunner implements HostCommandRunner {
  readonly calls: RecordedCall[] = [];
  /** Lima instances that exist. */
  readonly instances = new Set<string>();
  /** Lima instances currently running. */
  readonly running = new Set<string>();
  /** Absolute paths present "in the guest". */
  readonly guestFiles = new Set<string>();
  /** unit name -> `systemctl is-active` answer. */
  readonly daemonActive = new Map<string, string>();
  /** Whether `/dev/kvm` is present in the guest. */
  kvm = true;

  run(
    bin: string,
    args: readonly string[],
    options?: HostCommandOptions,
  ): Promise<HostCommandResult> {
    this.calls.push({
      bin,
      args: [...args],
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
    });
    return Promise.resolve(this.#respond(bin, args));
  }

  /** Every recorded call flattened to a single string (assertion convenience). */
  commandLines(): string[] {
    return this.calls.map((c) => `${c.bin} ${c.args.join(" ")}`);
  }

  #respond(bin: string, args: readonly string[]): HostCommandResult {
    if (bin.endsWith("limactl")) return this.#limactl(args);
    if (bin === "bash") return this.#guestBody(args[args.length - 1] ?? "");
    if (bin.endsWith("sudo") && args[0] === "install") {
      // no-lima copyIn: `sudo install -m <mode> <local> <dst>`.
      this.guestFiles.add(args[args.length - 1]);
      return ok();
    }
    return ok();
  }

  #limactl(args: readonly string[]): HostCommandResult {
    const [cmd, ...rest] = args;
    switch (cmd) {
      case "list": {
        if (rest.includes("-q")) return ok([...this.instances].join("\n"));
        const lines = [...this.instances].map((n) =>
          `${n}\t${this.running.has(n) ? "Running" : "Stopped"}`
        );
        return ok(lines.join("\n"));
      }
      case "start": {
        const nameFlag = rest.find((a) => a.startsWith("--name="));
        if (nameFlag !== undefined) {
          const name = nameFlag.slice("--name=".length);
          this.instances.add(name);
          this.running.add(name);
        } else {
          const name = rest.find((a) => !a.startsWith("--"));
          if (name !== undefined) {
            this.instances.add(name);
            this.running.add(name);
          }
        }
        return ok();
      }
      case "stop": {
        this.running.delete(rest[0]);
        return ok();
      }
      case "delete": {
        const name = rest[rest.length - 1];
        this.instances.delete(name);
        this.running.delete(name);
        return ok();
      }
      case "cp": {
        const dst = rest[1] ?? "";
        const colon = dst.indexOf(":");
        if (colon >= 0) this.guestFiles.add(dst.slice(colon + 1));
        return ok();
      }
      case "shell": {
        return this.#guestBody(args[args.length - 1] ?? "");
      }
      default:
        return ok();
    }
  }

  #guestBody(body: string): HostCommandResult {
    let inner = body;
    const sudoWrap = /^sudo -E bash -lc '([\s\S]*)'$/.exec(body);
    if (sudoWrap !== null) {
      inner = sudoWrap[1].replaceAll(`'\\''`, "'");
    }
    inner = inner.replace(/^set -euo pipefail;\s*/, "");

    if (/test -e \/dev\/kvm/.test(inner)) {
      return this.kvm ? ok() : failed();
    }
    const testFile = /test -f (\S+)/.exec(inner);
    if (testFile !== null) {
      return this.guestFiles.has(testFile[1]) ? ok() : failed();
    }
    const isActive = /systemctl is-active (\S+)/.exec(inner);
    if (isActive !== null) {
      const state = this.daemonActive.get(isActive[1]) ?? "inactive";
      return {
        success: state === "active",
        code: 0,
        stdout: state,
        stderr: "",
      };
    }
    return ok();
  }
}

/** An in-memory {@linkcode LocalFs} (no disk touched). */
export class FakeLocalFs implements LocalFs {
  readonly files = new Set<string>();
  #tempCounter = 0;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  writeSecretFile(path: string, _contents: string): Promise<void> {
    this.files.add(path);
    return Promise.resolve();
  }

  makeTempFile(_contents: string): Promise<string> {
    const path = `/tmp/fake-studiobox-token-${this.#tempCounter++}`;
    this.files.add(path);
    return Promise.resolve(path);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

/** A deterministic 32-byte token source (each call yields a distinct pattern). */
export function sequentialTokenFactory(): () => Uint8Array {
  let seed = 1;
  return () => new Uint8Array(32).fill(seed++);
}
