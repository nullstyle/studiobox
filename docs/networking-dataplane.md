# M10 — Full Tier-B networking dataplane (implementation contract)

Status: **design**, DESIGN-ONLY. This document is the buildable contract for the
M10 "Full Tier-B networking" work. It supersedes the _integration point_ section
of [`docs/networking.md`](./networking.md) (that doc describes the egress
**engine** in isolation; this doc describes the **dataplane** that instantiates
the engine at launch). Every current-state claim is cited to `file:line`.

The egress **filter** engine (`src/rootd/network/`) is already built and
fc-smoke-validated but is never called from launch: the planner emits a
`VmConfig` with no `network_interfaces`
([`launch_planner.ts:235-259`](../src/rootd/launch_planner.ts)), creates no TAP,
journals no `tapName`, calls no `applyAllowNet`, and registers no
`EgressReclaimHook` (`BACKLOG.md:193-209`). M10 builds the **dataplane** around
that engine: subnet/TAP allocation, host provisioning, guest boot config,
dnsmasq lifecycle, exposeHttp port-forwarding, reclaim, and the wire plumbing
that carries `allowNet`/`netless`/`vcpus`/`kernelArgs`.

Fixed model (do **not** relitigate): point-to-point TAP per sandbox in the host
network namespace, host is gateway + NAT masquerade, static guest IP via kernel
`ip=` cmdline, per-sandbox nftables egress table on the TAP forward hook. Unset
`allowNet` = unrestricted (full internet), matching upstream
([`spec.ts:14-17`](../src/rootd/network/spec.ts)).

---

## 0. Evidence map (confirmed current-state)

| Claim                                                                                                                                                                | Evidence                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SandboxNetworkHandle` = `{sandboxId, tapDevice, netns?, guestIp, guestIp6?}`                                                                                        | [`ruleset.ts:50-64`](../src/rootd/network/ruleset.ts)                                                                |
| TAP name regex `^[A-Za-z0-9_.-]{1,15}$`                                                                                                                              | [`ruleset.ts:105`](../src/rootd/network/ruleset.ts)                                                                  |
| egress table name = `sbx_eg_` + injective hex-escape of raw id, `MAX_ID_BYTES=80`                                                                                    | [`ruleset.ts:107,114,154-205`](../src/rootd/network/ruleset.ts)                                                      |
| `EgressController.apply(spec, handle, {resolvers})` → `{tableName, ruleset, dnsmasqFragment}`; `applyAllowNet(allowNet, handle)`; `reclaim({sandboxId, netns?})`     | [`apply.ts:164-239`](../src/rootd/network/apply.ts)                                                                  |
| `CommandRunner.run(bin, args, stdin)` injected-exec seam; `DenoCommandRunner` default                                                                                | [`apply.ts:51-83`](../src/rootd/network/apply.ts)                                                                    |
| `renderDnsmasqFragment(resolved, tableName)` → `stop-dns-rebind` + `nftset=/base/4#inet#<table>#wild4_i,6#inet#<table>#wild6_i`; `""` when no wildcards              | [`ruleset.ts:445-461`](../src/rootd/network/ruleset.ts)                                                              |
| `@blocked4/@blocked6` = RFC1918/CGNAT/link-local(incl `169.254.169.254`)/loopback/ULA                                                                                | [`ruleset.ts:123-137`](../src/rootd/network/ruleset.ts)                                                              |
| `EgressReclaimHook.reclaim` no-ops unless `record.resources.tapName` set; `netnsFor(record)` injected                                                                | [`reclaim_hook.ts:33-70`](../src/rootd/network/reclaim_hook.ts)                                                      |
| `VmConfig.network_interfaces?: NetworkInterface[]`                                                                                                                   | `@nullstyle/firecracker@0.2.0/src/machine/config.ts:43`                                                              |
| `NetworkInterface = {guest_mac?, host_dev_name(req), iface_id(req), mtu?, rx_rate_limiter?, tx_rate_limiter?}`; `RateLimiter = {bandwidth?, ops?}`                   | `firecracker@0.2.0` generated types (`NetworkInterface`, `RateLimiter`)                                              |
| adapter `launch({..., config})` applies `putNetworkInterface` for each NIC (TAP must pre-exist)                                                                      | [`adapter.ts:69-92`](../src/rootd/firecracker/adapter.ts); `config.ts:88-89`                                         |
| `SandboxResources = {uid?, gid?, overlayPath?, tapName?, netnsPath?, exposedPorts: number[]}`; validator allows exactly those keys, `exposedPorts` unique `1..65535` | [`model.ts:77-84,235-268`](../src/state/model.ts)                                                                    |
| `SupervisorLaunchPlan` = `{jailer, stage, config, readinessTimeoutMs?, agentVsockPort?, artifact?, agentCredential?}`                                                | [`supervisor_core.ts:66-98`](../src/rootd/supervisor_core.ts)                                                        |
| staging→booting `#ownedTransition` carries `{artifact}` patch; patch merged `{...current, ...patch, phase}`                                                          | [`supervisor_core.ts:252-260,869-878`](../src/rootd/supervisor_core.ts)                                              |
| `ReclaimHook = {name, reclaim(record)}`; run in array order, first throw ⇒ quarantine                                                                                | [`supervisor_core.ts:111-114,704-716`](../src/rootd/supervisor_core.ts)                                              |
| reconcile = package `reconcileAfterSupervisorRestart()` then hooks; destructive restart                                                                              | [`supervisor_core.ts:543-624`](../src/rootd/supervisor_core.ts)                                                      |
| planner builds `bootArgs` (223-233) + `config` (235-259, no NICs); `#coordinates` map; `reclaimHook` getter (344-349)                                                | [`launch_planner.ts`](../src/rootd/launch_planner.ts)                                                                |
| `createInputFromWire` drops `allowNet/vcpus/netless/kernelArgs`                                                                                                      | [`service.ts:331-359`](../src/hostd/service.ts)                                                                      |
| `CreateSandboxInput` = `{timeout, memoryMiB, region, labels, idempotencyKey}`                                                                                        | [`control_core.ts:82-93`](../src/hostd/control_core.ts)                                                              |
| `CreateOptions` capnp declares `vcpus @2, allowNet @3, netless @6, kernelArgs @7`                                                                                    | [`host_control.capnp:25-34`](../schema/host_control.capnp)                                                           |
| `control_core.create` launch hardcodes `artifactId:"artifact-loc"`, `allocationId:"alloc-<suffix>"`, no allowNet                                                     | [`control_core.ts:418-425`](../src/hostd/control_core.ts)                                                            |
| `SupervisorLaunchRequest` = `{sandboxId, executionId, artifactId, allocationId, bootNonce, idempotencyKey}`                                                          | [`wire/supervisor.ts:10-17,50-72`](../src/wire/supervisor.ts)                                                        |
| capnp `LaunchRequest` (same 6 fields); comment "deliberately no ... netns, or nftables fields"                                                                       | [`supervisor.capnp:6-7,17-24`](../schema/supervisor.capnp)                                                           |
| hostd `exposeHttp` wire handler returns `unsupportedFeature`                                                                                                         | [`service.ts:507-517`](../src/hostd/service.ts)                                                                      |
| `HostSandbox.exposeHttp @5 (guestPort) -> ExposureResult`; `Exposure {guestPort, hostPort, url}`                                                                     | [`host_control.capnp:168-179,219`](../schema/host_control.capnp)                                                     |
| `Sandbox.exposeHttp` throws `ImplementationPendingError`; fake throws                                                                                                | [`sdk/sandbox.ts:805-806`](../src/sdk/sandbox.ts); `testing/mod.ts:911`                                              |
| overlay-init parses `studiobox.*` cmdline tokens, does **no** network config; its sha256 is a manifest input pin                                                     | [`overlay-init.sh:33-34,59-73`](../images/overlay_init/overlay-init.sh)                                              |
| oom seam: guest `AgentOomAnnotator`, default `() => false`, "real cgroup detection replaces this in M10"                                                             | [`agent/processes.ts:301-303,404-433`](../src/agent/processes.ts); [`agent/service.ts:796`](../src/agent/service.ts) |

