/**
 * Pure nftables ruleset generation for per-sandbox egress.
 *
 * Given a {@linkcode ResolvedEgress} (from `resolver.ts`) and a sandbox's
 * {@linkcode SandboxNetworkHandle}, {@linkcode generateRuleset} builds the
 * structured {@linkcode NftRuleset} and {@linkcode renderNftScript} /
 * {@linkcode renderApplyScript} turn it into an `nft -f` script. Everything in
 * this module is a pure function — no DNS, no subprocesses, no host state — so
 * it can be asserted byte-for-byte in unit tests.
 *
 * ## The model (DESIGN.md §5, §8)
 *
 * Each sandbox owns exactly one nftables table `inet <egressTableName>`
 * containing one base chain (`egress`, `type filter hook forward priority 0`)
 * and its allow sets. Isolating each sandbox in its *own table* (rather than
 * sharing a table and threading per-sandbox jump rules through it) means
 * `reclaim()` is a single `delete table inet <name>` that atomically removes the
 * chain and every set — no shared state to sweep, satisfying the DESIGN.md §8
 * "remove exact named resources, never wildcard-sweep" rule.
 *
 * The base chain's policy is **accept**, and the first rule short-circuits
 * traffic that did not arrive on this sandbox's TAP (`iifname != "<tap>"
 * accept`). This is deliberate: a base-chain `policy drop` applies to *every*
 * packet at the forward hook and would blackhole unrelated traffic. Because a
 * base-chain `accept` verdict is non-terminal across tables, each sandbox's
 * table judges only its own TAP's packets and defers everything else. For this
 * sandbox's TAP the chain is default-deny: established/related and the explicit
 * allow rules `accept`, and a trailing `drop` seals the rest.
 *
 * Rule order for a restricted sandbox:
 *
 * 1. `iifname != "<tap>" accept` — not ours; let other tables decide.
 * 2. `ip saddr != <guestIp> drop` (and the IPv6 form) — anti-spoof.
 * 3. `ct state established,related accept` — return + related flows.
 * 4. DNS to the configured resolver(s) on port 53 (udp + tcp).
 * 5. the allow rules (exact IPs, port-scoped pairs, wildcard sets).
 * 6. `drop` — default-deny.
 *
 * An **unrestricted** sandbox (unset `allowNet`) still gets a table for
 * lifecycle symmetry, but its chain has an empty body (policy accept), so the
 * TAP's egress is unfiltered — parity with upstream's unset `allowNet`.
 *
 * @module
 */

import { parseIpLiteral } from "./spec.ts";
import type { ResolvedEgress, ResolvedWildcard } from "./resolver.ts";

/** Everything the ruleset needs about one sandbox's host-side network. */
export interface SandboxNetworkHandle {
  /** Stable sandbox id; derives the nft table name. */
  readonly sandboxId: string;
  /** Host-side TAP device the guest NIC is bridged to (`iifname`). */
  readonly tapDevice: string;
  /**
   * Network namespace the rules are applied in. Optional: when set, `apply()`
   * runs `nft` via `ip netns exec <netns>`; the rules themselves are identical.
   */
  readonly netns?: string;
  /** The guest's IPv4 source address (anti-spoof + documentation). */
  readonly guestIp: string;
  /** The guest's IPv6 source address, if it has one. */
  readonly guestIp6?: string;
}

/** Tunables for {@linkcode generateRuleset}. */
export interface EgressRulesetOptions {
  /**
   * Resolver IP addresses reachable on port 53 (udp + tcp) even under a
   * restricted policy — the sandbox's dnsmasq. Without at least one, a
   * restricted sandbox cannot resolve names (and wildcard sets never fill).
   */
  readonly resolvers?: readonly string[];
}

/** A declared nft named set. */
export interface NftSet {
  readonly name: string;
  /** nft set type spec, e.g. `ipv4_addr` or `ipv4_addr . inet_service`. */
  readonly type: string;
  /** Pre-rendered element tokens (already validated / normalized). */
  readonly elements: readonly string[];
  /**
   * Optional set flags, e.g. `["interval"]` for a set that holds CIDR ranges.
   * Rendered as `flags interval` inside the set body.
   */
  readonly flags?: readonly string[];
}

