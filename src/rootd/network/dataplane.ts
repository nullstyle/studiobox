/**
 * Host-side network provisioning for the Tier-B dataplane
 * (DESIGN networking-dataplane.md §3, §10).
 *
 * {@linkcode NetworkController} is the imperative shell that turns a
 * {@linkcode SubnetAllocation} into live host state: the one-time global NAT /
 * isolation seal ({@linkcode NetworkController.ensureGlobal}) and the
 * per-sandbox TAP provisioning ({@linkcode NetworkController.provision}) /
 * teardown ({@linkcode NetworkController.teardown}). Every host mutation goes
 * through the same injected {@linkcode CommandRunner} seam as the egress engine
 * (`apply.ts`), so the exact `ip` / `sysctl` / `nft` argv is asserted in unit
 * tests with **no host mutation**.
 *
 * The whole dataplane is host-namespace (point-to-point `/30` TAP per sandbox,
 * host is gateway + NAT); there is no netns. Inter-sandbox isolation is the
 * shared `studiobox_isolation` forward-drop, not a bridge separation.
 *
 * @module
 */

import type { CommandRunner, EgressCommandResult } from "./apply.ts";
import { DenoCommandRunner } from "./apply.ts";
import {
  DEFAULT_POOL_CIDR,
  type SubnetAllocation,
  TAP_NAME_PREFIX,
} from "./allocator.ts";

/** The shared masquerade table installed once by {@linkcode NetworkController.ensureGlobal}. */
export const STUDIOBOX_NAT_TABLE = "studiobox_nat";
/** The shared inter-sandbox forward-drop table installed once at rootd start. */
export const STUDIOBOX_ISOLATION_TABLE = "studiobox_isolation";
/**
 * The shared guest→host INPUT-hook guard installed once at rootd start (§12).
 * All per-sandbox filtering is FORWARD-hook only, so without this a guest could
 * reach host-local services (its own gateway, `0.0.0.0` listeners, any host LAN
 * IP) — bypassing a RESTRICTED `allowNet`. The guard permits only DNS to the
 * per-sandbox dnsmasq (on the gateway) plus ICMP echo, and DROPs every other
 * `sbxtap*`-sourced input, closing host reachability for BOTH restricted and
 * unrestricted sandboxes.
 */
export const STUDIOBOX_HOSTGUARD_TABLE = "studiobox_hostguard";

/** `/30` — the fixed per-sandbox subnet width the host gateway address takes. */
const SUBNET_PREFIX = 30;

/**
 * Substrings in an `ip link del` / `nft delete` stderr that mean the resource
 * was already gone — treated as teardown success (§3 idempotency). Mirrors the
 * egress engine's idempotent `add;delete` reclaim discipline.
 */
const GONE_MARKERS: readonly string[] = [
  "Cannot find device",
  "No such device",
  "No such file",
  "does not exist",
  "No such table",
];

/** Substrings meaning a create step raced an existing resource (crash-restart). */
const EXISTS_MARKERS: readonly string[] = [
  "File exists",
];

/** Options for {@linkcode NetworkController}. */
export interface NetworkControllerOptions {
  /** Injected subprocess seam (reused from the egress engine). */
  readonly runner?: CommandRunner;
  /** Path to the `ip` binary. @default "ip" */
  readonly ipBin?: string;
  /** Path to the `sysctl` binary. @default "sysctl" */
  readonly sysctlBin?: string;
  /** Path to the `nft` binary. @default "nft" */
  readonly nftBin?: string;
  /**
   * Pool CIDR the shared masquerade / isolation rules scope to. Must match the
   * {@linkcode import("./allocator.ts").BitmapSubnetAllocator} pool.
   * @default "10.201.0.0/16"
   */
  readonly poolCidr?: string;
}

/** The jailer drop-to ids the TAP is created owned by (§3). */
export interface NetworkProvisionOptions {
  /** Firecracker process uid (TAP `user`). */
  readonly uid: number;
  /** Firecracker process gid (TAP `group`). */
  readonly gid: number;
}

/** Raised when a host network command fails unexpectedly (not "already gone"). */
export class NetworkControllerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NetworkControllerError";
  }
}