---

## 1. IP / subnet allocation

### Pool

A single private **`10.201.0.0/16`** pool, carved into **`/30`** subnets (one
per sandbox NIC). Rationale for `/30`: it is the smallest subnet that yields a
usable host+guest pair (network `.0`, host `.1`, guest `.2`, broadcast `.3`),
which is exactly the point-to-point shape. A `/16` gives **16384** concurrent
slots — far above any single-host sandbox count, and it keeps the whole pool a
single CIDR for the one shared NAT/isolation rule (§3).

> **Open decision — pool CIDR.** `10.201.0.0/16` is a recommendation, not a
> constraint. It must not overlap the Lima host bridge, `docker0`, or the guest
> loopback. Make it a `NetworkController` option (`poolCidr`, default
> `10.201.0.0/16`) so an operator can move it. IPv6 guest addressing is **out of
> scope for M10**: the ruleset hard-seals v6 when `guestIp6` is unset
> (`meta nfproto ipv6 drop`,
> [`ruleset.ts:252-256`](../src/rootd/network/ruleset.ts)), so leaving
> `guestIp6` undefined is the correct fail-closed default.

### Slot → addresses (pure function)

Slot index `i` (0-based, `0..16383`):

```
third   = i >> 6                 // 64 /30s per third-octet
base4   = (i & 63) << 2          // 0,4,8,…,252
network = 10.201.<third>.<base4>          //  .0/30
hostIp  = 10.201.<third>.<base4 + 1>      //  .1  (host / gateway)
guestIp = 10.201.<third>.<base4 + 2>      //  .2  (guest)
netmask = 255.255.255.252 (/30)
```

Examples: `i=0` → net `10.201.0.0/30`, host `.1`, guest `.2`; `i=63` →
`10.201.0.252/30`; `i=64` → `10.201.1.0/30`; `i=16383` → `10.201.255.252/30`.

### Allocator interface

```ts
export interface SubnetAllocation {
  readonly slot: number; // 0..16383, journaled
  readonly tapName: string; // sbxtap<slot> (§2)
  readonly subnet: string; // "10.201.<t>.<b>/30"
  readonly hostIp: string; // "10.201.<t>.<b+1>"
  readonly guestIp: string; // "10.201.<t>.<b+2>"
  readonly guestCidr: string; // "10.201.<t>.<b+2>/30"
  readonly guestMac: string; // "02:00:0a:c9:<t-hex>:<b+2-hex>" (§4)
}

export interface SubnetAllocator {
  /** Lowest free slot. Throws SBX_NET_EXHAUSTED when the pool is full. */
  allocate(executionId: string): SubnetAllocation;
  /** Idempotent free of a slot (double-free is a no-op). */
  release(slot: number): void;
  /** Rebuild the in-use bitmap from journaled records (cold reconcile). */
  reserve(slot: number): void;
}
```

**Determinism / collision-freedom.** A **lowest-free-slot bitmap** allocator is
collision-free by construction (a slot is handed out to exactly one live
execution) and reusable after release. It is _not_ a hash of the id — hashing an
id to a `/30` risks a birthday collision that would silently bridge two
sandboxes onto one subnet, which is unacceptable. The allocated `slot` is
**journaled** (§9) so it is authoritative across a supervisor crash.

**Exhaustion.** `allocate` on a full pool throws a typed `SBX_NET_EXHAUSTED`
(surfaced to hostd as capacity pressure, mapped to `SBX_HOST_STATE`). This
should never fire before the memory/vcpu capacity ledger caps the host far
below 16384.

**Reuse-after-reclaim.** `release(slot)` clears the bit. Because reclaim tears
the TAP + tables down by exact name (§8) _before_ the slot is freed, a
subsequent `allocate` that reuses the slot always finds a clean `sbxtap<slot>`.

**Cold reconcile.** On rootd start, before the destructive sweep, the allocator
`reserve()`s every slot cited by a non-terminal journaled record (derived from
`resources.tapName`), so the sweep's teardown and any concurrent launch agree on
ownership. See §8.

---

## 2. TAP naming

`tapName = "sbxtap" + slot` (decimal). Longest is `"sbxtap16383"` = **11 chars ≤
15** (Linux `IFNAMSIZ`), and every char is in `[A-Za-z0-9_.-]`, so it satisfies
both the ruleset's `TAP_NAME` regex
([`ruleset.ts:105`](../src/rootd/network/ruleset.ts)) and the kernel limit.

Derived from the **allocation slot**, not the execution id: the execution id
(`exec-<20 char suffix>`, [`control_core.ts:387`](../src/hostd/control_core.ts))
is 25 chars and would blow `IFNAMSIZ`; the slot is a small integer and is the
natural teardown/reuse key. The nft egress **table** name is independently
derived from the _sandbox id_ via `egressTableName`
([`ruleset.ts:191-205`](../src/rootd/network/ruleset.ts)) — the
`SandboxNetworkHandle` carries both (`sandboxId` → table, `tapDevice` → TAP), so
the two naming schemes coexist without coupling.