/** The structured, host-independent egress ruleset for one sandbox. */
export interface NftRuleset {
  readonly family: "inet";
  readonly tableName: string;
  readonly chainName: string;
  readonly sets: readonly NftSet[];
  /** Chain body rule lines (excludes the `type ... hook ...` declaration). */
  readonly rules: readonly string[];
  /** True when the sandbox is unrestricted (empty chain body, allow-all). */
  readonly unrestricted: boolean;
}

const CHAIN_NAME = "egress";
const HOOK_DECL = "type filter hook forward priority 0; policy accept;";
const DNS_PORT = 53;
const TAP_NAME = /^[A-Za-z0-9_.-]{1,15}$/;
const TABLE_TOKEN = /^[a-z0-9_]+$/;
const TABLE_PREFIX = "sbx_eg_";
/**
 * Upper bound on the raw sandbox-id byte length. The injective token encoding
 * (see {@linkcode egressTableName}) expands each byte to at most 3 output chars,
 * so `sbx_eg_` + 3·len must stay within nft's identifier length; this bound
 * keeps every produced name well under 255 and fails closed on absurd ids.
 */
const MAX_ID_BYTES = 80;
const textEncoder = new TextEncoder();

/**
 * IPv4 ranges a dnsmasq-populated wildcard set must never grant egress to:
 * RFC-1918 private space, CGNAT, link-local (incl. the `169.254.169.254`
 * cloud-metadata address), and loopback. Held in an `interval`-flagged nft set
 * and used to gate every wildcard accept (see {@linkcode appendWildcard}).
 */
const BLOCKED4_SET = "blocked4";
const BLOCKED4_RANGES: readonly string[] = [
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
];
/** IPv6 counterpart to {@linkcode BLOCKED4_RANGES}: loopback, ULA, link-local. */
const BLOCKED6_SET = "blocked6";
const BLOCKED6_RANGES: readonly string[] = [
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

/**
 * Injectively encode a raw sandbox id into nft's identifier charset
 * (`[a-z0-9_]`). The mapping must be **collision-free** across distinct ids —
 * a hostile launcher must not be able to steer two different-but-valid ids onto
 * one nft table (which would let one sandbox overwrite or reclaim another's
 * egress). See {@linkcode egressTableName}.
 *
 * Bytes that are already unambiguous lowercase identifier characters (`a-z`,
 * `0-9`) pass through as themselves; **every other byte** — including `_`,
 * uppercase, `-`, `.`, and any non-ASCII — is escaped as `_<2-hex>`. Because
 * `_` is emitted *only* as an escape introducer (never as a literal) and each
 * escape is a fixed 3 chars, the output decodes back to the exact input bytes,
 * so the encoding is a bijection: `"sbx-audit"` and `"sbx-AUDIT"`, or
 * `"sbx-a-b"` and `"sbx-a_b"`, can never collide.
 */
function encodeIdToken(id: string): string {
  const bytes = textEncoder.encode(id);
  let out = "";
  for (const b of bytes) {
    const lower = b >= 0x61 && b <= 0x7a; // a-z
    const digit = b >= 0x30 && b <= 0x39; // 0-9
    if (lower || digit) {
      out += String.fromCharCode(b);
    } else {
      out += "_" + b.toString(16).padStart(2, "0");
    }
  }
  return out;
}

/** Raised when a handle or option would produce an invalid / unsafe ruleset. */
export class EgressRulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressRulesetError";
  }
}

/**
 * Derive the per-sandbox nft table name. Deterministic (apply and reclaim must
 * agree), constrained to nft's identifier charset, and — critically —
 * **injective**: distinct sandbox ids always yield distinct table names.
 *
 * The old implementation folded the id (`toLowerCase` + collapse every
 * non-`[a-z0-9_]` char to `_`), which was *not* injective: case- or
 * separator-only variants such as `"sbx-audit"`/`"sbx-AUDIT"` and
 * `"sbx-a-b"`/`"sbx-a_b"` collided onto one table, letting a hostile launcher
 * overwrite or reclaim a victim sandbox's egress (DESIGN.md §8 — the workload is
 * hostile; the filter must resist bypass). The token is now a bijective
 * encoding of the raw id bytes ({@linkcode encodeIdToken}), so no two distinct
 * ids can ever share a table.
 */
