# Deno permissions per component

Studiobox is a Deno-native system with a **deliberate privilege split**: no
single process holds all the authority. This document is the permission matrix —
which Deno `--allow-*` flags each component needs, and _why_. The guiding rule
(DESIGN.md §8) is least privilege: the network-facing daemon is unprivileged and
never touches root resources; the root daemon never parses public protocol.

Modeled on `@nullstyle/firecracker`'s permissions doc: state the honest posture
for each process, not a single blanket `-A`.

## Summary matrix

| Component                           | Posture                                | Root?             | Key permissions                                                                                                              |
| ----------------------------------- | -------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Client SDK** (`.`)                | your app's own process                 | no                | `--allow-net=127.0.0.1` (+ your app's needs); `--allow-env=STUDIOBOX_TOKEN`, `--allow-read` for `~/.studiobox/token`         |
| **`studiobox-hostd`**               | unprivileged daemon (`studiobox` user) | no                | `--allow-net` (control + tunnel + expose ports), `--allow-read`/`--allow-write` on `/run/studiobox` + journal, `--allow-env` |
| **`studiobox-rootd`**               | root supervisor                        | **yes**           | `-A` (honest): jailer, `mknod`, netns/TAP/nftables, cgroups, `Deno.Command`, vsock, journal                                  |
| **`studioboxd`** (guest agent)      | in-guest, compiled binary              | drops to uid 1000 | compiled with `-A --unstable-vsock`; confined by the VM + jailer, not by Deno flags                                          |
| **`FakeSandboxHost`** (`./testing`) | in-process test double                 | no                | runs as _you_; `--allow-read`/`--allow-write`/`--allow-run`/`--allow-env`/`--allow-sys=uid,gid`                              |

> `-A` appears only inside the microVM host (rootd, and the guest agent inside
> the VM). It is never exposed to the physical host network or to sandbox
> workloads. See DESIGN.md §8 and the firecracker integration contract
> ([docs/firecracker-contract.md](firecracker-contract.md)).

---

## Client SDK — `import { Sandbox } from "@nullstyle/studiobox"`

The SDK runs **inside your own Deno process**, so its permissions are a subset
of your program's. It needs only:

| Permission                            | Why                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allow-net=127.0.0.1`               | Reach `studiobox-hostd` over the forwarded loopback control port, and dial the tunnel port for the end-to-end agent session. Widen only if hostd is remote. |
| `--allow-env=STUDIOBOX_TOKEN`         | Read the bearer token from the environment.                                                                                                                 |
| `--allow-read=$HOME/.studiobox/token` | Fallback token location when `STUDIOBOX_TOKEN` is unset.                                                                                                    |

The SDK does **not** need `--allow-run`, `--allow-write`, or broad
`--allow-read`: process execution and filesystem access happen **inside the
sandbox**, over RPC, not on your host. (`fs.upload` / `fs.download` do
read/write the local paths you name — grant those paths if you use them.)

Your app of course keeps whatever permissions it needs for its own work; the
list above is only what studiobox adds.

## `studiobox-hostd` — the unprivileged control daemon

The **only process that speaks the public protocol**. It authenticates clients,
negotiates, holds leases and the capacity ledger, issues tunnel tickets, and
decides egress/expose policy — but it **never touches root resources directly**
(DESIGN.md §3). It runs as the unprivileged `studiobox` user.

| Permission                                                                    | Why                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--allow-net=127.0.0.1:<control>,127.0.0.1:<tunnel>,127.0.0.1:<expose-range>` | Listen on the control port, the tunnel port, and the exposeHttp forward range (defaults 40000 / 40001 / 40100–40199).                      |
| `--allow-read=/run/studiobox`                                                 | Connect to `rootd`'s supervisor UDS and one-shot bridge sockets under `/run/studiobox/b/`.                                                 |
| `--allow-write=/run/studiobox/b`                                              | Participate in the one-shot bridge handshake.                                                                                              |
| `--allow-read`/`--allow-write` on the journal dir                             | Read sandbox metadata for `list`/`attach`/`usage` (the authoritative journal is written by rootd; hostd reads its own lease/ticket state). |
| `--allow-env`                                                                 | Read the token and daemon configuration.                                                                                                   |

hostd gets `0660 root:studiobox` access to the supervisor socket via group
membership, not root. It has **no** `--allow-run` and cannot spawn a VMM or
mutate a jail/cgroup/netns — that authority lives only in rootd.

## `studiobox-rootd` — the root supervisor

The narrow, root-owned supervisor. It owns `@nullstyle/firecracker`
(`Machine.launch` with jailer, vsock dials, `reconcile()`), the durable journal,
artifact staging into jails, and TAP/netns/nftables/cgroup setup. Its capnp
surface (`supervisor.capnp`) carries **logical IDs only** — no paths, argv,
uids, or cgroup names cross that socket — and **root parses no public protocol**
(DESIGN.md §3, §8).