/**
 * Provisions and tears down host-side networking through an injected runner.
 * Stateless between calls: everything a teardown needs comes from the
 * {@linkcode SubnetAllocation} (which is journaled), so a cold reconcile with no
 * live in-memory state can still reclaim.
 */
export class NetworkController {
  readonly #runner: CommandRunner;
  readonly #ipBin: string;
  readonly #sysctlBin: string;
  readonly #nftBin: string;
  readonly #poolCidr: string;

  constructor(options: NetworkControllerOptions = {}) {
    this.#runner = options.runner ?? new DenoCommandRunner();
    this.#ipBin = options.ipBin ?? "ip";
    this.#sysctlBin = options.sysctlBin ?? "sysctl";
    this.#nftBin = options.nftBin ?? "nft";
    this.#poolCidr = options.poolCidr ?? DEFAULT_POOL_CIDR;
  }

  /**
   * One-time, idempotent global setup (§3, §12): enable IPv4 forwarding, then
   * install the shared `studiobox_nat` masquerade, the `studiobox_isolation`
   * forward-drop, and the `studiobox_hostguard` guest→host INPUT guard as atomic
   * `add;delete;add` `nft` scripts (re-apply replaces, never appends). Safe to
   * call on every rootd start.
   */
  async ensureGlobal(): Promise<void> {
    await this.#sysctl("net.ipv4.ip_forward=1");
    await this.#nft(this.#natScript());
    await this.#nft(this.#isolationScript());
    await this.#nft(this.#hostguardScript());
  }