export function egressTableName(sandboxId: string): string {
  if (typeof sandboxId !== "string" || sandboxId.length === 0) {
    throw new EgressRulesetError("sandbox id must be a non-empty string");
  }
  if (textEncoder.encode(sandboxId).length > MAX_ID_BYTES) {
    throw new EgressRulesetError("sandbox id is too long for a table name");
  }
  const name = `${TABLE_PREFIX}${encodeIdToken(sandboxId)}`;
  if (name.length > 255 || !TABLE_TOKEN.test(name)) {
    throw new EgressRulesetError(
      "sandbox id does not yield a valid table name",
    );
  }
  return name;
}

/**
 * Build the structured ruleset for a sandbox. Pure — safe to call in tests with
 * no host access.
 *
 * @throws {EgressRulesetError} if the handle / options are malformed (an unsafe
 *   TAP name, a bad guest IP, or a bad resolver), so a corrupt handle fails
 *   closed rather than injecting into the nft script.
 */
export function generateRuleset(
  resolved: ResolvedEgress,
  handle: SandboxNetworkHandle,
  options: EgressRulesetOptions = {},
): NftRuleset {
  const tableName = egressTableName(handle.sandboxId);
  const tap = requireTapName(handle.tapDevice);
  const guestIp = requireIp(handle.guestIp, "v4", "guestIp");
  const guestIp6 = handle.guestIp6 === undefined
    ? undefined
    : requireIp(handle.guestIp6, "v6", "guestIp6");
  const resolvers = (options.resolvers ?? []).map((address, i) =>
    requireAnyIp(address, `resolvers[${i}]`)
  );

  if (resolved.mode === "unrestricted") {
    return {
      family: "inet",
      tableName,
      chainName: CHAIN_NAME,
      sets: [],
      rules: [],
      unrestricted: true,
    };
  }

  const sets: NftSet[] = [];
  const rules: string[] = [];

  // 1. Not our TAP — let other sandbox tables judge it.
  rules.push(`iifname != "${tap}" accept`);
  // 2. Anti-spoof: the only source addresses this TAP may use. IPv6 is sealed
  //    explicitly either way — anti-spoof when the guest has a v6 address, or a
  //    hard `meta nfproto ipv6 drop` when it does not, so a guest that brings up
  //    v6 without a provisioned guestIp6 gets no v6 egress (fail closed) rather
  //    than relying on the trailing default-deny to catch it implicitly.
  rules.push(`ip saddr != ${guestIp} drop`);
  if (guestIp6 !== undefined) {
    rules.push(`ip6 saddr != ${guestIp6} drop`);
  } else {
    rules.push("meta nfproto ipv6 drop");
  }
  // 3. Return + related traffic for already-allowed flows.
  rules.push("ct state established,related accept");
  // 4. DNS to the configured resolver(s).
  for (const resolver of resolvers) {
    const l3 = resolver.family === "v4" ? "ip" : "ip6";
    rules.push(`${l3} daddr ${resolver.address} udp dport ${DNS_PORT} accept`);
    rules.push(`${l3} daddr ${resolver.address} tcp dport ${DNS_PORT} accept`);
  }

  // 5a. Exact IPs allowed on all ports.
  if (resolved.exact4.length > 0) {
    sets.push({ name: "allow4", type: "ipv4_addr", elements: resolved.exact4 });
    rules.push("ip daddr @allow4 accept");
  }
  if (resolved.exact6.length > 0) {
    sets.push({ name: "allow6", type: "ipv6_addr", elements: resolved.exact6 });
    rules.push("ip6 daddr @allow6 accept");
  }
  // 5b. Port-scoped exact IPs.
  if (resolved.exact4Port.length > 0) {
    sets.push({
      name: "allow4_port",
      type: "ipv4_addr . inet_service",
      elements: resolved.exact4Port.map(([ip, port]) => `${ip} . ${port}`),
    });
    rules.push("ip daddr . tcp dport @allow4_port accept");
    rules.push("ip daddr . udp dport @allow4_port accept");
  }
  if (resolved.exact6Port.length > 0) {
    sets.push({
      name: "allow6_port",
      type: "ipv6_addr . inet_service",
      elements: resolved.exact6Port.map(([ip, port]) => `${ip} . ${port}`),
    });
    rules.push("ip6 daddr . tcp dport @allow6_port accept");
    rules.push("ip6 daddr . udp dport @allow6_port accept");
  }
  // 5c. Wildcard subdomains — empty sets kept in sync by dnsmasq at run time.
  //     Unlike exact IPs (operator-specified, trusted), a wildcard set is filled
  //     by dnsmasq from *upstream DNS answers* the hostile guest can steer (e.g.
  //     resolving x.<allowed-wildcard> to 169.254.169.254 or an RFC-1918 host).
  //     So each wildcard accept is gated on the destination NOT being in the
  //     private / link-local / metadata / loopback ranges: even if a poisoned
  //     answer lands in the set, egress to it still falls through to `drop`.
  if (resolved.wildcards.length > 0) {
    sets.push({
      name: BLOCKED4_SET,
      type: "ipv4_addr",
      flags: ["interval"],
      elements: [...BLOCKED4_RANGES],
    });
    sets.push({
      name: BLOCKED6_SET,
      type: "ipv6_addr",
      flags: ["interval"],
      elements: [...BLOCKED6_RANGES],
    });
    for (const wildcard of resolved.wildcards) {
      appendWildcard(sets, rules, wildcard);
    }
  }

  // 6. Default-deny for everything else on this TAP.
  rules.push("drop");

  return {
    family: "inet",
    tableName,
    chainName: CHAIN_NAME,
    sets,
    rules,
    unrestricted: false,
  };
}