Because launching a jailed Firecracker microVM genuinely requires root
(`jailer`, `mknod` of device nodes, network namespace + TAP + nftables, cgroup
subtree creation), rootd runs with the honest `-A` posture. The confinement is
architectural, not flag-based:

| Capability rootd exercises       | Requires                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| Spawn `jailer` → Firecracker     | root; `--allow-run`                                                 |
| Create device nodes (`mknod`)    | root                                                                |
| netns / TAP / nftables / dnsmasq | root; `--allow-run` + net-admin                                     |
| cgroup-v2 subtree (cpu/mem/pids) | root; `--allow-write` under the cgroup fs                           |
| vsock dial (`vm.vsock.connect`)  | `--allow-read`/`--allow-write` on the jail UDS paths                |
| Durable journal (fsync + rename) | `--allow-read`/`--allow-write` on `~/.studiobox` state + jail roots |
| Listen on the supervisor UDS     | `--allow-read`/`--allow-write=/run/studiobox`                       |

Mitigations that make `-A` acceptable here (all from DESIGN.md §8 and the
firecracker contract):

- rootd is **local-UDS only** — it does not listen on any network socket and is
  unreachable from the sandbox TAP network.
- Its supervisor socket is `0660 root:studiobox` with strict pre-auth frame/call
  caps and **only bounded methods** (launch/status/probeAgent/openBridge/
  reconcile/kill/health).
- It accepts **logical IDs**, never arbitrary commands, argv, host paths, uids,
  or nftables fragments; it resolves those internally against the signed
  manifest and reserved resource plan.
- The workload never talks to rootd; the client never talks to rootd. Only hostd
  does, over the group-restricted socket.

## `studioboxd` — the in-guest agent

A single static `deno compile` binary (per arch) that overlay-init execs inside
the guest microVM. It listens on AF_VSOCK and serves the `SandboxAgent` plane
(process exec, fs, env, Deno eval) for exactly one sandbox.

- **Compiled with `-A --unstable-vsock`** (see `deno.json` `agent:compile`). The
  `--unstable-vsock` flag is **baked at compile time**: Deno 2.9 gates the vsock
  transport (`Deno.listen({ transport: "vsock", cid: 3, port: AGENT_PORT })`)
  behind it, and the setting is recorded in `compat/wire.json` (PLAN.md R6).
- Its broad permissions are **irrelevant to host safety**: it runs _inside_ the
  VM, and is confined by the kernel boundary (jailer chroot + uid/gid drop to
  1000 + cgroups), not by Deno flags. A hostile workload that compromises the
  guest userland is still bounded by the VM boundary and the egress policy
  (DESIGN.md §10).
- It drops to **uid 1000** (`sandbox` user) for the workloads it runs; it treats
  the host side of vsock as trusted and everything else in the guest as
  untrusted.

`--unstable-vsock` is the one non-obvious flag in the whole system; if the guest
agent fails to bind its listener, this is the first thing to check.

## `FakeSandboxHost` — the testing double (`./testing`)

`FakeSandboxHost` runs the agent core **in-process on your host, as the current
user** — there is no VM and no privilege boundary. See
[docs/testing-your-app.md](testing-your-app.md) for the full story and its
isolation warning. Its permission needs are the union of what the real agent
would need, but pointed at your host:

| Permission                       | Why                                                                  |
| -------------------------------- | -------------------------------------------------------------------- |
| `--allow-read` / `--allow-write` | The per-sandbox root is a host temp dir; fs calls hit the real disk. |
| `--allow-run`                    | `sh` / `spawn` / `deno.run` execute **real host processes**.         |
| `--allow-env`                    | Seed `PATH`/`HOME`; `env.*` reads/writes the agent env.              |
| `--allow-sys=uid,gid`            | `fs.chown` and status annotation query uid/gid.                      |

The repo's own `test:fake` / `test:parity` tasks use exactly this set
(`--allow-read --allow-write --allow-net --allow-run --allow-env
--allow-sys=uid,gid`).
Because the fake executes arbitrary host commands as you, **never point it at
untrusted code** — that is what the real microVM backend is for.

## Why the split matters

A single root daemon speaking the public protocol would save one process — at
the cost of **root parsing hostile-adjacent input**. Studiobox refuses that
trade (DESIGN.md §13 decision 1): hostd parses the public protocol with no root,
rootd holds root but parses only bounded logical IDs from a trusted local peer.
The permission matrix above is that decision made concrete.

## Related documents

- [docs/threat-model.md](threat-model.md) — the trust boundaries these
  permissions enforce.
- [docs/architecture.md](architecture.md) — how the three daemons connect.
- [docs/firecracker-contract.md](firecracker-contract.md) — the root-boundary
  contract with `@nullstyle/firecracker`.
- [DESIGN.md](../DESIGN.md) §3, §8, §10.
