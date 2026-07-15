# Architecture overview

A reader's entry point into how `@nullstyle/studiobox` fits together. This is a
**summary** — [DESIGN.md](../DESIGN.md) is the authoritative, detailed source
and each section below links to the relevant part of it.

## What it is

Studiobox is a Deno-native local substitute for `@deno/sandbox`: the same SDK
surface, but each sandbox is a **Firecracker microVM** on a machine you control
instead of a Deploy cloud isolate. On macOS the microVMs live inside one
long-lived Lima Linux VM; on Linux the Lima layer disappears and the daemons run
directly. Every sandbox gets a **kernel-backed isolation boundary** — a jailed
microVM, not a container.

Studiobox delegates all Firecracker mechanics to
[`jsr:@nullstyle/firecracker`](firecracker-contract.md) (supervised VMM/jailer,
typed API client, vsock as `Deno.Conn`, journal-before-spawn crash recovery) and
adds the layers that package deliberately omits: policy, authorization, durable
state, resource accounting, artifact staging, networking, and recovery.

## Topology — three processes, three trust levels

(DESIGN.md §3.) One Lima VM per host boots once and stays warm;
`Sandbox.create()` is a Firecracker launch inside it (p95 target ~2 s), **not**
a new Lima instance.

```
your Deno process        │ host (Lima VM on macOS / bare Linux)     │ microVM per sandbox
                         │                                          │
┌──────────────┐  TCP    │ ┌──────────────────┐                    │
│ client SDK   │ loopback│ │ studiobox-hostd  │  supervisor.capnp   │
│  (@nullstyle │─────────┼▶│ unprivileged     │  (root UDS)         │
│  /studiobox) │ +ticket │ │ auth·leases·      │        │            │
└──────┬───────┘  tunnel │ │ policy·tickets    │        ▼            │
       │                 │ └──────────────────┘ ┌──────────────┐ vsock ┌──────────────┐
       └─────────────────┼──────────────────────│ studiobox-rootd│─────▶│ studioboxd    │
                         │  ticketed tunnel      │ root·jailer·   │      │ guest agent   │
                         │  (SBXTUN1 preface)    │ journal·net    │      │ exec·fs·deno  │
                         │                       └──────────────┘      └──────────────┘
```

- **`studiobox-hostd`** (unprivileged) — the **only** process that speaks the
  public protocol. Owns auth, negotiation, leases, capacity accounting,
  network/egress policy, tunnel tickets, and the exposeHttp port range. Never
  touches root resources.
- **`studiobox-rootd`** (root) — the narrow supervisor. Owns
  `@nullstyle/firecracker` (`Machine.launch` with jailer, vsock dials,
  `reconcile()`), the durable journal, artifact staging, TAP/netns/nftables/
  cgroups, and one-shot bridges. Its capnp surface carries **logical IDs only**;
  root parses no public protocol.
- **`studioboxd`** (in-guest) — the agent. Process execution, filesystem, env,
  Deno eval, and streaming for exactly one sandbox. Trusts the host side of
  vsock; treats everything in the guest as untrusted.

The privilege split is deliberate (DESIGN.md §13 decision 1) — see
[docs/threat-model.md](threat-model.md) and
[docs/permissions.md](permissions.md).

## The three Cap'n Proto planes

(DESIGN.md §4.) All control traffic is typed capnp RPC via
[`@nullstyle/capnp`](../deno.json) (Level 1: bootstrap capabilities, promise
pipelining, embargoes). Five canonical schemas live under `schema/`:

| Schema                | Plane                                                                | Parties                          |
| --------------------- | -------------------------------------------------------------------- | -------------------------------- |
| `common.capnp`        | shared vocabulary (versions, identity, limits, errors)               | all                              |
| `host_control.capnp`  | **HostControl** — create/attach/list/capacity, leases, `HostSandbox` | client ↔ hostd                   |
| `sandbox_agent.capnp` | **SandboxAgent** — process/fs/env/deno/http                          | client ↔ studioboxd (end-to-end) |
| `supervisor.capnp`    | **Supervisor** — launch/status/probe/bridge/reconcile/kill           | hostd ↔ rootd                    |
| `streams.capnp`       | bounded bulk transfer (64 KiB chunks, SHA-256 commit)                | any                              |

Two properties matter most:

- **Fail-closed bootstrap gate** on every plane:
  `connected → negotiated → authenticated → closed`. Negotiation intersects
  protocol version, feature bits, `ContractIdentity` (schema/ABI/artifact/
  firecracker hashes), and transport limits. Mismatched peers fail negotiation
  rather than misbehave.