  /**
   * Per-sandbox provisioning, ordered, run before firecracker boots (§3): create
   * the TAP owned by the firecracker uid/gid, give the host its gateway address,
   * bring it up, and permit loopback-sourced DNAT (exposeHttp) on it. The two
   * create steps tolerate an "already exists" stderr for crash-restart
   * idempotency; every other failure is fatal to the launch.
   */
  async provision(
    alloc: SubnetAllocation,
    options: NetworkProvisionOptions,
  ): Promise<void> {
    const tap = alloc.tapName;
    // a. Create the TAP owned by the firecracker uid so the jailed process may
    //    open it. Tolerate "File exists" for crash-restart idempotency.
    await this.#ip(
      [
        "tuntap",
        "add",
        "dev",
        tap,
        "mode",
        "tap",
        "user",
        String(options.uid),
        "group",
        String(options.gid),
      ],
      { tolerate: EXISTS_MARKERS },
    );
    // b. Give the host its gateway address on the TAP.
    await this.#ip(
      ["addr", "add", `${alloc.hostIp}/${SUBNET_PREFIX}`, "dev", tap],
      { tolerate: EXISTS_MARKERS },
    );
    // c. Bring it up.
    await this.#ip(["link", "set", "dev", tap, "up"]);
    // d. Permit loopback-sourced DNAT to this TAP (exposeHttp, §6), set now so a
    //    later exposeHttp needs no extra host mutation.
    await this.#sysctl(`net.ipv4.conf.${tap}.route_localnet=1`);
  }

  /**
   * Tear a sandbox's TAP down (§3). `ip link del` removes the address + link
   * atomically and is gone-tolerant: an "already gone" stderr is treated as
   * success so teardown composes with the destructive restart reconcile. The
   * shared `studiobox_nat` / `studiobox_isolation` tables are **not** touched.
   */
  async teardown(alloc: SubnetAllocation): Promise<void> {
    await this.#ip(["link", "del", "dev", alloc.tapName], {
      tolerate: GONE_MARKERS,
    });
  }

  #natScript(): string {
    return [
      `add table ip ${STUDIOBOX_NAT_TABLE}`,
      `delete table ip ${STUDIOBOX_NAT_TABLE}`,
      `table ip ${STUDIOBOX_NAT_TABLE} {`,
      "\tchain postrouting {",
      "\t\ttype nat hook postrouting priority srcnat; policy accept;",
      `\t\tip saddr ${this.#poolCidr} oifname != "${TAP_NAME_PREFIX}*" masquerade`,
      "\t}",
      "}",
      "",
    ].join("\n");
  }

  #isolationScript(): string {
    return [
      `add table inet ${STUDIOBOX_ISOLATION_TABLE}`,
      `delete table inet ${STUDIOBOX_ISOLATION_TABLE}`,
      `table inet ${STUDIOBOX_ISOLATION_TABLE} {`,
      "\tchain forward {",
      "\t\ttype filter hook forward priority -10; policy accept;",
      `\t\tip saddr ${this.#poolCidr} ip daddr ${this.#poolCidr} drop`,
      "\t}",
      "}",
      "",
    ].join("\n");
  }

  /**
   * The shared guest→host INPUT guard (§12). Scoped to `iifname "sbxtap*"` so it
   * only judges guest-sourced traffic. In order it: accepts established/related
   * return traffic (the reply path of an `exposeHttp` host→guest forward, which
   * lands here as locally-destined INPUT); permits DNS (udp/tcp `:53`) **only to
   * a pool gateway address** (`ip daddr <poolCidr>` — the guest's own dnsmasq,
   * never the host's own resolver); permits ICMP/ICMPv6 echo (PMTU +
   * diagnostics); then DROPs every other guest→host packet. Host-originated and
   * forwarded traffic never match the `sbxtap*` iifname, so this neither blocks
   * forwarded egress (the per-sandbox forward filter's job) nor touches
   * exposeHttp's output/postrouting DNAT/SNAT.
   */
  #hostguardScript(): string {
    const tap = `${TAP_NAME_PREFIX}*`;
    return [
      `add table inet ${STUDIOBOX_HOSTGUARD_TABLE}`,
      `delete table inet ${STUDIOBOX_HOSTGUARD_TABLE}`,
      `table inet ${STUDIOBOX_HOSTGUARD_TABLE} {`,
      "\tchain input {",
      "\t\ttype filter hook input priority -10; policy accept;",
      `\t\tiifname "${tap}" ct state established,related accept`,
      `\t\tiifname "${tap}" ip daddr ${this.#poolCidr} udp dport 53 accept`,
      `\t\tiifname "${tap}" ip daddr ${this.#poolCidr} tcp dport 53 accept`,
      `\t\tiifname "${tap}" icmp type echo-request accept`,
      `\t\tiifname "${tap}" icmpv6 type echo-request accept`,
      `\t\tiifname "${tap}" drop`,
      "\t}",
      "}",
      "",
    ].join("\n");
  }

  /**
   * Delete an nft table by exact family + name, idempotently — the `add;delete`
   * pair is a clean no-op when the table is already gone. Used by the startup
   * network-orphan sweep (`orphan_sweep.ts`) to reap a crashed launch's leaked
   * `sbx_eg_<id>` / `sbx_pf_<id>` table for which no journaled record survives to
   * key {@linkcode import("./apply.ts").EgressController.reclaim}. Conservative:
   * the caller only ever passes a studiobox-prefixed name.
   */
  async reapTable(family: "ip" | "inet", name: string): Promise<void> {
    await this.#nft(
      [`add table ${family} ${name}`, `delete table ${family} ${name}`, ""]
        .join("\n"),
    );
  }

  /** Run one `ip …` command; tolerate the given stderr markers, else throw. */
  async #ip(
    args: readonly string[],
    options: { readonly tolerate?: readonly string[] } = {},
  ): Promise<void> {
    const result = await this.#runner.run(this.#ipBin, args, "");
    this.#check(this.#ipBin, args, result, options.tolerate ?? []);
  }

  /** Run one `sysctl -w <kv>` command; any failure is fatal. */
  async #sysctl(kv: string): Promise<void> {
    const args = ["-w", kv];
    const result = await this.#runner.run(this.#sysctlBin, args, "");
    this.#check(this.#sysctlBin, args, result, []);
  }

  /** Run one `nft -f -` script; any failure is fatal (add;delete;add is idempotent). */
  async #nft(script: string): Promise<void> {
    const args = ["-f", "-"];
    const result = await this.#runner.run(this.#nftBin, args, script);
    this.#check(this.#nftBin, args, result, []);
  }

  #check(
    bin: string,
    args: readonly string[],
    result: EgressCommandResult,
    tolerate: readonly string[],
  ): void {
    if (result.success) return;
    if (tolerate.some((marker) => result.stderr.includes(marker))) return;
    throw new NetworkControllerError(
      `${bin} ${args.join(" ")} failed (exit ${result.code}): ${result.stderr}`,
    );
  }
}
