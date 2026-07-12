import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { ResolvedEgress } from "../../../../src/rootd/network/resolver.ts";
import {
  EgressRulesetError,
  egressTableName,
  generateRuleset,
  generateSealRuleset,
  renderApplyScript,
  renderDnsmasqFragment,
  renderNftScript,
  renderReclaimScript,
  type SandboxNetworkHandle,
} from "../../../../src/rootd/network/ruleset.ts";

const HANDLE: SandboxNetworkHandle = {
  sandboxId: "sbx_a",
  tapDevice: "tap-a",
  guestIp: "10.0.0.2",
};

const RESOLVERS = ["10.0.0.1"];

function restricted(
  partial: Partial<Omit<ResolvedEgress & { mode: "restricted" }, "mode">> = {},
): ResolvedEgress {
  return {
    mode: "restricted",
    exact4: partial.exact4 ?? [],
    exact6: partial.exact6 ?? [],
    exact4Port: partial.exact4Port ?? [],
    exact6Port: partial.exact6Port ?? [],
    wildcards: partial.wildcards ?? [],
  };
}

Deno.test("egressTableName sanitizes to nft's identifier charset, deterministically", () => {
  assertEquals(egressTableName("sbx_loc_ab12"), "sbx_eg_sbx_loc_ab12");
  // Hyphens / uppercase in an id are folded to a safe token.
  assertEquals(egressTableName("sbx-LOC-x"), "sbx_eg_sbx_loc_x");
  // Same input ⇒ same name (apply and reclaim must agree).
  assertEquals(egressTableName("sbx_a"), egressTableName("sbx_a"));
  assertThrows(() => egressTableName(""), EgressRulesetError);
});

Deno.test("unrestricted (unset allowNet) yields a permissive, empty-body table", () => {
  const ruleset = generateRuleset({ mode: "unrestricted" }, HANDLE, {
    resolvers: RESOLVERS,
  });
  assertEquals(ruleset.unrestricted, true);
  assertEquals(ruleset.sets, []);
  assertEquals(ruleset.rules, []);
  assertEquals(
    renderNftScript(ruleset),
    "table inet sbx_eg_sbx_a {\n" +
      "\tchain egress {\n" +
      "\t\ttype filter hook forward priority 0; policy accept;\n" +
      "\t}\n" +
      "}\n",
  );
});

Deno.test("an exact-host allow-list renders the full restricted ruleset", () => {
  const ruleset = generateRuleset(
    restricted({ exact4: ["1.2.3.4", "5.6.7.8"] }),
    HANDLE,
    { resolvers: RESOLVERS },
  );
  assertEquals(
    renderNftScript(ruleset),
    "table inet sbx_eg_sbx_a {\n" +
      "\tset allow4 {\n" +
      "\t\ttype ipv4_addr\n" +
      "\t\telements = { 1.2.3.4, 5.6.7.8 }\n" +
      "\t}\n" +
      "\tchain egress {\n" +
      "\t\ttype filter hook forward priority 0; policy accept;\n" +
      '\t\tiifname != "tap-a" accept\n' +
      "\t\tip saddr != 10.0.0.2 drop\n" +
      "\t\tct state established,related accept\n" +
      "\t\tip daddr 10.0.0.1 udp dport 53 accept\n" +
      "\t\tip daddr 10.0.0.1 tcp dport 53 accept\n" +
      "\t\tip daddr @allow4 accept\n" +
      "\t\tdrop\n" +
      "\t}\n" +
      "}\n",
  );
});

Deno.test("default-deny is present in EVERY restricted ruleset", () => {
  const variants: ResolvedEgress[] = [
    restricted(),
    restricted({ exact4: ["1.2.3.4"] }),
    restricted({ exact6: ["2001:db8::1"] }),
    restricted({ exact4Port: [["1.2.3.4", 443]] }),
    restricted({ wildcards: [{ index: 0, baseDomain: "example.com" }] }),
  ];
  for (const resolved of variants) {
    const ruleset = generateRuleset(resolved, HANDLE, { resolvers: RESOLVERS });
    assertEquals(ruleset.rules.at(-1), "drop", "trailing default-deny");
    assert(
      ruleset.rules.includes('iifname != "tap-a" accept'),
      "TAP isolation guard",
    );
    assert(
      ruleset.rules.includes("ct state established,related accept"),
      "established/related",
    );
  }
});

