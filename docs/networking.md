# Per-sandbox egress networking (`allowNet`)

This document describes studiobox-rootd's egress model — the rootd-side
implementation of `@deno/sandbox`'s `allowNet` option (DESIGN.md §5 Tier B, §8,
§9; PLAN.md §M10). The code lives in
[`src/rootd/network/`](../src/rootd/network/mod.ts) and is **additive**: it is
not yet wired into `launch_planner.ts` (see
[Integration point](#integration-point-left-for-later)).

## The model

Every sandbox is confined by nftables egress rules attached to its host-side TAP
device. Concretely, each sandbox owns **exactly one nftables table**,
`inet
sbx_eg_<token>`, containing:

- a single base chain `egress`
  (`type filter hook forward priority 0; policy accept;`), and
- the allow sets it references.

`<token>` is an **injective** encoding of the raw sandbox id (bytes already in
`[a-z0-9]` pass through; every other byte — uppercase, `-`, `_`, `.`, … — is
escaped as `_<hex>`). This matters for isolation: a non-injective mapping (an
earlier version folded `toLowerCase()` + collapsed every non-`[a-z0-9_]` byte to
`_`) let case- or separator-only id variants such as `sbx-audit`/`sbx-AUDIT` or
`sbx-a-b`/`sbx-a_b` collide onto **one** table, so a hostile launcher could aim
two sandboxes at the same table and have one overwrite (its `add;delete;table`)
or reclaim (its `delete table`) the other's egress. The encoding is a bijection,
so distinct ids can never share a table.

Isolating each sandbox in its own table — rather than sharing one table and
threading per-sandbox jump rules through it — means teardown is a single
`delete table inet sbx_eg_<id>`, which atomically removes the chain and every
set. There is no shared chain to edit and no shared state to sweep, which
satisfies the DESIGN.md §8 rule: _remove exact named resources, never
wildcard-sweep_.

### Why the base chain is `policy accept`, not `policy drop`

A base chain's policy applies to **every** packet traversing its hook. A
per-sandbox chain with `policy drop` at the `forward` hook would blackhole all
forwarded traffic on the host, not just this sandbox's. Instead the chain is
`policy accept` and its **first rule short-circuits foreign traffic**:

```
iifname != "<tap>" accept
```

Because a base-chain `accept` verdict is non-terminal _across tables_, each
sandbox's table judges only its own TAP's packets and defers everything else to
the other sandboxes' tables. For the sandbox's own TAP the chain is
**default-deny**: only the explicit allows pass, and a trailing `drop` seals the
rest.

### Rule order (restricted sandbox)

```
iifname != "<tap>" accept            # 1. not ours — let other tables decide
ip saddr  != <guestIp> drop          # 2. anti-spoof (IPv4)
ip6 saddr != <guestIp6> drop         #    anti-spoof (IPv6) when guestIp6 is set,
meta nfproto ipv6 drop               #    else a hard v6 seal (see below)
ct state established,related accept   # 3. return + related flows
ip  daddr <resolver> udp dport 53 accept   # 4. DNS to the sandbox resolver
ip  daddr <resolver> tcp dport 53 accept
ip  daddr @allow4 accept              # 5. allow rules (see grammar below)
ip6 daddr @allow6 accept
ip  daddr . tcp dport @allow4_port accept
ip  daddr . udp dport @allow4_port accept
...
ip  daddr @wild4_0 ip daddr != @blocked4 accept   # wildcard sets (dnsmasq-synced),
ip6 daddr @wild6_0 ip6 daddr != @blocked6 accept  # gated on non-private daddr
drop                                  # 6. default-deny
```

Exactly one of the two IPv6 lines in step 2 is emitted:
`ip6 saddr != <guestIp6>
drop` when the guest has a provisioned v6 address,
otherwise `meta nfproto ipv6
drop` — an explicit hard seal so a guest that
brings up IPv6 without a provisioned `guestIp6` gets **no** v6 egress, rather
than depending on the trailing default-deny to catch it implicitly.

The `@blocked4` / `@blocked6` sets in the wildcard rules hold the private,
link-local, cloud-metadata (`169.254.169.254`), and loopback ranges; see
[dnsmasq set population](#apply-time-hostname-resolution) below for why the
wildcard accepts are gated on them.

An **unrestricted** sandbox (unset `allowNet`) still gets a table for lifecycle
symmetry, but its `egress` chain has an empty body (policy accept), so the TAP's
egress is unfiltered — parity with upstream's unset `allowNet`. Keeping the
table present means every sandbox is reclaimed by exactly one `delete table`,
and it leaves a single, uniform place to later drop a global hardening rule
(e.g. block link-local / host metadata even when unrestricted).

## The `allowNet` grammar

`allowNet` mirrors upstream `@deno/sandbox` (fidelity target
`jsr:@deno/sandbox@0.13.2`). It is `string[] | undefined`:

| Form                | Example                              | Effect                                    |
| ------------------- | ------------------------------------ | ----------------------------------------- |
| unset (`undefined`) | —                                    | **unrestricted** (matches upstream)       |
| empty array (`[]`)  | `[]`                                 | deny-all egress except DNS + established  |
| exact host          | `example.com`, `example.com:80`      | resolved at apply time; IPs allowed       |
| wildcard subdomain  | `*.example.com`, `*.example.com:443` | dnsmasq-synced set (see below)            |
| IPv4 literal        | `1.2.3.4`, `1.2.3.4:80`              | allowed directly                          |
| IPv6 literal        | `2001:db8::1`, `[2001:db8::1]:443`   | bare, or bracketed when a port is present |

A port scopes the entry to that destination port (tcp **and** udp). No port
means all ports. Malformed entries raise a typed
[`EgressSpecError`](../src/rootd/network/spec.ts) at parse time — a fat-fingered
or hostile spec fails closed rather than silently widening the ruleset. A string
that looks like an out-of-range or leading-zero IP (`1.2.3.256`, `010.0.0.1`) is
**not** accepted as an IP literal; it falls through to hostname classification
and simply NXDOMAINs — never a silent IP widening.

## Apply-time hostname resolution

DESIGN.md §5 specifies that hostnames are "resolved at rule-apply time". Two
kinds of pattern resolve differently:

- **Exact hostnames** are resolved once (A / AAAA) and their IPs are baked into
  the sandbox's `allow4` / `allow6` sets. This is a point-in-time snapshot: a
  host whose DNS answer changes mid-life is not re-resolved until the ruleset is
  re-applied. See the [rebinding note](#adversarial-review-required).
- **Wildcard subdomains** cannot be enumerated up front, so they are kept in
  sync at run time. For each `*.example.com`, the ruleset declares empty
  `wild4_<i>` / `wild6_<i>` sets and rootd writes a dnsmasq fragment:

  ```
  nftset=/example.com/4#inet#sbx_eg_<id>#wild4_<i>,6#inet#sbx_eg_<id>#wild6_<i>
  ```

  As the guest resolves `foo.example.com` **through the sandbox resolver**,
  dnsmasq adds each answer IP to the set. The guest can only reach _this_
  resolver — but that does **not** mean the set contents are trustworthy: a
  hostile guest steering an allowlisted wildcard (e.g. `*.ngrok.io`,
  `*.trycloudflare.com`) can resolve `x.<domain>` to `169.254.169.254`, an
  RFC-1918 host, or the Lima host itself, and dnsmasq will load that answer into
  the accept set. The guest therefore **can** influence the set's contents; the
  _filter_, not the resolver, is what protects. Two defenses apply:

  1. **Ruleset (authoritative).** Every wildcard accept is gated on
     `ip daddr != @blocked4` / `ip6 daddr != @blocked6`, so even a poisoned
     private / link-local / metadata / loopback answer that lands in the set
     never grants egress — it falls through to the trailing `drop`.
  2. **Resolver (defense in depth).** The dnsmasq fragment enables
     `stop-dns-rebind`, which rejects upstream answers in the private ranges
     before they reach the set.

  `renderDnsmasqFragment` produces this fragment; the launch integration writes
  it into the resolver's include directory and reloads it.

## Fail-closed guarantees

- **Atomic apply.** The apply script is one `nft -f` transaction with an
  ensure-then-replace preamble (`add table` / `delete table` / fresh
  `table { … }`). `nft -f` is all-or-nothing, so a failed apply installs
  **nothing partial** — there is never a half-built allow-list that leaks.
- **Deny-all seal on failure.** If resolution/generation/apply fails,
  `EgressController.apply` best-effort installs
  [`generateSealRuleset`](../src/rootd/network/ruleset.ts) — a hard
  `iifname !=
  "<tap>" accept; drop` with no DNS, no established, no allow sets
  — then raises `EgressApplyError`. A sandbox therefore only ever runs with the
  intended ruleset or a hard seal. The caller **must** treat `EgressApplyError`
  as fatal to the launch (abort boot, then `reclaim`).
- **Anti-spoof.** The guest may only source packets from its own `guestIp`;
  spoofed source addresses are dropped (`ip saddr != <guestIp> drop`).
- **Exact-name reclaim.** `reclaim()` deletes only `inet sbx_eg_<id>` by name,
  idempotently. It never flushes or wildcard-matches shared nft state. A reclaim
  failure raises `EgressReclaimError` so the supervisor can quarantine the
  record rather than silently drop a leaked chain.

## Real-hardware validation

Validated against real nftables in the `fc-smoke` Lima VM (aarch64) in an
isolated network namespace (`sbx-egress-probe-<uniq>` + a veth pair + a private
masquerade table), driving the exact `nft` script this module generates:

- **allowed + DNS:** `curl https://one.one.one.one` (resolved via the allowed
  `8.8.8.8:53` resolver, connecting to the allowed `1.1.1.1`) → `HTTP 200`.
- **denied + port-scope:** `curl https://8.8.8.8` (same IP, port 443) → timed
  out / dropped (`exit 28`), proving default-deny and that the `:53` allowance
  does not widen to `:443`.
- **reclaim:** the generated reclaim script removed the table, and every
  probe-created resource was torn down by exact name — no leaked table, netns,
  veth, or resolver file, and Lima's base `table ip nat` left intact.
- **wildcard poisoning (FIX A):** a three-netns forward path with the generated
  wildcard ruleset in the router netns; injecting a private `10.91.0.50` element
  into `wild4_0` the way a poisoned DNS answer would. With the `@blocked4` guard
  the guest→`10.91.0.50` probe is **BLOCKED**; with the pre-fix bare
  `ip daddr @wild4_0 accept` the same element is **REACHABLE** — the bypass, now
  closed.
- **table-name collision (FIX B):** applying the restrictive ruleset for
  `sbx-audit` then `sbx-AUDIT` in one netns. With injective naming the two land
  in distinct tables (`sbx_eg_sbx_2daudit` vs `sbx_eg_sbx_2d_41_55_44_49_54`);
  the victim's table is byte-identical after the colliding-id apply and survives
  the sibling's reclaim intact. Under the pre-fix folding both ids collided onto
  `sbx_eg_sbx_audit`, so the second apply overwrote the victim's allow-list and
  the sibling's reclaim deleted the shared table, leaving the victim unfiltered.

## Integration point (left for later)

This module is intentionally **not** wired into `launch_planner.ts` yet; that
lands when the M6 control plane and M10 Tier-B emulation converge on the main
line. When it does:

1. During launch, after the TAP / netns are created, call
   `EgressController.applyAllowNet(options.allowNet, handle)` and journal
   `tapName` / `netnsPath` onto `SandboxRecord.resources`. Treat an
   `EgressApplyError` as fatal: abort the boot and reclaim the TAP.
2. If the spec has wildcards, write `renderDnsmasqFragment(...)` into the
   sandbox resolver's include directory and reload it.
3. Register `new EgressReclaimHook(controller, { netnsFor }).` in the
   `SupervisorCore` `reclaimHooks` array (alongside the artifact reclaim hook),
   so egress teardown runs on every terminate and during composed
   reconciliation.

The netns naming convention is owned by that (not-yet-built) integration, so
`EgressReclaimHook` takes an injected `netnsFor(record)` mapping rather than
guessing.

## Adversarial review required

An egress-bypass review is warranted **before merge**. Vectors to check:

- **DNS rebinding.** Exact hostnames are a point-in-time snapshot. A low-TTL
  record that flips to a new IP after apply becomes unreachable (fail-safe), but
  the guest remains able to reach the snapshot IPs regardless of what the name
  later resolves to. Confirm the snapshot semantics are the intended contract,
  and consider periodic re-resolution or a TTL-bounded refresh so a name pointed
  at a benign IP at apply time cannot keep a stale allowance.
- **IPv6 leak.** _(Addressed.)_ When `guestIp6` is unset the ruleset now emits
  an explicit `meta nfproto ipv6 drop` right after the anti-spoof block,
  hard-sealing all v6 for the TAP; when it is set, v6 anti-spoof applies. A
  guest gets no v6 egress unless explicitly provisioned.
- **Raw-IP bypass of hostname rules.** Hostname rules only allow the resolved
  IPs; a guest connecting by raw IP to a non-allowed address is dropped
  (verified). Confirm there is no host whose allowed hostname shares an IP with
  an intended-denied service.
- **Port reuse / scoping.** Verified that `:53` allowance does not widen to
  `:443` on the same IP. Re-check the concatenated `(addr . port)` sets under
  overlapping all-port + port-scoped entries for the same host.
- **Host / metadata reachability.** Under **unrestricted** mode the guest can
  reach the Lima host, other sandboxes' subnets, and any link-local / metadata
  address. Decide whether a global hardening rule should block link-local
  (`169.254.0.0/16`, `fe80::/10`) and the host address even when `allowNet` is
  unset.
- **dnsmasq set population trust.** _(Addressed.)_ Wildcard sets are filled by
  dnsmasq from DNS answers the guest can steer, so a poisoned answer (e.g. a
  wildcard subdomain pointed at `169.254.169.254` or an RFC-1918 host) widens
  the set. Every wildcard accept is now gated on `ip daddr != @blocked4` /
  `ip6 daddr != @blocked6` (private / link-local / metadata / loopback ranges),
  so a poisoned element never grants egress, and the dnsmasq fragment enables
  `stop-dns-rebind` as a second layer. Live-validated against real nftables (see
  below).
- **Established-state abuse.** `ct state established,related accept` trusts
  conntrack; confirm the guest cannot forge a flow into the established state
  (e.g. via a shared conntrack zone) to skip the allow rules.