/**
 * A hard deny-all ruleset for one sandbox's TAP: no DNS, no established, no
 * allow sets — only `iifname != "<tap>" accept` then `drop`. Used as the
 * fail-closed seal when a normal apply fails, so a sandbox can never egress on
 * a half-configured policy even if the caller forgets to abort the launch.
 */
export function generateSealRuleset(
  handle: Pick<SandboxNetworkHandle, "sandboxId" | "tapDevice">,
): NftRuleset {
  const tableName = egressTableName(handle.sandboxId);
  const tap = requireTapName(handle.tapDevice);
  return {
    family: "inet",
    tableName,
    chainName: CHAIN_NAME,
    sets: [],
    rules: [`iifname != "${tap}" accept`, "drop"],
    unrestricted: false,
  };
}

function appendWildcard(
  sets: NftSet[],
  rules: string[],
  wildcard: ResolvedWildcard,
): void {
  const v4 = `wild4_${wildcard.index}`;
  const v6 = `wild6_${wildcard.index}`;
  sets.push({ name: v4, type: "ipv4_addr", elements: [] });
  sets.push({ name: v6, type: "ipv6_addr", elements: [] });
  // Membership in the wildcard set alone is NOT sufficient: the destination must
  // also be outside the blocked (private/link-local/metadata/loopback) ranges,
  // so a dnsmasq-poisoned answer cannot open egress to a martian address.
  const guard4 = `ip daddr @${v4} ip daddr != @${BLOCKED4_SET}`;
  const guard6 = `ip6 daddr @${v6} ip6 daddr != @${BLOCKED6_SET}`;
  if (wildcard.port === undefined) {
    rules.push(`${guard4} accept`);
    rules.push(`${guard6} accept`);
  } else {
    rules.push(`${guard4} tcp dport ${wildcard.port} accept`);
    rules.push(`${guard4} udp dport ${wildcard.port} accept`);
    rules.push(`${guard6} tcp dport ${wildcard.port} accept`);
    rules.push(`${guard6} udp dport ${wildcard.port} accept`);
  }
}

/**
 * Render the `table inet <name> { ... }` block (no add/delete preamble). This
 * is the canonical, deterministic form asserted by unit tests.
 */