- **The agent plane is end-to-end**, not proxied. The client asks
  `HostSandbox.openTunnel()`; hostd issues a single-use ticket; the client dials
  the tunnel and sends the `SBXTUN1` preface; hostd burns the ticket **before**
  rootd opens the bridge and vsock-splices bytes verbatim. **One tunnel = one
  vsock stream = one `SandboxAgent` session**; hostd never interprets agent
  traffic.

Transports need no new adapters: capnp's `TcpTransport` accepts any `Deno.Conn`,
so host-side `VsockConn` and the guest's native AF_VSOCK conns both plug in
directly.

## Durable state and destroy-and-reconcile

(DESIGN.md §6.) There is **one authoritative durable record per sandbox**
(`SandboxRecord`), stored in a create-only, compare-and-swap journal (fsync +
atomic rename, revision-checked CAS). Phases:

```
allocating → staging → booting → ready → terminating → terminated
                                   └→ reconciling → terminated | quarantined
```

- **The Firecracker journal nests inside it.** `@nullstyle/firecracker` requires
  a `VmRegistry` when jailed; studiobox implements it as a CAS adapter that
  writes the `JailRecord` as a subrecord of the owning `SandboxRecord` — one
  store, one source of truth.
- **Execution IDs.** Every boot attempt gets a fresh `sbx-<uuidhex>` execution
  ID, distinct from the stable sandbox ID, so a stale attempt can never CAS over
  a newer one.
- **Restart is deliberately destructive.** Studiobox does **not** re-attach to
  running microVMs after an unexpected `rootd` restart. It runs
  `reconcile({ killLive: true })`, reclaims cgroups/overlays/TAP/netns/nftables/
  ports, revokes all leases and tickets, and lands affected records in
  `terminated(reason: "host-restart")`. Live adoption is not a 1.0 claim (the
  firecracker package has no adoption API by design).
- **Quarantine.** A record whose reclaim fails parks in `quarantined` with the
  failure detail rather than being silently dropped; `studiobox host doctor`
  lists them.

Resource admission is a **capacity ledger** (DESIGN.md §9): `create()` fits or
fails fast with `HostCapacityError` — no queueing.

## Artifacts and staging

(DESIGN.md §7.) A sandbox boots from a **versioned artifact set** keyed by
manifest hash:

- `vmlinux` — pinned Firecracker-CI kernel per arch, sha256-verified.
- **Golden rootfs** — an ext4 built by pinned `debootstrap` (against
  `snapshot.debian.org` for reproducibility): user `sandbox` (uid 1000, home
  `/home/app`), pinned Deno, the compiled `studioboxd`, `tini` (guest pid-1
  init/reaper), and an overlay-init.
- `manifest.json` — records versions + hashes of every input; the manifest hash
  is part of `ContractIdentity`, so a client/hostd/guest that disagree about
  artifacts fail negotiation.

**Staging is copy-only, never hardlink** (DESIGN.md §13 decision 6): hardlink
staging shares inodes, so an in-jail `chmod`/`chown` would mutate the golden
source. Each sandbox gets a read-only golden rootfs _copy_ plus a fresh sparse
overlay it formats on first boot. `studioboxd` itself is a `deno compile` binary
per arch with the capnp WASM embedded (`--include`).

## Package shape

(DESIGN.md §12.) Naming is consistent: `sbx-` id prefixes, `SBX_*` error codes,
`SBXTUN1`/`SBXACK1` tunnel magics, `/run/studiobox/`, `~/.studiobox/`, Lima VM
`studiobox-host-<arch>`.

```
"."         → SDK: Sandbox, Client, errors, KillController… (upstream-shaped)
"./testing" → FakeSandboxHost: in-process, no VM (any OS)
src/  api/ hostd/ rootd/ agent/ state/ wire/ security/ transports/
schema/     the five canonical *.capnp
images/     kernel fetch + rootfs build + manifest tooling
parity/     upstream inventory + member audit (the fidelity target)
```

> Doc ↔ code note: DESIGN.md §12 also names `./unstable-host` and `./cli`
> exports; the current `deno.json` exposes `.`, `./images`, and `./testing`, and
> re-exports the host/daemon seams from the root `mod.ts` for now. Treat DESIGN
> §12 as the target export map.

## Where to go next

- [PARITY.md](../PARITY.md) — what of `@deno/sandbox` works, diverges, or
  throws.
- [docs/threat-model.md](threat-model.md) — trust boundaries and the privilege
  split.
- [docs/permissions.md](permissions.md) — Deno permissions per component.
- [docs/testing-your-app.md](testing-your-app.md) — test your app with no VM.
- [docs/firecracker-contract.md](firecracker-contract.md) — the low-level VMM
  integration contract.
- [DESIGN.md](../DESIGN.md) / [PLAN.md](../PLAN.md) — full design and
  milestones.