---

## 3. Host-side provisioning sequence

All host mutation goes through the **injected `CommandRunner`** seam (§10),
mirroring the egress engine ([`apply.ts:51-83`](../src/rootd/network/apply.ts)),
so the exact argv below is asserted in unit tests without touching the host.

### One-time, at rootd start (idempotent)

Installed once by `NetworkController.ensureGlobal()` from `main.ts` (§13):

```
# 1. Enable IPv4 forwarding (host is the gateway).
sysctl -w net.ipv4.ip_forward=1

# 2. Allow loopback-sourced DNAT for exposeHttp (§6). route_localnet on lo +
#    every TAP is set lazily at TAP-create time; the global default stays off.

# 3. Shared NAT masquerade for the whole pool, and inter-sandbox isolation.
#    Rendered as ONE atomic `nft -f` add;delete;add script per table so the
#    call is idempotent (re-apply replaces, never appends duplicates — the
#    same pattern as renderApplyScript, ruleset.ts:414-420).
nft -f - <<'EOF'
add table ip studiobox_nat
delete table ip studiobox_nat
table ip studiobox_nat {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr 10.201.0.0/16 oifname != "sbxtap*" masquerade
  }
}
add table inet studiobox_isolation
delete table inet studiobox_isolation
table inet studiobox_isolation {
  chain forward {
    type filter hook forward priority -10; policy accept;
    ip saddr 10.201.0.0/16 ip daddr 10.201.0.0/16 drop
  }
}
EOF
```

> **Shared vs per-sandbox masquerade — decision: ONE shared masquerade for the
> whole `/16`.** Justification: (a) SNAT to the uplink is not per-sandbox policy
> — the _filter_ table already scopes what each guest may reach; masquerade only
> fixes the return path; (b) a single rule cannot race a per-sandbox reclaim, so
> tearing a sandbox down never risks removing another's SNAT; (c) it is one
> `nat`/`postrouting` rule for the whole host. It coexists with the per-sandbox
> **filter** tables because they hang off different hooks (`nat/postrouting`
> priority `srcnat` vs the per-sandbox `filter/forward` priority `0`,
> [`ruleset.ts:103`](../src/rootd/network/ruleset.ts)) and never share state.
>
> **Inter-sandbox isolation** is the `studiobox_isolation` forward-drop. It only
> affects _forwarded_ guest↔guest packets (guest A `10.201.0.2` → guest B
> `10.201.0.6` transits `tapA`→`tapB` and is dropped). Guest → its **own
> gateway** (host TAP IP `.1`) and guest → any host TAP IP are **local input**,
> not forward, so this rule never blocks them — see §4/§12 for why that matters
> for DNS. `priority -10` runs it before the per-sandbox filters, but the drop
> is terminal across tables regardless, so it seals guest↔guest even for
> _unrestricted_ sandboxes whose own filter chain is empty
> ([`ruleset.ts:230-239`](../src/rootd/network/ruleset.ts)).

> **Host prerequisite — nothing else on the host may DROP at the
> `filter/forward` hook.** `ensureGlobal` opens forwarding and installs its own
> tables, but a base-chain `accept` is **not** terminal across tables: every
> base chain registered on the hook still runs, and any one of them may DROP. A
> co-tenant ruleset with a blanket forward-drop therefore blackholes ALL guest
> egress even though every studiobox rule accepted. The one seen in the wild is
> **Docker** — `dockerd` sets `iptables -P FORWARD DROP` when it starts — which
> is why the CI runner (Docker preinstalled and running) needs the pool-scoped
> ACCEPTs `.github/workflows/integration.yml` inserts before the suite:
>
> ```
> iptables -I FORWARD -s 10.201.0.0/16 -j ACCEPT
> iptables -I FORWARD -d 10.201.0.0/16 -j ACCEPT
> ```
>
> An ACCEPT inside the iptables `filter` table is terminal for **that table
> only**, so the per-sandbox `inet sbx_eg_*` filter is a different table and
> still judges — and still drops — a restricted sandbox's denied destinations. A
> dedicated studiobox host (`studiobox host up` into a fresh Lima VM) has no
> such co-tenant and needs nothing.

### Per-sandbox, at launch (before firecracker boots)

Ordered; `<uid>`/`<gid>` are the jailer's drop-to ids
([`launch_planner.ts:135-138,169-170`](../src/rootd/launch_planner.ts)):

```
# a. Create the TAP owned by the firecracker uid so the jailed process may
#    open it. Tolerate "File exists" for crash-restart idempotency (precede
#    with `ip link del` best-effort, or match the EEXIST stderr).
ip tuntap add dev sbxtap<slot> mode tap user <uid> group <gid>

# b. Give the host its gateway address on the TAP.
ip addr add 10.201.<t>.<b+1>/30 dev sbxtap<slot>

# c. Bring it up.
ip link set dev sbxtap<slot> up

# d. Permit loopback-sourced DNAT to this TAP (exposeHttp, set now so a later
#    exposeHttp needs no extra host mutation).
sysctl -w net.ipv4.conf.sbxtap<slot>.route_localnet=1
```

Then the egress FILTER table is applied via the existing engine
(`EgressController.apply(spec, handle, { resolvers: [hostIp] })`,
[`apply.ts:164-199`](../src/rootd/network/apply.ts)) with
`handle = { sandboxId, tapDevice: "sbxtap<slot>", guestIp }` (**no `netns`** —
the whole dataplane is host-namespace). An `EgressApplyError` is **fatal** to
the launch (the engine has already installed the deny-all seal,
[`apply.ts:178-197`](../src/rootd/network/apply.ts)): abort boot and reclaim
(§8).

> The `resolvers: [hostIp]` argument documents the intended DNS destination in
> the filter table, but see §4/§12: because the guest reaches its resolver at
> its own gateway (`hostIp`), that traffic is **local input** and never
> traverses the forward-hook filter — so the DNS-allow rule is
> belt-and-suspenders, not the load-bearing path. Passing it keeps the contract
> explicit and future-proofs a move of dnsmasq to a forwarded address.

### Teardown (exact reverse, each tolerating "already gone")

```
nft delete table ip   sbx_pf_<idtoken>     # exposeHttp forwards (§6), if any
# egress filter table: EgressController.reclaim({ sandboxId })  (ruleset.ts:422-430)
ip link set dev sbxtap<slot> down          # optional; `del` implies it
ip link del  dev sbxtap<slot>              # removes addr + link atomically
# shared studiobox_nat / studiobox_isolation are NOT torn down per sandbox
```

