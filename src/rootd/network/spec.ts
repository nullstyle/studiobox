/**
 * Parse and validate an `allowNet` specification into a typed egress spec.
 *
 * The grammar mirrors upstream `@deno/sandbox`'s `allowNet` option (the
 * DESIGN.md §5 fidelity target): each entry is a host or IP literal with an
 * optional port:
 *
 * - exact hostname — `example.com`, `example.com:80`
 * - wildcard subdomain — `*.example.com`, `*.example.com:443`
 * - IPv4 literal — `1.2.3.4`, `1.2.3.4:80`
 * - IPv6 literal — `2001:db8::1` (bare, no port) or `[2001:db8::1]:443`
 *   (bracketed when a port is present, per the upstream/RFC 3986 convention)
 *
 * **Unset `allowNet` means unrestricted** (matching upstream): a `undefined`
 * input yields `{ mode: "unrestricted" }`. An empty array yields a `restricted`
 * spec with no patterns — i.e. deny-all egress except DNS + established flows.
 *
 * Every validator is bounded and rejects malformed input with a typed
 * {@linkcode EgressSpecError} so a hostile or fat-fingered spec fails closed at
 * parse time rather than silently widening the ruleset. Nothing here performs
 * DNS or touches the host — parsing is pure and side-effect free.
 *
 * @module
 */

/** The widest single entry we will consider; bounds the parser's work. */
const MAX_ENTRY_BYTES = 300;
/** RFC 1035 caps a hostname at 253 octets; we bound to that. */
const MAX_HOSTNAME_LENGTH = 253;
/** The most entries a single spec may carry (defence against pathological input). */
const MAX_ENTRIES = 1024;

/** Stable reason codes for a rejected `allowNet` entry. */
export type EgressSpecErrorCode =
  /** The overall input was not an array of strings. */
  | "SBX_EGRESS_SPEC_SHAPE"
  /** An entry was empty, over-length, or otherwise unparseable. */
  | "SBX_EGRESS_SPEC_ENTRY"
  /** The host portion is not a valid hostname / wildcard / IP literal. */
  | "SBX_EGRESS_SPEC_HOST"
  /** The port portion is not an integer in 1..65535. */
  | "SBX_EGRESS_SPEC_PORT";

/**
 * A malformed `allowNet` spec. Carries a bounded, non-sensitive excerpt of the
 * offending entry so operators can find the typo without leaking host state.
 */
export class EgressSpecError extends Error {
  readonly code: EgressSpecErrorCode;
  /** The offending entry, truncated to a bounded length. */
  readonly entry: string | undefined;

  constructor(
    code: EgressSpecErrorCode,
    message: string,
    entry?: string,
  ) {
    super(message);
    this.name = "EgressSpecError";
    this.code = code;
    this.entry = entry === undefined ? undefined : entry.slice(0, 64);
  }
}

/** A resolved-later hostname or wildcard subdomain pattern. */
export interface HostPattern {
  readonly kind: "exact" | "wildcard";
  /** Lowercased hostname; for a wildcard this is the base (`example.com`). */
  readonly host: string;
  /** Optional destination port (1..65535); absent means all ports. */
  readonly port?: number;
}

/** A literal IP address pattern (no DNS needed). */
export interface IpPattern {
  readonly kind: "ip";
  readonly family: "v4" | "v6";
  /** The lowercased, validated address string, as passed to nft. */
  readonly address: string;
  /** Optional destination port (1..65535); absent means all ports. */
  readonly port?: number;
}

export type EgressPattern = HostPattern | IpPattern;

/**
 * The parsed egress intent. `unrestricted` (unset `allowNet`) means no
 * per-sandbox filtering at all — parity with upstream. `restricted` carries the
 * validated allow-list (possibly empty, meaning deny-all-but-DNS).
 */
export type EgressSpec =
  | { readonly mode: "unrestricted" }
  | {
    readonly mode: "restricted";
    readonly patterns: readonly EgressPattern[];
  };

/**
 * Parse an `allowNet` value into a typed {@linkcode EgressSpec}.
 *
 * @param input `undefined` (unset ⇒ unrestricted) or an array of entry strings.
 * @throws {EgressSpecError} on any malformed entry — fail closed, never widen.
 */
export function parseAllowNet(
  input: readonly string[] | undefined,
): EgressSpec {
  if (input === undefined) return { mode: "unrestricted" };
  if (!Array.isArray(input)) {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_SHAPE",
      "allowNet must be undefined or an array of strings",
    );
  }
  if (input.length > MAX_ENTRIES) {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_SHAPE",
      `allowNet must have at most ${MAX_ENTRIES} entries`,
    );
  }
  const patterns: EgressPattern[] = [];
  for (const entry of input) {
    patterns.push(parseEntry(entry));
  }
  return { mode: "restricted", patterns };
}

