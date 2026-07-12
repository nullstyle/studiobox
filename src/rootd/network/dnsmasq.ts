/**
 * Per-sandbox dnsmasq lifecycle for the Tier-B dataplane
 * (DESIGN networking-dataplane.md §5).
 *
 * The egress engine already *renders* the dnsmasq config fragment
 * (`renderDnsmasqFragment`, `ruleset.ts`); nothing installs or reaps the
 * process. {@linkcode DnsmasqController} closes that gap with the same
 * injected-seam discipline as the egress engine: the spawn goes through an
 * injected {@linkcode CommandRunner}, the conf-file write through an injected
 * {@linkcode FileWriter}, and the reap kill through an injected
 * {@linkcode ProcessSignaller} — so install / reap render the exact argv and
 * file contents with **no real dnsmasq**.
 *
 * One dnsmasq per non-netless sandbox, bound only to its own gateway
 * (`<hostIp>` on `sbxtap<slot>`), reachable by that sandbox alone. The
 * **pidfile is the authoritative teardown key** — it survives a rootd crash and
 * is journaled (`resources.dnsmasqPidfile`, §9), so reap needs no live child
 * handle.
 *
 * The config body is produced by the already-pure `renderDnsmasqFragment` and
 * transported unchanged, so the ruleset's authoritative `@blocked4/@blocked6`
 * anti-poison seal is never weakened (§5, §12).
 *
 * @module
 */

import type { CommandRunner } from "./apply.ts";
import { DenoCommandRunner } from "./apply.ts";
import type { SubnetAllocation } from "./allocator.ts";

/** Directory holding per-sandbox dnsmasq pid + conf files. */
export const DNS_RUN_DIR = "/run/studiobox/dns";

/** Injected file-write seam (conf-file) so tests never touch the host FS. */
export interface FileWriter {
  write(path: string, contents: string): Promise<void>;
}

/** Injected file-read seam (pidfile) so reap can recover the pid to signal. */
export interface FileReader {
  read(path: string): Promise<string>;
}

/** Injected file-remove seam (pid + conf unlink), gone-tolerant by the caller. */
export interface FileRemover {
  remove(path: string): Promise<void>;
}

/** Injected process-signal seam so reap's SIGKILL is asserted, not delivered. */
export interface ProcessSignaller {
  signal(pid: number, signal: string): void;
}

/** Default {@linkcode FileWriter} backed by `Deno.writeTextFile`. */
export class DenoFileWriter implements FileWriter {
  write(path: string, contents: string): Promise<void> {
    return Deno.writeTextFile(path, contents);
  }
}

/** Default {@linkcode FileReader} backed by `Deno.readTextFile`. */
export class DenoFileReader implements FileReader {
  read(path: string): Promise<string> {
    return Deno.readTextFile(path);
  }
}

/** Default {@linkcode FileRemover} backed by `Deno.remove`. */
export class DenoFileRemover implements FileRemover {
  remove(path: string): Promise<void> {
    return Deno.remove(path);
  }
}

/** Default {@linkcode ProcessSignaller} backed by `Deno.kill`. */
export class DenoProcessSignaller implements ProcessSignaller {
  signal(pid: number, signal: string): void {
    Deno.kill(pid, signal as Deno.Signal);
  }
}

/** Options for {@linkcode DnsmasqController}. */
export interface DnsmasqControllerOptions {
  /** Injected subprocess seam (reused from the egress engine). */
  readonly runner?: CommandRunner;
  /** Injected conf-file writer. @default {@linkcode DenoFileWriter} */
  readonly writer?: FileWriter;
  /** Injected pidfile reader. @default {@linkcode DenoFileReader} */
  readonly reader?: FileReader;
  /** Injected pid + conf remover. @default {@linkcode DenoFileRemover} */
  readonly remover?: FileRemover;
  /** Injected process signaller. @default {@linkcode DenoProcessSignaller} */
  readonly signaller?: ProcessSignaller;
  /** Path to the `dnsmasq` binary. @default "dnsmasq" */
  readonly dnsmasqBin?: string;
  /** Directory for pid + conf files. @default "/run/studiobox/dns" */
  readonly runDir?: string;
}

/** What {@linkcode DnsmasqController.install} spawned, for the journal (§9). */
export interface DnsmasqInstance {
  /** Authoritative teardown key, `/run/studiobox/dns/<slot>.pid` (journaled). */
  readonly pidfile: string;
  /** Conf-file path when a non-empty fragment was written, else `undefined`. */
  readonly confFile?: string;
}

/** Per-`install` inputs (§5). */
export interface DnsmasqInstallOptions {
  /**
   * The dnsmasq config fragment from `renderDnsmasqFragment` — `stop-dns-rebind`
   * plus one `nftset=` line per wildcard, or `""` for a plain forwarder. When
   * empty, no conf-file is written and no `--conf-file` argument is passed.
   */
  readonly fragment: string;
  /** Upstream resolver the host-side forwarder queries (`--server=<upstream>`). */
  readonly upstream: string;
}