Idempotency: `ip link del` on a missing device and `nft delete table` on a
missing table both exit non-zero with a recognizable stderr — the controller
treats "No such file/device"/"No such table" as success (mirroring
`EgressController.reclaim`'s idempotent `add;delete` script,
[`ruleset.ts:423-430`](../src/rootd/network/ruleset.ts)).

---

## 4. Guest-side config

### NIC + kernel cmdline

The planner adds exactly one NIC to the `VmConfig`
([`launch_planner.ts:235-259`](../src/rootd/launch_planner.ts), the hotspot):

```ts
config.network_interfaces = [{
  iface_id: "eth0",
  host_dev_name: "sbxtap<slot>",
  guest_mac: "02:00:0a:c9:<t-hex>:<b+2-hex>", // locally-administered, unicast
  // mtu / rx_rate_limiter / tx_rate_limiter omitted for M10
}];
```

Field names/shape confirmed against the pinned dependency
(`@nullstyle/firecracker@0.2.0`: `NetworkInterface` = `guest_mac?`,
`host_dev_name` (req), `iface_id` (req), `mtu?`, `rx_rate_limiter?`,
`tx_rate_limiter?`; `VmConfig.network_interfaces?: NetworkInterface[]`,
`config.ts:43`). The adapter applies it via `putNetworkInterface` in config
order (`config.ts:88-89`), which is why the TAP must exist first (§3).

**MAC.** Locally-administered (`0x02` low bit), unicast, derived from the guest
IP's low 16 bits (`10.201` is the fixed pool prefix → `0a:c9`), so it is unique
per slot and deterministic: `02:00:0a:c9:<third>:<b+2>` in hex.

**`ip=` cmdline token** (appended to `bootArgs`,
[`launch_planner.ts:223-233`](../src/rootd/launch_planner.ts)):

```
ip=10.201.<t>.<b+2>::10.201.<t>.<b+1>:255.255.255.252::eth0:off
   └ client ────────┘  └ gateway ─────┘ └ netmask ────┘  └dev┘ └autoconf off
```

Fields are `client:server:gw:netmask:hostname:device:autoconf` (`server` = NFS,
left empty). `autoconf=off` because the address is static. This relies on the
golden **kernel having `CONFIG_IP_PNP=y`** — a **prerequisite to verify** on the
golden kernel build (if absent, eth0 must instead be configured by overlay-init
with `ip addr add`/`ip route add`; keep that as the fallback).

**DNS token.** Add `studiobox.dns=<resolverIp>` to `bootArgs`:

- restricted sandbox → `<hostIp>` (the per-sandbox dnsmasq, §5);
- unrestricted sandbox → `<hostIp>` too **if** dnsmasq always runs (recommended,
  §5), else a configured public resolver (e.g. `1.1.1.1`).

### overlay-init.sh changes (forces a golden rebake)

overlay-init currently does **no** network config and only parses
`studiobox.vsock_port` / `studiobox.token`
([`overlay-init.sh:59-73`](../images/overlay_init/overlay-init.sh)). Add, after
the overlayfs mount and cmdline parse, **before** the `chroot`:

```sh
# Parse the new tokens alongside the existing ones (same loop, lines 62-67).
#   studiobox.dns=*)       DNS_IP="${tok#studiobox.dns=}" ;;
# Bring the NIC up (kernel ip= has already assigned eth0 when CONFIG_IP_PNP;
# this is the belt for the no-PNP fallback and is harmless when up):
ip link set eth0 up 2>/dev/null || true
# Write resolv.conf into the writable overlay root (never the read-only golden
# root — same discipline as the token file, lines 86-88):
if [ -n "${DNS_IP:-}" ]; then
  printf 'nameserver %s\n' "$DNS_IP" > /mnt/root/etc/resolv.conf
fi
```

> **CRITICAL — golden rebake.** `overlay-init.sh`'s sha256 is a manifest input
> pin (`overlayInitSha256`,
> [`overlay-init.sh:33-34`](../images/overlay_init/overlay-init.sh)), so **any**
> edit here rolls the artifact-set manifest hash and forces a golden rebake.
> Sequence this edit (work-item **W7**, §13) _once_ and rebake the golden set;
> every launch-config `manifestHash` must be updated in lockstep.

> **Always-dnsmasq vs only-on-wildcard — recommendation: run dnsmasq for every
> non-netless sandbox, so `resolv.conf` is uniformly `<hostIp>`.** A restricted
> sandbox _must_ have it (its filter allows DNS only to the resolver); an
> unrestricted sandbox runs a plain forwarder. Uniform guest config + uniform
> teardown (always one dnsmasq) outweighs one lightweight process per 512 MiB
> VM. If process count ever matters, the documented optimization is: skip
> dnsmasq for unrestricted, set `studiobox.dns=<public>` — the overlay-init
> logic above already supports either.

---

## 5. dnsmasq / ipset wildcard lifecycle

The engine already renders the fragment
([`ruleset.ts:445-461`](../src/rootd/network/ruleset.ts)); nothing installs or
reaps dnsmasq (`BACKLOG.md:220-226`). Build a **`DnsmasqController`** with the
same injected-runner discipline as the egress engine.

### Per-sandbox instance

- **Bind:** `--listen-address=<hostIp>` `--bind-interfaces`
  `--interface=sbxtap<slot>` `--except-interface=lo` — one dnsmasq per sandbox,
  reachable only at its own gateway on `<hostIp>:53`.
