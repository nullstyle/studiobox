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
sbx_eg_<sandboxId>`, containing:

- a single base chain `egress`
  (`type filter hook forward priority 0; policy accept;`), and
- the allow sets it references.

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
ip6 saddr != <guestIp6> drop         #    anti-spoof (IPv6, if the guest has one)
ct state established,related accept   # 3. return + related flows
ip  daddr <resolver> udp dport 53 accept   # 4. DNS to the sandbox resolver
ip  daddr <resolver> tcp dport 53 accept
ip  daddr @allow4 accept              # 5. allow rules (see grammar below)
ip6 daddr @allow6 accept
ip  daddr . tcp dport @allow4_port accept
ip  daddr . udp dport @allow4_port accept
...
ip  daddr @wild4_0 accept             #    wildcard sets (dnsmasq-synced)
drop                                  # 6. default-deny
```

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
  dnsmasq adds each answer IP to the set. Because the egress rules only permit
  DNS to that same resolver, the guest cannot populate the set behind dnsmasq's
  back. `renderDnsmasqFragment` produces this fragment; the launch integration
  writes it into the resolver's include directory and reloads it.

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
- **IPv6 leak.** If a guest has working IPv6 but `guestIp6` is unset, the v6
  anti-spoof rule is absent and only daddr-based allows constrain it — confirm
  guests get no v6 connectivity unless explicitly provisioned, or always emit
  the v6 default-deny path.
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
- **dnsmasq set population trust.** Wildcard sets are filled by dnsmasq from DNS
  answers; a poisoned upstream answer widens the set. Confirm the sandbox
  resolver validates/limits answers and that only that resolver is reachable.
- **Established-state abuse.** `ct state established,related accept` trusts
  conntrack; confirm the guest cannot forge a flow into the established state
  (e.g. via a shared conntrack zone) to skip the allow rules.
