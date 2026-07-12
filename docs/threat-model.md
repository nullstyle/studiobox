# Threat model

This document states what studiobox defends against, what it does not, and the
mechanisms that back each claim. It is a reader's digest of **DESIGN.md §8**;
where the two differ, DESIGN.md wins.

## The one-sentence model

> The **sandbox workload is hostile** (arbitrary code, contained by the kernel
> VM boundary); the **host user is trusted**; other same-user local processes
> are **semi-trusted** — and because a tunnel is exec-as-a-service, the control
> plane still fails closed.

Studiobox is a **single developer's workstation** running untrusted _workloads_.
It is explicitly **not** a multi-tenant service hardened against untrusted
_clients_ (DESIGN.md §1 non-goal). Read the [non-goal](#explicit-non-goal) below
before deploying it as anything else.

## Trust boundaries

| Principal                     | Trust        | What it can do                                                   | Contained by                                                           |
| ----------------------------- | ------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Sandbox workload** (guest)  | hostile      | Run arbitrary code, try to escape, exhaust resources, exfiltrate | Kernel VM boundary (jailer chroot + uid drop + cgroups), egress policy |
| **Host user** (you)           | trusted      | Everything; mints the token; owns the daemons                    | —                                                                      |
| **Same-user local processes** | semi-trusted | Could try to reach the loopback control port and drive sandboxes | Bearer token, bootstrap gate, single-use tickets                       |

The interesting boundary is the **middle**: a compromised or nosy same-user
process should not be able to silently turn studiobox into an exec service. That
is why the control plane authenticates and fails closed even though everything
is "local".

## The two-daemon privilege split

The load-bearing structural defense (DESIGN.md §3, §13 decision 1):

- **`studiobox-hostd` (unprivileged)** is the **only process that parses the
  public protocol**. It authenticates, negotiates, holds leases, and issues
  tickets — with **no root authority at all**. If a public-protocol parser bug
  is exploitable, the attacker lands as the unprivileged `studiobox` user, not
  root.
- **`studiobox-rootd` (root)** holds all the dangerous authority (jailer,
  `mknod`, netns/TAP/nftables, cgroups, the durable journal) but **parses no
  public protocol**. Its capnp surface (`supervisor.capnp`) accepts **logical
  IDs only** — no paths, argv, uids, cgroup names, or firewall fragments cross
  the socket. rootd resolves logical IDs to concrete resources internally,
  against the signed manifest and the reserved resource plan.

Net effect: **the process that touches hostile-adjacent bytes has no privilege,
and the process with privilege never touches those bytes.** Supervisor frames,
resource plans, bridge tokens, and path resolution are fuzzed as root-boundary
inputs (docs/firecracker-contract.md).

## Authentication and the bootstrap gate

- **Bearer token** minted at `host up`, delivered to the daemons and read by the
  SDK from `STUDIOBOX_TOKEN` or `~/.studiobox/token`. It is **provisioned via
  `limactl` file copy, never over the forwarded port** — the token never travels
  the network it protects.
- Every capnp plane runs a fail-closed **bootstrap gate**:
  `connected → negotiated → authenticated → closed`. Negotiation checks protocol
  major version, feature bitmask intersection, and `ContractIdentity` (schema
  bundle hash, capnp/WASM ABI, artifact manifest hash, firecracker pin) before
  any authenticated work. A client, hostd, and guest that disagree about
  artifacts **fail negotiation** instead of misbehaving.
- **Auth failures are rate-limited; token compares are constant-time** (carried,
  tested implementations).

## Tickets — binding tunnels to leases

The agent plane is **end-to-end**, not proxied method-by-method (DESIGN.md §4).
The workload-exec path is gated by single-use tickets so a same-user process
cannot replay its way to a shell:

1. The client calls `HostSandbox.openTunnel()`.
2. hostd issues a **single-use ticket**: 32 bytes, SHA-256 verifier, **15 s
   TTL**, dial budget 10 s < ticket expiry, **burn-before-check**.
3. The client dials the tunnel port and sends the 44-byte `SBXTUN1` preface.
4. hostd **burns the ticket before** asking rootd to `openBridge`.
5. rootd dials `vm.vsock.connect(AGENT_PORT)` and splices bytes verbatim.

Tickets are **revoked en masse on lease revocation and on daemon restart**. One
tunnel = one vsock stream = one capnp `SandboxAgent` session; hostd never
interprets agent-plane traffic. Ticket-before-dial ordering means an
unauthenticated client cannot spend VM/vsock resources.

## Transport security — staged

**Decision (DESIGN.md §8, §13 decision 3): TLS is staged, not day-one.**

- Early milestones run **token-over-loopback**: Lima forwards bind `127.0.0.1`,
  so the control and tunnel ports are reachable only from the host.
- Before 1.0, the control and tunnel listeners move to **pinned TLS**: the cert
  is generated in-VM, the fingerprint is retrieved via `limactl`, and the client
  pins it. This lands as an **M11 hardening item** (PLAN.md §M11), not a
  prerequisite for early milestones.

This is a deliberate default. If your deployment exposes the loopback ports
beyond a single trusted host before M11 TLS lands, the token is your only
transport protection — treat that as the semi-trusted-process boundary widening,
and prefer the TLS milestone first.

## Privilege split — socket hygiene

- rootd's supervisor UDS is `0660 root:studiobox` at
  `/run/studiobox/supervisor.sock`; hostd reaches it by **group membership**,
  not root.
- One-shot bridge sockets live under `/run/studiobox/b/`, are single-use with a
  short deadline, and are unlinked after the one authorized connection.
- All host-view Unix paths are validated against the ~104-byte `sun_path` budget
  **before** launch (setup/doctor/create preflight), so a path-overflow can
  never reach a spawn.

## Guest hardening

The workload is assumed hostile; the VM boundary is the containment (DESIGN.md
§8, §10):

- **jailer chroot + uid/gid drop + cgroups** — the inherited contract from
  `@nullstyle/firecracker`, including its CVE-2026-1386 staging hardening.
- **Copy-only staging** into each jail (DESIGN.md §13 decision 6): the kernel
  and golden rootfs are _copied_, never hardlinked, so an in-jail
  `chmod`/`chown` cannot mutate the shared golden source.
- **No shared mounts**; **vsock is the only host↔guest channel**.
- The guest agent (`studioboxd`) drops to uid 1000 and treats everything in the
  guest as untrusted; even a compromised guest userland stays confined by the VM
  boundary and the per-sandbox nftables egress policy.
- **Egress policy** (`allowNet`) is enforced as per-sandbox nftables rules on
  the TAP device — the workload cannot reach destinations outside its allowlist
  (PARITY.md, Tier B).

## Resource-exhaustion containment

A hostile workload trying to exhaust the host is bounded by layered enforcement
(DESIGN.md §9): Firecracker machine config (vcpu/mem) → jailer cgroups (cpu
quota, `pids.max`, `memory.max` backstop) → overlay size cap → per-sandbox fd
budgets in the daemons. `create()` fits or **fails fast** with
`HostCapacityError` (no queueing), so one workload cannot starve the admission
path.

## Recovery is destructive by design

On an unexpected `studiobox-rootd` restart, studiobox **destroys and
reconciles** rather than re-attaching to running microVMs (DESIGN.md §1, §6). It
runs `reconcile({ killLive: true })` (killing orphan VMMs after
`/proc/<pid>/cmdline` identity checks), reclaims
cgroups/overlays/TAP/netns/nftables/ports, and **revokes all leases and
tickets**. Affected records land in `terminated(reason: "host-restart")`.
Adopting a VMM whose supervisor died is exactly the unsafe path this policy
avoids — there is no live-adoption trust assumption to attack.

## Explicit non-goal

**Multi-tenant hostile-_client_ hardening is out of scope** (DESIGN.md §1). The
threat model is one developer's workstation running untrusted _workloads_, not a
shared service defending against untrusted _callers_. The control plane fails
closed against a semi-trusted same-user process, but studiobox does not claim to
safely arbitrate between mutually distrusting clients, enforce per-client quotas
against abuse, or resist a determined local attacker who already controls your
user account. If you need that, you need a different threat model than the one
studiobox is built for.

## Related documents

- [DESIGN.md](../DESIGN.md) §8 (security), §3 (topology), §9 (resources), §6
  (recovery) — the authoritative source.
- [docs/permissions.md](permissions.md) — the Deno permission matrix that
  realizes the privilege split.
- [docs/firecracker-contract.md](firecracker-contract.md) — the root-boundary
  contract and its fuzzing/acceptance gates.
- [PARITY.md](../PARITY.md) — where the egress/expose behaviors are documented.