- **Upstream:** `--no-resolv --server=<upstream>` (host's real resolver; the
  host-side upstream query is not subject to the guest's forward filter).
- **Wildcards:** `--conf-file=/run/studiobox/dns/<slot>.conf`, whose contents
  are exactly `renderDnsmasqFragment(resolved, tableName)` — `stop-dns-rebind`
  plus one `nftset=/…/4#inet#<table>#wild4_i,6#…#wild6_i` line per wildcard
  ([`ruleset.ts:452-460`](../src/rootd/network/ruleset.ts)). Empty fragment
  (`""`) ⇒ no conf-file needed; dnsmasq runs as a plain forwarder.
- **Process management:** `--pid-file=/run/studiobox/dns/<slot>.pid`
  `--no-daemon`? No — run daemonized with a pidfile so the controller does not
  own the child handle across reconcile; the **pidfile is the authoritative
  teardown key** (survives a rootd crash). The pidfile path is journaled
  (`resources.dnsmasqPidfile`, §9).

```
dnsmasq --keep-in-foreground=false \
  --pid-file=/run/studiobox/dns/<slot>.pid \
  --listen-address=<hostIp> --bind-interfaces \
  --interface=sbxtap<slot> --except-interface=lo \
  --no-resolv --server=<upstream> \
  [--conf-file=/run/studiobox/dns/<slot>.conf]
```

### Lifecycle

- **install** — at launch, after the TAP is up and the egress table is applied
  (the filter table's wildcard sets `wild4_i`/`wild6_i` must exist before
  dnsmasq references them via `nftset=`). Ordering: TAP → egress apply →
  dnsmasq.
- **reload** — a re-apply of `allowNet` (future: TTL refresh) rewrites
  `<slot>.conf` and sends `SIGHUP` to the pid; M10 scope is install + reap only.
- **reap** — on reclaim, `kill $(cat /run/studiobox/dns/<slot>.pid)` then unlink
  the pidfile + conf-file, each tolerating "already gone". First step of the
  reclaim order (§8).

### Host-safe testability

`DnsmasqController` takes the injected `CommandRunner` (spawn argv asserted)
plus an injected **`ProcessSignaller`** (`signal(pid, sig)`) and
**`FileWriter`** (conf/pidfile writes), so install/reap render the exact argv +
file contents with no real dnsmasq. The config body is produced by the
already-pure `renderDnsmasqFragment` — assert it byte-for-byte.

### Security preservation

The nft `@blocked4/@blocked6` guard is the **authoritative** anti-poison seal
([`ruleset.ts:353-376`](../src/rootd/network/ruleset.ts)); `stop-dns-rebind` in
the fragment is defense-in-depth
([`ruleset.ts:440-460`](../src/rootd/network/ruleset.ts)). Binding dnsmasq to
`<hostIp>` on `sbxtap<slot>` (not `0.0.0.0`) keeps one sandbox's resolver
unreachable from another sandbox's TAP (which is also enforced by §3 isolation).
Confirmed: the resolver.ts martian/`@blocked` carving is preserved because this
controller only _transports_ the engine's fragment unchanged.

---

## 6. exposeHttp

hostd returns `unsupportedFeature` today
([`service.ts:507-517`](../src/hostd/service.ts)); the wire surface already
exists
(`HostSandbox.exposeHttp @5 (guestPort) -> Exposure {guestPort, hostPort, url}`,
[`host_control.capnp:168-179,219`](../schema/host_control.capnp)); the SDK
method throws `ImplementationPendingError`
([`sdk/sandbox.ts:805-806`](../src/sdk/sandbox.ts)).

### Port lease (hostd-owned)

Reserved forward range **40100–40199** (100 ports, DESIGN §9). A
`ForwardPortAllocator` in `HostControlCore` leases the lowest free host port per
`exposeHttp(guestPort)` call, keyed to the sandbox; exhaustion →
`SBX_HOST_STATE`. The lease is released when the sandbox terminates (folded into
the single `onExpire(sandboxId)` kill path,
[`control_core.ts:14-22`](../src/hostd/control_core.ts)).

### Host → guest DNAT (rootd installs; root-only)

hostd is unprivileged, so `HostControlCore.exposeHttp` allocates the host port
then calls a **new** `RootdGateway.exposeHttp(executionId, guestPort, hostPort)`
(→ new `SupervisorApi.exposeHttp`, §13/W6). rootd installs a **per-sandbox** nft
table so forwards are reclaimable and isolated by exact name:

```
nft -f -  (add;delete;add so re-apply is idempotent and additive per rule set)
table ip sbx_pf_<idtoken> {
  chain output {
    type nat hook output priority -100; policy accept;
    ip daddr 127.0.0.1 tcp dport <hostPort> dnat to <guestIp>:<guestPort>
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    ip daddr <guestIp> tcp dport <guestPort> snat to <hostIp>
  }
}
```

`<idtoken>` reuses `egressTableName`'s injective encoding
([`ruleset.ts:154-205`](../src/rootd/network/ruleset.ts)) so `sbx_pf_<idtoken>`
is collision-free the same way `sbx_eg_<idtoken>` is. The DNAT is on the
**output** hook because the exposed URL `http://127.0.0.1:<hostPort>` is dialed
**on the host** (loopback-originated → `output`, not `prerouting`); the
**SNAT-to-`hostIp`** makes the guest reply to its gateway (it cannot route back
to `127.0.0.1`), and `route_localnet=1` on the TAP (set at §3 step d) lets the
kernel route the loopback-sourced packet out the TAP. rootd journals
`resources.exposedPorts += {hostPort, guestPort}` (§9) in the same commit.

The result maps to the wire `Exposure` as
`{guestPort, hostPort,
url: "http://127.0.0.1:<hostPort>"}`.

### Port isolation (survives OTHER sandboxes' restarts)

Each sandbox's forwards live in its **own** `sbx_pf_<idtoken>` table and its
host port is a distinct lease. Another sandbox's reclaim/relaunch deletes only
_its_ `sbx_pf_<other>` table and frees only _its_ leases, so an exposed port is
untouched. This is the same "own table, exact-name reclaim" isolation the egress
engine already relies on ([`docs/networking.md:30-36`](./networking.md)).

### Reclaim / journal

On sandbox terminate, rootd deletes `sbx_pf_<idtoken>` (idempotent) and hostd
releases the host-port leases. On **cold reconcile**, rootd reads
`resources.exposedPorts` from the journal and deletes `sbx_pf_<idtoken>` for the
reconciled record even with no live state (§8).

### Surface summary

- SDK: implement `Sandbox.exposeHttp(guestPort)` (currently
  [`sdk/sandbox.ts:805-806`](../src/sdk/sandbox.ts)) → wire
  `HostSandbox.exposeHttp`.
- hostd: `HostControlCore.exposeHttp(sandboxId, guestPort)` (does not exist yet,
  `BACKLOG.md:228-238`) + `service.ts` handler replaces the `unsupportedFeature`
  stub ([`service.ts:507-517`](../src/hostd/service.ts)) + the fake
  (`testing/mod.ts:911`).
- rootd: `SupervisorApi.exposeHttp` + `SupervisorCore.exposeHttp` install +
  journal.

---

## 7. netless

`CreateOptions.netless @6`
([`host_control.capnp:32`](../schema/host_control.capnp)) threads to the planner
(§13). When `netless === true`:

- **no** subnet allocation, **no** TAP, `config.network_interfaces` left
  **undefined** (guest is vsock-only, exactly as today,
  [`launch_planner.ts:235-259`](../src/rootd/launch_planner.ts));
- **no** egress table, **no** dnsmasq;
- no `ip=` / `studiobox.dns` cmdline tokens;
- `resources.tapName` left **unset** — so `EgressReclaimHook`
  ([`reclaim_hook.ts:63-64`](../src/rootd/network/reclaim_hook.ts)) and the new
  `NetworkReclaimHook` (§8) both no-op for the record, and reclaim is a clean
  nothing-to-do.

A netless sandbox is therefore byte-for-byte the current vsock-only launch.

---

## 8. Reclaim ordering + idempotency

Teardown order (each step tolerant of "already gone"):

```
1. dnsmasq        kill $(cat /run/studiobox/dns/<slot>.pid); unlink pid+conf
2. egress table   EgressController.reclaim({ sandboxId })      (ruleset.ts:422-430)
3. DNAT           nft delete table ip sbx_pf_<idtoken>
4. TAP            ip link del dev sbxtap<slot>
5. NAT masquerade (shared; NOT touched per sandbox — see §3)
6. release alloc  SubnetAllocator.release(slot)
7. overlay/refct  ArtifactReclaimHook (unchanged, launch_planner.ts:359-389)
```

Steps 1–6 are a **new `NetworkReclaimHook`** (which internally owns the
`EgressController` so it can also do step 2, superseding the standalone
`EgressReclaimHook` for the wired path — or compose them, see below). Step 7 is
the existing `ArtifactReclaimHook`. Register order on `SupervisorCore`:
`reclaimHooks: [networkReclaimHook, artifactReclaimHook]` so the network hook
runs first and overlay/refcount is last (hooks run in array order,
[`supervisor_core.ts:704-716`](../src/rootd/supervisor_core.ts)).

> **Compose vs supersede.** Two shapes are valid: (a) a single
> `NetworkReclaimHook` that does steps 1–6 (owns dnsmasq controller +
> port-forward controller + `EgressController` + allocator), or (b) keep the
> existing `EgressReclaimHook` for step 2 and add a `NetworkReclaimHook` for
> 1,3,4,6, registering
> `[dnsmasq/pf/tap hook, egressReclaimHook, artifactReclaimHook]`. **Recommend
> (a)** — one hook keys off `resources.tapName` once
> ([`reclaim_hook.ts:62-64`](../src/rootd/network/reclaim_hook.ts) is the
> template) and derives everything else (`slot` from tapName, `tableName` from
> `record.id`, ports from `resources.exposedPorts`) from the journal, so a cold
> reconcile with **no live state** reaps fully.

**Idempotency.** Every step is name-exact and gone-tolerant, so it composes with
the **DESTRUCTIVE restart reconcile**
([`supervisor_core.ts:543-624`](../src/rootd/supervisor_core.ts)): the package
sweep SIGKILLs orphan VMMs first, then hooks run per record. A throwing hook
parks the record `quarantined`
([`supervisor_core.ts:704-716`](../src/rootd/supervisor_core.ts)), which is
correct — a leaked TAP/table must be surfaced, never blind-swept.

**What the journal must carry for cold reaping** (§9): `tapName` (→ slot → TAP +
allocator release), `record.id` (→ `sbx_eg_`/`sbx_pf_` table names — already on
the record), `dnsmasqPidfile` (→ kill), `exposedPorts` (→ pf table exists / host
ports to free). No live in-memory map is required to reclaim.

**Allocator rebuild on cold start.** Before the sweep, iterate journaled
non-terminal records and `SubnetAllocator.reserve(slotOf(tapName))` so a
post-reconcile launch cannot hand out a slot whose TAP the sweep is mid-teardown
on.

---

## 9. `state/model.ts` additions

Current `SandboxResources` =
`{uid?, gid?, overlayPath?, tapName?, netnsPath?,
exposedPorts: number[]}`
([`model.ts:77-84`](../src/state/model.ts)); the validator allows exactly those
keys and validates `exposedPorts` as a unique `1..65535` int array
([`model.ts:235-268`](../src/state/model.ts)). `tapName` and `netnsPath` already
exist but are **unused** (`BACKLOG.md:207`).

Proposed shape:

```ts
export interface ExposedPort {
  readonly hostPort: number; // 40100..40199
  readonly guestPort: number; // 1..65535
}

export interface SandboxResources {
  uid?: number;
  gid?: number;
  overlayPath?: string;
  tapName?: string; // existing, now WRITTEN: "sbxtap<slot>"
  netnsPath?: string; // existing; stays UNUSED for M10 (host-ns model)
  hostIp?: string; // NEW: "10.201.<t>.<b+1>"
  guestIp?: string; // NEW: "10.201.<t>.<b+2>" (anti-spoof source)
  subnet?: string; // NEW: "10.201.<t>.<b>/30"
  dnsmasqPidfile?: string; // NEW: "/run/studiobox/dns/<slot>.pid"
  exposedPorts: ExposedPort[]; // CHANGED number[] -> ExposedPort[]
}
```

Validator changes ([`model.ts:235-268`](../src/state/model.ts)):

- add `"hostIp"`, `"guestIp"`, `"subnet"`, `"dnsmasqPidfile"` to the
  `assertKeys` allow-list and validate as bounded text (reuse `assertText`, cap
  ~64/4096);
- change `exposedPorts` validation from `number[]` to `ExposedPort[]`: each
  entry an object with `hostPort` (`40100..40199`) and `guestPort` (`1..65535`),
  `hostPort` unique across the array.

> **Migration note.** `SANDBOX_RECORD_VERSION` is `2`
> ([`model.ts:3`](../src/state/model.ts)). Changing `exposedPorts`' element type
> is a breaking journal change. Because `exposedPorts` is always `[]` at launch
> and only grows via `exposeHttp` (unbuilt today), no live journal carries
> non-empty `exposedPorts`, so a **v2-in-place** widening is safe _if_ a v2
> reader tolerates the old empty-array form (it does — `[]` is valid under
> both). If any deployed journal could carry the old number form, bump to
> `SANDBOX_RECORD_VERSION = 3` and accept `2` read-only. Recommend: in-place v2
> widening (no deployed non-empty `exposedPorts` exists).

`tapName`/`hostIp`/`guestIp`/`subnet`/`dnsmasqPidfile` are written by the
planner in the **staging→booting** commit (§13/W2), riding the same
`#ownedTransition` patch that already carries `artifact`
([`supervisor_core.ts:252-260`](../src/rootd/supervisor_core.ts));
`exposedPorts` grows later via `exposeHttp`.

---

## 10. Injected-runner seam (mandatory)

Every host-mutating command mirrors the egress engine's `CommandRunner`
([`apply.ts:51-83`](../src/rootd/network/apply.ts)):

```ts
export interface CommandRunner { // reuse the egress one verbatim
  run(
    bin: string,
    args: readonly string[],
    stdin: string,
  ): Promise<EgressCommandResult>; // { success, code, stderr }
}
```

- **`NetworkController`** (TAP/addr/link/sysctl + global NAT/isolation) takes
  the injected `CommandRunner`; `ip`/`sysctl`/`nft` bins are options (default
  `"ip"`/`"sysctl"`/`"nft"`, matching `EgressControllerOptions.ipBin`/ `nftBin`,
  [`apply.ts:88-96`](../src/rootd/network/apply.ts)). Tests assert the exact
  argv sequence of §3 with a fake runner — **no host mutation**.
- **`DnsmasqController`** takes `CommandRunner` + a `ProcessSignaller`
  (`signal(pid, sig)`) + a `FileWriter` (conf/pidfile). Assert spawn argv +
  `renderDnsmasqFragment` output + the SIGKILL pid.
- **`PortForwardController`** takes `CommandRunner`; assert the `sbx_pf_<id>`
  nft script + `route_localnet` sysctl.
- **`SubnetAllocator`** is pure in-memory (no runner) — assert slot math +
  reuse.

This is what makes "the bulk of the code unit/fake-testable on macOS" real: the
only integration surface is the fake-vs-real `CommandRunner`/`ProcessSignaller`,
exactly as the egress engine already proves
([`docs/networking.md:176-201`](./networking.md)).

---

## 11. fc-smoke validation plan

Real-nftables cases in the `fc-smoke` Lima VM (extend the existing egress smoke,
[`docs/networking.md:176-201`](./networking.md)), each a full
launch→assert→reclaim:

1. **Unrestricted reaches internet.** `allowNet` unset → guest
   `curl https://one.one.one.one` → `HTTP 200`; DNS resolves via `<hostIp>`
   dnsmasq (or public per §4 decision).
2. **Restricted allow.** `allowNet:["example.com"]` → `curl https://example.com`
   → `200`; `curl https://1.1.1.1` (not in allow-list) → timeout/`exit 28`
   (default-deny, mirrors the existing `:53`-vs-`:443` case).
3. **Wildcard.** `allowNet:["*.github.com"]` →
   resolve+`curl
   https://api.github.com` → `200` (dnsmasq fills `wild4_0`
   through the sandbox resolver); a poisoned `x.github.com`→`10.x` element stays
   **blocked** by `@blocked4` (re-uses the existing FIX-A probe,
   [`docs/networking.md:189-194`](./networking.md)).
4. **exposeHttp.** guest serves on `guestPort`; host
   `curl
   http://127.0.0.1:<hostPort>` → `200`; a second sandbox's
   launch+reclaim leaves the forward reachable (port-isolation assertion).
5. **Inter-sandbox isolation.** two sandboxes; guest A
   `curl
   http://10.201.<B>/…` (B's guest IP) → dropped even when both are
   unrestricted.
6. **Zero residue on reclaim.** after kill, assert: `ip link show sbxtap<slot>`
   → absent; `nft list ruleset` → no `sbx_eg_`/`sbx_pf_<id>`;
   `pgrep -f
   'dnsmasq.*<slot>'` → none; `ip route` → no `/30` for the slot;
   shared `studiobox_nat`/`studiobox_isolation` intact.

---

## 12. Security notes

- **Anti-spoof** depends on `guestIp` being the _real_ assigned address: the
  filter emits `ip saddr != <guestIp> drop`
  ([`ruleset.ts:251`](../src/rootd/network/ruleset.ts)), so the handle's
  `guestIp` **must** equal the `ip=` client address and the journaled
  `resources.guestIp`. The allocator is the single source of truth for all
  three.
- **DNS path is local-input, not forward.** The guest reaches its resolver at
  its own gateway (`<hostIp>` on `sbxtap<slot>`), which is a _local_ host
  address → INPUT hook, so it bypasses both the `studiobox_isolation`
  forward-drop (§3) and the per-sandbox forward filter. That is intentional and
  safe: dnsmasq is bound to that IP/interface only, and its **upstream** queries
  originate from the host (unfiltered by the guest's table).
- **Guest→host INPUT guard is ENFORCED (both modes).** Because all per-sandbox
  filtering is FORWARD-hook only, guest→host traffic (a guest to its gateway IP,
  to a `0.0.0.0` host listener, or to any host LAN IP) would otherwise be
  unfiltered — letting a RESTRICTED guest reach host services not in its
  `allowNet`. The shared `studiobox_hostguard` INPUT table
  (`NetworkController.ensureGlobal`,
  [`dataplane.ts`](../src/rootd/network/dataplane.ts)) closes this for BOTH
  restricted and unrestricted sandboxes: for `iifname "sbxtap*"` it ACCEPTs only
  udp/tcp `:53` (DNS to the per-sandbox dnsmasq on the gateway) and ICMP/ICMPv6
  echo, and DROPs everything else. It never blocks forwarded egress (that stays
  the per-sandbox forward filter's job) and never touches exposeHttp's
  output/postrouting DNAT/SNAT (which is not `sbxtap*`-input). This supersedes
  the earlier "deferred INPUT-hardening" note.
- **NAT hairpinning.** The single `studiobox_nat` masquerades `10.201.0.0/16`
  only on `oifname != "sbxtap*"` (§3), so guest→guest is never masqueraded (and
  is anyway dropped by isolation); exposeHttp's own SNAT-to-`hostIp` handles the
  loopback-DNAT return path (§6) without touching the shared rule.
- **DNS-rebind.** Preserved: `renderDnsmasqFragment` emits `stop-dns-rebind`
  ([`ruleset.ts:452-460`](../src/rootd/network/ruleset.ts)) and the ruleset's
  `@blocked4/@blocked6` guard is the authoritative seal
  ([`ruleset.ts:353-376`](../src/rootd/network/ruleset.ts)); the
  `DnsmasqController` transports the engine's fragment unchanged (§5), so the
  martian carving in `resolver.ts` is not weakened.
- **Inter-sandbox isolation.** Point-to-point `/30` TAPs are **not** bridged;
  isolation is the `studiobox_isolation` forward-drop, which seals guest↔guest
  even for unrestricted sandboxes whose own filter chain is empty
  ([`ruleset.ts:230-239`](../src/rootd/network/ruleset.ts)). Case 5 (§11) is the
  live proof.
- **Table-name injectivity carries over** to `sbx_pf_<idtoken>` (§6), so a
  hostile launcher cannot steer two ids onto one forward table
  ([`docs/networking.md:195-201`](./networking.md)).

---

## 13. Work-item decomposition + dependency order

Each item lists file touches. **Bold files are shared write hotspots** —
`launch_planner.ts`, `main.ts`, `state/model.ts`, `control_core.ts`,
`service.ts`, `wire/supervisor.ts`, `schema/*.capnp` — where concurrent writers
to the shared main checkout clobber each other (studiobox history). Items that
touch the same hotspot **must be sequenced**, not parallelized.

| ID     | Item                                                                                                                                                                                | File touches                                                                                                                                                                                                                                                                                      | Depends on                                                                           | Parallel-safe?                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **W1** | New network modules: `SubnetAllocator`, `NetworkController`, `DnsmasqController`, `PortForwardController` (+ tests), all injected-runner                                            | `src/rootd/network/dataplane.ts` (new), `allocator.ts` (new), `dnsmasq.ts` (new), `port_forward.ts` (new), `mod.ts` (export)                                                                                                                                                                      | egress engine (built)                                                                | **Yes** — all-new files                                                     |
| **W2** | Widen `SandboxResources` (+ validator, migration)                                                                                                                                   | **`state/model.ts`**                                                                                                                                                                                                                                                                              | —                                                                                    | Sequence w/ any model.ts writer                                             |
| **W3** | Thread `allowNet/netless/vcpus/kernelArgs` across the boundary                                                                                                                      | **`wire/supervisor.ts`**, **`schema/supervisor.capnp`**, **`schema/host_control.capnp`** (unchanged; already has fields), **`hostd/service.ts`** (`createInputFromWire`), **`hostd/control_core.ts`** (`CreateSandboxInput`, `create` launch call), `hostd/supervisor_client.ts` (`RootdGateway`) | —                                                                                    | Sequence w/ W6 (both touch service.ts, control_core.ts, wire/supervisor.ts) |
| **W4** | Wire the dataplane into launch: alloc→TAP→NIC→egress apply→dnsmasq; `ip=`/`studiobox.dns` cmdline; journal resources; `NetworkReclaimHook`; register hooks                          | **`launch_planner.ts`**, **`rootd/main.ts`** (build controllers + `ensureGlobal()` + `reclaimHooks:[network,artifact]`), `network/reclaim_hook.ts` (extend or new hook), **`supervisor_core.ts`** (staging→booting patch also writes `resources`)                                                 | W1, W2, W3                                                                           | Sequence w/ W2,W3,W6 (shared launch_planner/main/supervisor_core)           |
| **W5** | overlay-init network config + **golden rebake** (rolls `overlayInitSha256`)                                                                                                         | **`images/overlay_init/overlay-init.sh`**, golden manifest/pins, launch-config `manifestHash`                                                                                                                                                                                                     | W4 (cmdline token contract)                                                          | Sequence alone; rebake is a serialization point                             |
| **W6** | exposeHttp end-to-end: hostd port allocator + `HostControlCore.exposeHttp`; rootd `SupervisorApi.exposeHttp` + DNAT install + journal; wire handler; SDK `Sandbox.exposeHttp`; fake | **`supervisor.capnp`**, **`supervisor_core_api.ts`**, **`supervisor_core.ts`**, **`hostd/control_core.ts`**, **`hostd/service.ts`**, `hostd/supervisor_client.ts`, `sdk/sandbox.ts`, `testing/mod.ts`                                                                                             | W1 (PortForwardController), W2 (`exposedPorts` shape), W4 (guestIp/hostIp journaled) | Sequence w/ W3,W4 (shared service.ts/control_core/supervisor_core)          |
| **W7** | oom cgroup reader (independent of dataplane)                                                                                                                                        | `src/agent/processes.ts` (`AgentOomAnnotator` impl reading guest cgroup v2 `memory.events` `oom_kill`), `agent/service.ts:796` (drop hardcoded `oom:false`), `agent/main.ts` (wire annotator)                                                                                                     | —                                                                                    | **Yes** — agent-only files                                                  |

**Dependency order:** `W1 ∥ W7` first (all-new / isolated) → `W2` → `W3` → `W4`
→ `W5` (rebake) and `W6` (exposeHttp). `W6` may start after `W4` lands guestIp
journaling but shares `service.ts`/`control_core.ts`/`supervisor_core.ts` with
`W3`/`W4`, so it must be **sequenced after** them, not concurrent.

**Hotspot collision summary** (never two agents at once):

- `launch_planner.ts` → W4 only.
- `rootd/main.ts` → W4 only.
- `state/model.ts` → W2 only.
- `supervisor_core.ts` → W4 then W6.
- `supervisor_core_api.ts` / `schema/supervisor.capnp` → W3 (LaunchRequest) then
  W6 (exposeHttp) — sequence.
- `hostd/control_core.ts` → W3 then W6 — sequence.
- `hostd/service.ts` → W3 then W6 — sequence.
- `wire/supervisor.ts` → W3 only.
- `overlay-init.sh` → W5 only (and its rebake is a global serialization point).

---

## Open decisions (recommendations)

1. **Pool CIDR** `10.201.0.0/16` — recommend as default option,
   operator-overridable; must not overlap Lima/docker bridges. (§1)
2. **Shared vs per-sandbox NAT** — recommend **one shared** `studiobox_nat`
   masquerade for the whole pool. (§3)
3. **dnsmasq always vs wildcard-only** — recommend **always for non-netless**
   (uniform `resolv.conf`/teardown); optimization documented. (§4/§5)
4. **Reclaim hook shape** — recommend a **single `NetworkReclaimHook`** driving
   steps 1–6, keyed off `resources.tapName`. (§8)
5. **`exposedPorts` migration** — recommend **in-place v2 widening** (no
   deployed non-empty value exists); bump to v3 only if a live journal could
   carry the old number form. (§9)
6. **Kernel `CONFIG_IP_PNP`** — **verify on the golden kernel**; if absent,
   overlay-init `ip addr add` fallback (already scoped in §4/W5).
7. **netns** — **host namespace, no netns** (`SandboxNetworkHandle.netns` left
   undefined); `resources.netnsPath` stays unused for M10. (§3/§7)
8. **Host-reachability hardening** (INPUT-hook allow-only-`:53`) — **ENFORCED**
   for both restricted and unrestricted sandboxes via the shared
   `studiobox_hostguard` INPUT table (`NetworkController.ensureGlobal`); no
   longer deferred. (§12)
