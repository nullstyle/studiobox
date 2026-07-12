/**
 * Apply-time hostname resolution for the egress ruleset.
 *
 * DESIGN.md §5 specifies that `allowNet` hostnames are "resolved at rule-apply
 * time". This module turns a parsed {@linkcode EgressSpec} into a
 * {@linkcode ResolvedEgress} — the concrete IP addresses (and the residual
 * wildcard domains) that the pure ruleset generator consumes.
 *
 * Two kinds of pattern resolve differently:
 *
 * - **Exact hostnames** are resolved here, once, by A / AAAA lookup. The
 *   resulting IPs are baked into the sandbox's nft sets at apply time. This is
 *   a point-in-time snapshot: a record whose A record changes mid-life is not
 *   re-resolved until the ruleset is re-applied. (See `docs/networking.md` for
 *   the rationale and the DNS-rebinding note.)
 * - **Wildcard subdomains** (`*.example.com`) cannot be enumerated up front, so
 *   they are *not* resolved here. They flow through as residual
 *   {@linkcode ResolvedWildcard} entries; the ruleset generator emits a named
 *   nft set per wildcard plus a dnsmasq fragment that keeps that set in sync as
 *   the guest resolves subdomains through the sandbox resolver. IP literals
 *   pass straight through with no lookup.
 *
 * The {@linkcode HostResolver} seam is injectable so unit tests stay pure and
 * host-safe (no real DNS); the default binds to `Deno.resolveDns`.
 *
 * @module
 */

import type { EgressPattern, EgressSpec } from "./spec.ts";

/** A/AAAA answers for one hostname. */
export interface ResolvedAddresses {
  readonly v4: readonly string[];
  readonly v6: readonly string[];
}

/** Injectable DNS seam. The default implementation uses `Deno.resolveDns`. */
export interface HostResolver {
  resolve(hostname: string): Promise<ResolvedAddresses>;
}

/** A wildcard domain the ruleset generator turns into a dnsmasq-synced set. */
export interface ResolvedWildcard {
  /** Stable per-spec index; names the backing nft sets (`wild4_<index>`). */
  readonly index: number;
  /** The base domain (`example.com` for `*.example.com`). */
  readonly baseDomain: string;
  /** Optional port scoping; absent means all ports to any matched subdomain. */
  readonly port?: number;
}

/** Fully resolved egress intent, ready for pure ruleset generation. */
export type ResolvedEgress =
  | { readonly mode: "unrestricted" }
  | {
    readonly mode: "restricted";
    /** IPv4 addresses allowed on all ports. */
    readonly exact4: readonly string[];
    /** IPv6 addresses allowed on all ports. */
    readonly exact6: readonly string[];
    /** (IPv4, port) pairs allowed only on that port. */
    readonly exact4Port: readonly (readonly [string, number])[];
    /** (IPv6, port) pairs allowed only on that port. */
    readonly exact6Port: readonly (readonly [string, number])[];
    /** Residual wildcard domains (dnsmasq-synced at run time). */
    readonly wildcards: readonly ResolvedWildcard[];
  };

/** How a hostname that fails to resolve is treated. */
export interface ResolveOptions {
  /**
   * When `true` (the default) a hostname that resolves to nothing (NXDOMAIN,
   * empty answer) is simply contributed no addresses — it becomes unreachable,
   * which is the fail-closed outcome. When `false`, such a hostname raises so
   * the caller can abort the launch instead of silently sealing one host.
   */
  readonly tolerateEmpty?: boolean;
}

/** Default resolver backed by `Deno.resolveDns` (needs `--allow-net`). */
export class DenoHostResolver implements HostResolver {
  async resolve(hostname: string): Promise<ResolvedAddresses> {
    const [v4, v6] = await Promise.all([
      Deno.resolveDns(hostname, "A").catch(() => [] as string[]),
      Deno.resolveDns(hostname, "AAAA").catch(() => [] as string[]),
    ]);
    return { v4, v6 };
  }
}

/**
 * Resolve a parsed spec into concrete addresses + residual wildcards.
 *
 * Pure with respect to the host *except* for the injected {@linkcode
 * HostResolver}; pass a fake resolver in tests to keep them offline.
 */
export async function resolveSpec(
  spec: EgressSpec,
  resolver: HostResolver,
  options: ResolveOptions = {},
): Promise<ResolvedEgress> {
  if (spec.mode === "unrestricted") return { mode: "unrestricted" };

  const tolerateEmpty = options.tolerateEmpty ?? true;
  const exact4 = new Set<string>();
  const exact6 = new Set<string>();
  const exact4Port = new Map<string, readonly [string, number]>();
  const exact6Port = new Map<string, readonly [string, number]>();
  const wildcards: ResolvedWildcard[] = [];

  const addIp = (
    family: "v4" | "v6",
    address: string,
    port: number | undefined,
  ): void => {
    if (port === undefined) {
      (family === "v4" ? exact4 : exact6).add(address);
    } else {
      const map = family === "v4" ? exact4Port : exact6Port;
      map.set(`${address}#${port}`, [address, port]);
    }
  };

  for (const pattern of spec.patterns) {
    if (pattern.kind === "ip") {
      addIp(pattern.family, pattern.address, pattern.port);
      continue;
    }
    if (pattern.kind === "wildcard") {
      wildcards.push({
        index: wildcards.length,
        baseDomain: pattern.host,
        ...(pattern.port === undefined ? {} : { port: pattern.port }),
      });
      continue;
    }
    // Exact hostname: resolve now.
    const { v4, v6 } = await resolver.resolve(pattern.host);
    if (v4.length === 0 && v6.length === 0 && !tolerateEmpty) {
      throw new EgressResolveError(pattern);
    }
    for (const address of v4) addIp("v4", address, pattern.port);
    for (const address of v6) addIp("v6", address.toLowerCase(), pattern.port);
  }

  return {
    mode: "restricted",
    exact4: [...exact4].sort(),
    exact6: [...exact6].sort(),
    exact4Port: [...exact4Port.values()].sort(comparePortPair),
    exact6Port: [...exact6Port.values()].sort(comparePortPair),
    wildcards,
  };
}

function comparePortPair(
  a: readonly [string, number],
  b: readonly [string, number],
): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

/** Raised (only when `tolerateEmpty` is off) for a hostname with no answers. */
export class EgressResolveError extends Error {
  readonly pattern: EgressPattern;
  constructor(pattern: EgressPattern) {
    super("egress hostname resolved to no addresses");
    this.name = "EgressResolveError";
    this.pattern = pattern;
  }
}
