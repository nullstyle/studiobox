/**
 * Host-safe fakes for the CLI lifecycle tests. The generic `limactl` argv
 * state machine now lives in `@nullstyle/lima/testing`'s `FakeLimactl`;
 * {@linkcode FakeHostRunner} extends it with the studiobox-specific guest
 * semantics — golden-bake discriminators, `/dev/kvm`, `systemctl is-active` —
 * plus the `no-lima` host branch (`bash`, `git`, `tar`, `sudo install`).
 * Together with {@linkcode FakeLocalFs} they model a coherent host so the
 * lifecycle module is driven end to end with NO VM and the exact argv
 * sequence asserted (PLAN.md §M9).
 */

import type { CommandResult } from "@nullstyle/lima";
import {
  failed,
  FakeLimactl,
  type GuestScriptCall,
  ok,
  type RecordedCall,
} from "@nullstyle/lima/testing";
import type { LocalFs } from "../../../src/cli/local_fs.ts";

export type { RecordedCall };

/** Pseudo-instance key the `no-lima` host branch records guest files under. */
const NO_LIMA = "(no-lima)";

/** The studiobox extension of `FakeLimactl` (see the module doc). */
export class FakeHostRunner extends FakeLimactl {
  /** unit name -> `systemctl is-active` answer. */
  readonly daemonActive = new Map<string, string>();
  /** Whether `/dev/kvm` is present in the guest. */
  kvm = true;
  // --- golden-bake fakes (bake.ts) ---
  /** `git ls-files` output on the host (non-empty = a real checkout). */
  gitFiles = "deno.json\ntools/build_golden_set.ts\nsrc/agent/main.ts\n";
  /** Manifest hash the fake bake "prints" as its final JSON line. */
  bakeHash = "e".repeat(64);
  /** Cached golden hash the probe returns (empty = cache miss). */
  cachedGoldenHash = "";
  /** When true, the bake command exits nonzero. */
  bakeFails = false;

  /** Whether the named instance reports `Running`. */
  instanceRunning(name: string): boolean {
    return this.instances.get(name)?.status === "Running";
  }

  /** Whether a path is a guest file on ANY instance (or the no-lima host). */
  hasGuestFile(path: string): boolean {
    for (const files of this.guestFiles.values()) {
      if (files.has(path)) return true;
    }
    return false;
  }

  /**
   * Auto-vivify instances for `shell`/`cp` so HostEnv can be driven directly
   * (bake/provision tests) without a preceding `limactl start` — the leniency
   * the pre-extraction fake had.
   */
  protected override limactl(call: RecordedCall): CommandResult {
    const args = call.args;
    if (args[0] === "shell") {
      const name = args[1] === "--workdir" ? args[3] : args[1];
      if (name !== undefined && !this.instances.has(name)) {
        this.setInstance(name);
      }
    }
    if (args[0] === "cp") {
      for (const arg of args.slice(1)) {
        const colon = arg.indexOf(":");
        if (colon > 0 && !this.instances.has(arg.slice(0, colon))) {
          this.setInstance(arg.slice(0, colon));
        }
      }
    }
    return super.limactl(call);
  }

  protected override onGuestScript(
    call: GuestScriptCall,
  ): CommandResult | undefined {
    return this.#interpret(call.script, call.instance);
  }

  protected override onCommand(call: RecordedCall): CommandResult | undefined {
    const { bin, args } = call;
    if (bin === "bash") {
      return this.#guestBody(args[args.length - 1] ?? "");
    }
    if (bin.endsWith("sudo") && args[0] === "install") {
      // no-lima copyIn: `sudo install -m <mode> <local> <dst>`.
      this.guestFilesFor(NO_LIMA).add(args[args.length - 1]!);
      return ok();
    }
    // Host-side bake commands (HostEnv.hostExec / no-lima copyFileIn).
    if (bin === "git" && args.includes("ls-files")) return ok(this.gitFiles);
    if (bin === "tar") return ok();
    if (bin === "cp") return ok();
    return ok();
  }

  /** The `no-lima` guest path: unwrap sudo/strict, then interpret. */
  #guestBody(body: string): CommandResult {
    let inner = body;
    const sudoWrap = /^sudo -E bash -lc '([\s\S]*)'$/.exec(body);
    if (sudoWrap !== null) {
      inner = sudoWrap[1].replaceAll(`'\\''`, "'");
    }
    inner = inner.replace(/^set -euo pipefail;\s*/, "");
    return this.#interpret(inner, NO_LIMA);
  }

  /** Studiobox guest-script semantics (shared by the lima and no-lima paths). */
  #interpret(inner: string, instance: string): CommandResult {
    // --- golden-bake discriminators (order-independent; checked first) ---
    // Marker write: `printf '%s' <hash> | sudo tee …/golden.hash`. Record the
    // hash so a subsequent probe on the same runner is a cache hit.
    if (inner.includes("tee") && inner.includes("golden.hash")) {
      const m = /printf '%s' ([0-9a-f]{64})/.exec(inner);
      if (m !== null) this.cachedGoldenHash = m[1];
      return ok();
    }
    // Cache probe: `[ -f …/golden.hash ]; … [ -d …/cache/$h ] && printf …`.
    if (inner.includes("golden.hash") && inner.includes("[ -d")) {
      return ok(this.cachedGoldenHash);
    }
    // The bake itself: `… deno run … tools/build_golden_set.ts … | tail -n1`.
    if (inner.includes("build_golden_set.ts")) {
      return this.bakeFails ? failed(1) : ok(JSON.stringify({
        hash: this.bakeHash,
        cacheRoot: "/var/lib/studiobox/cache",
        created: true,
        arch: "aarch64",
      }));
    }

    if (/test -e \/dev\/kvm/.test(inner)) {
      return this.kvm ? ok() : failed(1);
    }
    // lima copyIn's second half: `install -m <mode> '<staging>' '<dest>' && rm …`
    // run via the sudo guest-exec path. The file lands at its FINAL <dest> here
    // (the preceding `limactl cp` only staged it), so record <dest> as a guest
    // file — mirroring the no-lima `sudo install` handler in onCommand.
    const installFile = /install -m \S+ '[^']*' '([^']*)'/.exec(inner);
    if (installFile !== null) {
      this.guestFilesFor(instance).add(installFile[1]);
      return ok();
    }
    const testFile = /test -f (\S+)/.exec(inner);
    if (testFile !== null) {
      return this.hasGuestFile(testFile[1]) ? ok() : failed(1);
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