/** Parse one `allowNet` entry. Exported for focused unit testing. */
export function parseEntry(entry: unknown): EgressPattern {
  if (typeof entry !== "string") {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_ENTRY",
      "allowNet entry must be a string",
    );
  }
  if (entry.length === 0 || entry.length > MAX_ENTRY_BYTES) {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_ENTRY",
      "allowNet entry must be 1..300 characters",
      entry,
    );
  }
  const { hostRaw, portRaw, forceIpv6 } = splitHostPort(entry);
  const port = portRaw === undefined ? undefined : parsePort(portRaw, entry);

  const ip = parseIpLiteral(hostRaw);
  if (ip !== null) {
    return port === undefined
      ? { kind: "ip", family: ip.family, address: ip.address }
      : { kind: "ip", family: ip.family, address: ip.address, port };
  }
  if (forceIpv6) {
    // Came in via `[...]` brackets or as a multi-colon bare literal, so it
    // must have been an IPv6 address; a non-IP host here is malformed.
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_HOST",
      "bracketed / multi-colon entry is not a valid IPv6 address",
      entry,
    );
  }

  const host = classifyHost(hostRaw, entry);
  return port === undefined ? host : { ...host, port };
}

interface SplitParts {
  readonly hostRaw: string;
  readonly portRaw: string | undefined;
  /** The host portion must be an IPv6 literal (brackets or multi-colon). */
  readonly forceIpv6: boolean;
}

function splitHostPort(entry: string): SplitParts {
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close < 0) {
      throw new EgressSpecError(
        "SBX_EGRESS_SPEC_ENTRY",
        "unterminated '[' in IPv6 entry",
        entry,
      );
    }
    const hostRaw = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest === "") return { hostRaw, portRaw: undefined, forceIpv6: true };
    if (!rest.startsWith(":")) {
      throw new EgressSpecError(
        "SBX_EGRESS_SPEC_ENTRY",
        "expected ':port' after ']' in IPv6 entry",
        entry,
      );
    }
    return { hostRaw, portRaw: rest.slice(1), forceIpv6: true };
  }

  const colons = countChar(entry, ":");
  if (colons === 0) {
    return { hostRaw: entry, portRaw: undefined, forceIpv6: false };
  }
  if (colons === 1) {
    const idx = entry.indexOf(":");
    return {
      hostRaw: entry.slice(0, idx),
      portRaw: entry.slice(idx + 1),
      forceIpv6: false,
    };
  }
  // Two or more colons and no brackets ⇒ a bare IPv6 literal, never a port
  // (a port with IPv6 requires brackets, per RFC 3986 / upstream).
  return { hostRaw: entry, portRaw: undefined, forceIpv6: true };
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) n++;
  }
  return n;
}

function parsePort(portRaw: string, entry: string): number {
  if (!/^[0-9]{1,5}$/.test(portRaw)) {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_PORT",
      "port must be 1..5 decimal digits",
      entry,
    );
  }
  const port = Number(portRaw);
  if (port < 1 || port > 65_535) {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_PORT",
      "port must be in 1..65535",
      entry,
    );
  }
  return port;
}

interface ParsedIp {
  readonly family: "v4" | "v6";
  readonly address: string;
}

/** Return the parsed IP literal, or `null` if `host` is not an IP address. */
export function parseIpLiteral(host: string): ParsedIp | null {
  if (isIpv4(host)) return { family: "v4", address: host };
  const lower = host.toLowerCase();
  if (isIpv6(lower)) return { family: "v6", address: lower };
  return null;
}

function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    // No leading zeros (octal ambiguity); 0..255.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** Validate an IPv6 literal, including `::` compression and embedded IPv4. */
function isIpv6(host: string): boolean {
  if (host.length === 0 || host.length > 45) return false;
  if (/[^0-9a-f:.]/.test(host)) return false;

  const doubleColon = host.indexOf("::");
  if (doubleColon !== host.lastIndexOf("::")) return false; // at most one "::"

  let head: string;
  let tail: string;
  let compressed: boolean;
  if (doubleColon >= 0) {
    compressed = true;
    head = host.slice(0, doubleColon);
    tail = host.slice(doubleColon + 2);
  } else {
    compressed = false;
    head = host;
    tail = "";
  }

  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  let total = headGroups.length + tailGroups.length;

  const all = [...headGroups, ...tailGroups];
  for (let i = 0; i < all.length; i++) {
    const group = all[i];
    if (group === "") return false; // empty group outside of "::"
    if (group.includes(".")) {
      // Embedded IPv4 is only legal as the final group.
      if (i !== all.length - 1) return false;
      if (!isIpv4(group)) return false;
      total += 1; // an embedded IPv4 occupies two 16-bit groups
    } else if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return false;
    }
  }

  if (compressed) {
    // "::" must stand in for at least one omitted group.
    return total <= 7;
  }
  return total === 8;
}

function classifyHost(host: string, entry: string): HostPattern {
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    if (!isHostname(base)) {
      throw new EgressSpecError(
        "SBX_EGRESS_SPEC_HOST",
        "wildcard base is not a valid hostname",
        entry,
      );
    }
    return { kind: "wildcard", host: base.toLowerCase() };
  }
  if (!isHostname(host)) {
    throw new EgressSpecError(
      "SBX_EGRESS_SPEC_HOST",
      "host is not a valid hostname, wildcard, or IP literal",
      entry,
    );
  }
  return { kind: "exact", host: host.toLowerCase() };
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function isHostname(host: string): boolean {
  // Tolerate a single trailing dot (fully-qualified form) then strip it.
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;
  const labels = name.split(".");
  for (const label of labels) {
    if (!LABEL.test(label)) return false;
  }
  return true;
}