export function renderNftScript(ruleset: NftRuleset): string {
  const lines: string[] = [];
  lines.push(`table ${ruleset.family} ${ruleset.tableName} {`);
  for (const set of ruleset.sets) {
    lines.push(`\tset ${set.name} {`);
    lines.push(`\t\ttype ${set.type}`);
    if (set.flags !== undefined && set.flags.length > 0) {
      lines.push(`\t\tflags ${set.flags.join(",")}`);
    }
    if (set.elements.length > 0) {
      lines.push(`\t\telements = { ${set.elements.join(", ")} }`);
    }
    lines.push(`\t}`);
  }
  lines.push(`\tchain ${ruleset.chainName} {`);
  lines.push(`\t\t${HOOK_DECL}`);
  for (const rule of ruleset.rules) {
    lines.push(`\t\t${rule}`);
  }
  lines.push(`\t}`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

/**
 * Render the full atomic apply script: ensure-then-replace the table in one
 * `nft -f` transaction. `add table` makes the following `delete table` safe
 * whether or not a prior table exists; the fresh `table { ... }` block then
 * installs the current ruleset. Because `nft -f` is transactional, there is no
 * window in which a stale or partial ruleset is live — apply is all-or-nothing,
 * which is the fail-closed guarantee (a failed apply installs nothing).
 */
export function renderApplyScript(ruleset: NftRuleset): string {
  const preamble = [
    `add table ${ruleset.family} ${ruleset.tableName}`,
    `delete table ${ruleset.family} ${ruleset.tableName}`,
  ].join("\n");
  return `${preamble}\n${renderNftScript(ruleset)}`;
}

/** Render the reclaim script: delete exactly this sandbox's table. */
export function renderReclaimScript(ruleset: NftRuleset): string {
  // `add`-then-`delete` so reclaim is idempotent (no error if already gone).
  return [
    `add table ${ruleset.family} ${ruleset.tableName}`,
    `delete table ${ruleset.family} ${ruleset.tableName}`,
    "",
  ].join("\n");
}

/**
 * Render the dnsmasq config fragment that keeps the wildcard sets in sync.
 *
 * For each `*.example.com` pattern, dnsmasq is told to add every A / AAAA answer
 * for `example.com` and its subdomains into this sandbox's `wild4_i` / `wild6_i`
 * nft sets. The guest can only reach *this* resolver, but it can still steer the
 * set's contents by resolving an allowlisted subdomain to an attacker-chosen
 * (possibly private / metadata) address, so the fragment enables dnsmasq's
 * `stop-dns-rebind` filter to reject upstream answers in the private ranges.
 * That is defense-in-depth on top of the ruleset's `@blocked4`/`@blocked6`
 * guard — the nft guard, not dnsmasq, is the authoritative seal. Returns `""`
 * when the spec has no wildcards.
 */
export function renderDnsmasqFragment(
  resolved: ResolvedEgress,
  tableName: string,
): string {
  if (resolved.mode !== "restricted" || resolved.wildcards.length === 0) {
    return "";
  }
  const lines = [
    // Reject upstream answers in the RFC-1918 private ranges (anti DNS-rebind).
    "stop-dns-rebind",
    ...resolved.wildcards.map((w) =>
      `nftset=/${w.baseDomain}/4#inet#${tableName}#wild4_${w.index},` +
      `6#inet#${tableName}#wild6_${w.index}`
    ),
  ];
  return lines.join("\n") + "\n";
}

interface CheckedIp {
  readonly family: "v4" | "v6";
  readonly address: string;
}

function requireTapName(tap: unknown): string {
  if (typeof tap !== "string" || !TAP_NAME.test(tap)) {
    throw new EgressRulesetError("tapDevice must be a valid interface name");
  }
  return tap;
}

function requireIp(
  value: unknown,
  family: "v4" | "v6",
  field: string,
): string {
  if (typeof value !== "string") {
    throw new EgressRulesetError(`${field} must be a string`);
  }
  const ip = parseIpLiteral(value);
  if (ip === null || ip.family !== family) {
    throw new EgressRulesetError(
      `${field} must be a valid IP${family} address`,
    );
  }
  return ip.address;
}

function requireAnyIp(value: unknown, field: string): CheckedIp {
  if (typeof value !== "string") {
    throw new EgressRulesetError(`${field} must be a string`);
  }
  const ip = parseIpLiteral(value);
  if (ip === null) {
    throw new EgressRulesetError(`${field} must be a valid IP address`);
  }
  return ip;
}
