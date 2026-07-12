import { assertEquals, assertThrows } from "@std/assert";
import {
  type EgressPattern,
  EgressSpecError,
  type EgressSpecErrorCode,
  parseAllowNet,
  parseEntry,
} from "../../../../src/rootd/network/spec.ts";

Deno.test("unset allowNet is unrestricted (upstream parity)", () => {
  assertEquals(parseAllowNet(undefined), { mode: "unrestricted" });
});

Deno.test("empty allowNet is restricted with no patterns (deny-all-but-DNS)", () => {
  assertEquals(parseAllowNet([]), { mode: "restricted", patterns: [] });
});

Deno.test("parses the full upstream grammar", () => {
  const cases: Array<[string, EgressPattern]> = [
    ["example.com", { kind: "exact", host: "example.com" }],
    ["example.com:80", { kind: "exact", host: "example.com", port: 80 }],
    ["EXAMPLE.COM", { kind: "exact", host: "example.com" }],
    ["sub.example.com.", { kind: "exact", host: "sub.example.com." }],
    ["*.example.com", { kind: "wildcard", host: "example.com" }],
    ["*.example.com:443", { kind: "wildcard", host: "example.com", port: 443 }],
    ["1.2.3.4", { kind: "ip", family: "v4", address: "1.2.3.4" }],
    ["1.2.3.4:80", { kind: "ip", family: "v4", address: "1.2.3.4", port: 80 }],
    ["2001:db8::1", { kind: "ip", family: "v6", address: "2001:db8::1" }],
    ["::1", { kind: "ip", family: "v6", address: "::1" }],
    [
      "[2001:db8::1]:443",
      { kind: "ip", family: "v6", address: "2001:db8::1", port: 443 },
    ],
    ["[::1]:53", { kind: "ip", family: "v6", address: "::1", port: 53 }],
    // Embedded IPv4 in an IPv6 literal.
    [
      "::ffff:1.2.3.4",
      { kind: "ip", family: "v6", address: "::ffff:1.2.3.4" },
    ],
  ];
  for (const [input, expected] of cases) {
    assertEquals(parseEntry(input), expected, `parsing ${input}`);
  }
});

Deno.test("parseAllowNet preserves order across a mixed spec", () => {
  const spec = parseAllowNet([
    "example.com:8443",
    "*.cdn.example.com",
    "10.0.0.9",
  ]);
  assertEquals(spec, {
    mode: "restricted",
    patterns: [
      { kind: "exact", host: "example.com", port: 8443 },
      { kind: "wildcard", host: "cdn.example.com" },
      { kind: "ip", family: "v4", address: "10.0.0.9" },
    ],
  });
});

function assertSpecError(
  fn: () => unknown,
  code: EgressSpecErrorCode,
): void {
  const error = assertThrows(fn, EgressSpecError);
  assertEquals((error as EgressSpecError).code, code);
}

Deno.test("malformed entries raise typed EgressSpecError with a stable code", () => {
  // Shape.
  assertSpecError(
    () => parseAllowNet(("nope" as unknown) as string[]),
    "SBX_EGRESS_SPEC_SHAPE",
  );
  // Entry-level.
  assertSpecError(() => parseEntry(""), "SBX_EGRESS_SPEC_ENTRY");
  assertSpecError(() => parseEntry(42), "SBX_EGRESS_SPEC_ENTRY");
  assertSpecError(() => parseEntry("[::1"), "SBX_EGRESS_SPEC_ENTRY");
  assertSpecError(() => parseEntry("[::1]x"), "SBX_EGRESS_SPEC_ENTRY");
  // Host-level.
  assertSpecError(() => parseEntry("*.*.com"), "SBX_EGRESS_SPEC_HOST");
  assertSpecError(() => parseEntry("*"), "SBX_EGRESS_SPEC_HOST");
  assertSpecError(() => parseEntry("bad_host!"), "SBX_EGRESS_SPEC_HOST");
  assertSpecError(() => parseEntry("-bad.com"), "SBX_EGRESS_SPEC_HOST");
  assertSpecError(() => parseEntry("[not-an-ip]"), "SBX_EGRESS_SPEC_HOST");
  assertSpecError(() => parseEntry("2001:db8:::1"), "SBX_EGRESS_SPEC_HOST");
  // Port-level.
  assertSpecError(() => parseEntry("example.com:0"), "SBX_EGRESS_SPEC_PORT");
  assertSpecError(
    () => parseEntry("example.com:99999"),
    "SBX_EGRESS_SPEC_PORT",
  );
  assertSpecError(() => parseEntry("example.com:"), "SBX_EGRESS_SPEC_PORT");
  assertSpecError(() => parseEntry("example.com:ab"), "SBX_EGRESS_SPEC_PORT");
});

Deno.test("a malformed dotted-decimal is treated as a hostname, never a widened IP", () => {
  // An out-of-range or leading-zero "IP" is not accepted as an IP literal; it
  // falls through to hostname classification and (harmlessly) becomes an exact
  // host that will simply NXDOMAIN and be sealed — never a silent IP widening.
  assertEquals(parseEntry("1.2.3.256"), {
    kind: "exact",
    host: "1.2.3.256",
  });
  assertEquals(parseEntry("010.0.0.1"), {
    kind: "exact",
    host: "010.0.0.1",
  });
});

Deno.test("the offending entry is echoed back bounded, never unbounded", () => {
  const long = "a".repeat(500) + ".com";
  const error = assertThrows(() => parseEntry(long), EgressSpecError);
  assertEquals((error as EgressSpecError).entry?.length, 64);
});