/**
 * Spawns and reaps a sandbox's dnsmasq. Stateless between calls: install writes
 * the conf-file and spawns daemonized (pidfile-tracked); reap recovers the pid
 * from the journaled pidfile and SIGKILLs it, then unlinks pid + conf. Every
 * step is gone-tolerant so reap composes with the destructive reconcile (§8).
 */
export class DnsmasqController {
  readonly #runner: CommandRunner;
  readonly #writer: FileWriter;
  readonly #reader: FileReader;
  readonly #remover: FileRemover;
  readonly #signaller: ProcessSignaller;
  readonly #dnsmasqBin: string;
  readonly #runDir: string;

  constructor(options: DnsmasqControllerOptions = {}) {
    this.#runner = options.runner ?? new DenoCommandRunner();
    this.#writer = options.writer ?? new DenoFileWriter();
    this.#reader = options.reader ?? new DenoFileReader();
    this.#remover = options.remover ?? new DenoFileRemover();
    this.#signaller = options.signaller ?? new DenoProcessSignaller();
    this.#dnsmasqBin = options.dnsmasqBin ?? "dnsmasq";
    this.#runDir = options.runDir ?? DNS_RUN_DIR;
  }

  /** Absolute pidfile path for a slot, `<runDir>/<slot>.pid`. */
  pidfilePath(slot: number): string {
    return `${this.#runDir}/${slot}.pid`;
  }

  /** Absolute conf-file path for a slot, `<runDir>/<slot>.conf`. */
  confPath(slot: number): string {
    return `${this.#runDir}/${slot}.conf`;
  }

  /**
   * Spawn the sandbox's dnsmasq (§5). Bound to `<hostIp>` on `sbxtap<slot>`
   * only, daemonized with a pidfile, forwarding to `<upstream>`. When the
   * fragment is non-empty its contents are written to `<slot>.conf` and passed
   * via `--conf-file`; an empty fragment runs a plain forwarder with no
   * conf-file. Returns the pidfile (+ conf-file) to journal.
   */
  async install(
    alloc: SubnetAllocation,
    options: DnsmasqInstallOptions,
  ): Promise<DnsmasqInstance> {
    const pidfile = this.pidfilePath(alloc.slot);
    const hasFragment = options.fragment.length > 0;
    const confFile = hasFragment ? this.confPath(alloc.slot) : undefined;
    if (confFile !== undefined) {
      await this.#writer.write(confFile, options.fragment);
    }
    const args = [
      "--keep-in-foreground=false",
      `--pid-file=${pidfile}`,
      `--listen-address=${alloc.hostIp}`,
      "--bind-interfaces",
      `--interface=${alloc.tapName}`,
      "--except-interface=lo",
      "--no-resolv",
      `--server=${options.upstream}`,
      ...(confFile !== undefined ? [`--conf-file=${confFile}`] : []),
    ];
    const result = await this.#runner.run(this.#dnsmasqBin, args, "");
    if (!result.success) {
      throw new DnsmasqError(
        `dnsmasq spawn failed (exit ${result.code}): ${result.stderr}`,
      );
    }
    return confFile === undefined ? { pidfile } : { pidfile, confFile };
  }

  /**
   * Reap the sandbox's dnsmasq (§5, §8). Reads the pid from `pidfile`, SIGKILLs
   * it, then unlinks the pidfile and its sibling conf-file. Every step tolerates
   * "already gone": a missing pidfile means the process is already reaped (skip
   * the kill), a dead pid means SIGKILL is a no-op, and a missing file means the
   * unlink is a no-op — so reap is a clean nothing-to-do on a cold reconcile.
   */
  async reap(pidfile: string): Promise<void> {
    const pid = await this.#readPid(pidfile);
    if (pid !== undefined) {
      try {
        this.#signaller.signal(pid, "SIGKILL");
      } catch {
        // Process already gone (ESRCH) or unsignalable — teardown is best-effort.
      }
    }
    await this.#unlink(pidfile);
    await this.#unlink(confPathFor(pidfile));
  }

  /** Read + parse the pidfile, or `undefined` if it is gone / unparseable. */
  async #readPid(pidfile: string): Promise<number | undefined> {
    let contents: string;
    try {
      contents = await this.#reader.read(pidfile);
    } catch {
      return undefined; // Already reaped: no pidfile ⇒ nothing to kill.
    }
    const pid = Number.parseInt(contents.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  /** Best-effort unlink; a missing file is success. */
  async #unlink(path: string): Promise<void> {
    try {
      await this.#remover.remove(path);
    } catch {
      // Already gone — teardown is idempotent.
    }
  }
}

/** Raised when a dnsmasq spawn fails. Fatal to the launch (§5). */
export class DnsmasqError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DnsmasqError";
  }
}

/** Derive the sibling conf-file path from a `<slot>.pid` pidfile path. */
function confPathFor(pidfile: string): string {
  return pidfile.replace(/\.pid$/, ".conf");
}