Deno.test("port-scoped IPs use concatenated (addr . port) sets for both protocols", () => {
  const ruleset = generateRuleset(
    restricted({ exact4Port: [["1.2.3.4", 443], ["1.2.3.4", 8443]] }),
    HANDLE,
    { resolvers: RESOLVERS },
  );
  const script = renderNftScript(ruleset);
  assertStringIncludes(
    script,
    "\tset allow4_port {\n\t\ttype ipv4_addr . inet_service\n",
  );
  assertStringIncludes(script, "elements = { 1.2.3.4 . 443, 1.2.3.4 . 8443 }");
  assertStringIncludes(script, "ip daddr . tcp dport @allow4_port accept");
  assertStringIncludes(script, "ip daddr . udp dport @allow4_port accept");
});

Deno.test("IPv6 allow-list + guest v6 anti-spoof render on the ip6 path", () => {
  const ruleset = generateRuleset(
    restricted({ exact6: ["2001:db8::1"] }),
    { ...HANDLE, guestIp6: "fd00::2" },
    { resolvers: RESOLVERS },
  );
  const script = renderNftScript(ruleset);
  assertStringIncludes(script, "ip6 saddr != fd00::2 drop");
  assertStringIncludes(script, "\tset allow6 {\n\t\ttype ipv6_addr\n");
  assertStringIncludes(script, "ip6 daddr @allow6 accept");
});

Deno.test("wildcards create empty per-domain sets + a dnsmasq sync fragment", () => {
  const resolved = restricted({
    wildcards: [
      { index: 0, baseDomain: "example.com" },
      { index: 1, baseDomain: "cdn.example.net", port: 443 },
    ],
  });
  const ruleset = generateRuleset(resolved, HANDLE, { resolvers: RESOLVERS });
  const script = renderNftScript(ruleset);
  // Empty sets: dnsmasq fills them at run time.
  assertStringIncludes(script, "\tset wild4_0 {\n\t\ttype ipv4_addr\n\t}");
  assertStringIncludes(script, "\tset wild6_1 {\n\t\ttype ipv6_addr\n\t}");
  // Un-ported wildcard: bare accept. Ported wildcard: port-checked.
  assertStringIncludes(script, "ip daddr @wild4_0 accept");
  assertStringIncludes(script, "ip daddr @wild4_1 tcp dport 443 accept");
  assertStringIncludes(script, "ip6 daddr @wild6_1 udp dport 443 accept");

  assertEquals(
    renderDnsmasqFragment(resolved, ruleset.tableName),
    "nftset=/example.com/4#inet#sbx_eg_sbx_a#wild4_0,6#inet#sbx_eg_sbx_a#wild6_0\n" +
      "nftset=/cdn.example.net/4#inet#sbx_eg_sbx_a#wild4_1,6#inet#sbx_eg_sbx_a#wild6_1\n",
  );
});

Deno.test("no wildcards ⇒ empty dnsmasq fragment", () => {
  assertEquals(renderDnsmasqFragment(restricted(), "sbx_eg_sbx_a"), "");
  assertEquals(
    renderDnsmasqFragment({ mode: "unrestricted" }, "sbx_eg_sbx_a"),
    "",
  );
});

Deno.test("the seal ruleset is a hard deny-all for the TAP", () => {
  const seal = generateSealRuleset(HANDLE);
  assertEquals(seal.rules, ['iifname != "tap-a" accept', "drop"]);
  assertEquals(seal.sets, []);
  assertEquals(seal.tableName, "sbx_eg_sbx_a");
});

Deno.test("a malformed handle fails closed (no nft-script injection)", () => {
  assertThrows(
    () => generateRuleset(restricted(), { ...HANDLE, tapDevice: "a b; drop" }),
    EgressRulesetError,
  );
  assertThrows(
    () => generateRuleset(restricted(), { ...HANDLE, guestIp: "not-an-ip" }),
    EgressRulesetError,
  );
  assertThrows(
    () => generateRuleset(restricted(), { ...HANDLE, guestIp: "2001:db8::1" }),
    EgressRulesetError,
  );
  assertThrows(
    () => generateRuleset(restricted(), HANDLE, { resolvers: ["nope"] }),
    EgressRulesetError,
  );
});

Deno.test("apply script is an atomic ensure-then-replace transaction", () => {
  const ruleset = generateRuleset(restricted({ exact4: ["1.2.3.4"] }), HANDLE, {
    resolvers: RESOLVERS,
  });
  const apply = renderApplyScript(ruleset);
  assert(
    apply.startsWith(
      "add table inet sbx_eg_sbx_a\ndelete table inet sbx_eg_sbx_a\ntable inet sbx_eg_sbx_a {",
    ),
    "atomic add/delete preamble then the fresh table",
  );
});

Deno.test("reclaim script deletes exactly the one table, idempotently", () => {
  assertEquals(
    renderReclaimScript(generateSealRuleset(HANDLE)),
    "add table inet sbx_eg_sbx_a\ndelete table inet sbx_eg_sbx_a\n",
  );
});
