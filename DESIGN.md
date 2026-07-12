# @nullstyle/studiobox — Design

Status: founding design, 2026-07-10. Supersedes `@nullstyle/limabox` (rev-5
architecture, sibling repo `../limabox`, never committed). Studiobox adopts that
architecture, harvests its code, and renames everything; see PLAN.md for the
carry-forward map and milestones.

## 1. What studiobox is

`@nullstyle/studiobox` is a Deno-native local substitute for
[`@deno/sandbox`](https://jsr.io/@deno/sandbox): the same SDK surface, but
sandboxes run as Firecracker microVMs on machines you control instead of Deno
Deploy's cloud. On a macOS host, microVMs live inside one long-lived Lima Linux
VM; on a Linux host the Lima layer disappears and the daemons run directly. Each
sandbox gets a kernel-backed isolation boundary — a jailed Firecracker microVM —
rather than a container.

Swap the import and the core of your program keeps working:

```ts
// import { Sandbox } from "@deno/sandbox";
import { Sandbox } from "@nullstyle/studiobox";

await using sandbox = await Sandbox.create();
await sandbox.sh`echo hello from a local microVM`;
const three = await sandbox.deno.eval(`1 + 2`);
```

Studiobox delegates all Firecracker lifecycle mechanics to
`jsr:@nullstyle/firecracker` (supervised VMM/jailer processes, typed API client,
vsock as `Deno.Conn`, journal-before-spawn crash recovery) and adds the layers
that package deliberately does not prescribe: policy, authorization, durable
sandbox state, resource accounting, artifact staging, networking, and recovery.

### Non-goals

- **Node.js host support.** Deno-native only; `deno compile` for the daemons.
- **The Deploy PaaS surface.** `deploy`, apps, revisions, timelines, layers,
  builds throw `UnsupportedFeatureError` (Tier C, §5).
- **Multi-tenant hostile-client hardening.** The threat model is a single
  developer's workstation running untrusted _workloads_, not untrusted _clients_
  (§8).
- **Live adoption of running microVMs.** An unexpected supervisor restart
  destroys and reconciles; it never re-attaches (§6).

### Fitness target (the 1.0 bar)

Studiobox reaches 1.0 only when it can **repeatedly** create, use, terminate,
and reconcile real microVM sandboxes on **both supported Linux architectures**
(x86_64, aarch64) with **bounded resources and no leaks** — measured by the soak
drill in PLAN.md §M11, enforced in CI on both arches.

## 2. Foundations

| Dependency                        | Form              | Status                                                                                                                                                                                                                   |
| --------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jsr:@nullstyle/firecracker@^0.2` | JSR package       | Published; pinned Firecracker v1.16.1, min v1.15.0 (`FIRECRACKER_COMPAT`)                                                                                                                                                |
| `jsr:@nullstyle/capnp@^0.1`       | JSR package       | Published (0.1.0). RPC Level 1 (capabilities, promise pipelining, embargoes), pure-TS serde, WASM session core. **No vendored snapshots.** M1 qualifies it against the five-schema bundle before breadth work (PLAN §M1) |
| Lima ≥ 2.1                        | Host tool (macOS) | `vz` + `nestedVirtualization` (Apple Silicon M3+, macOS 15+)                                                                                                                                                             |
| Deno ≥ 2.9                        | Runtime floor     | Studiobox sets its own floor above firecracker-deno's ≥ 2.5 (modern vsock/serve surface, one less legacy matrix leg); in-guest Deno is pinned by the artifact manifest                                                   |

Dev-time coordination uses `deno.local.json` remapping both foundations to
sibling checkouts (`../firecracker-deno`, `../capnp-deno`), the same pattern
limabox used — but the committed import map pins the published JSR release.

## 3. Topology

```
macOS host                        │ Lima VM: studiobox-host-<arch>          │ microVM (per sandbox)
                                  │ (vz + nestedVirtualization)             │
┌──────────────────────┐  TCP     │ ┌───────────────────┐                   │
│ client SDK           │ loopback │ │ studiobox-hostd   │                   │
│ (@nullstyle/studiobox│──────────┼▶│ unprivileged      │                   │
│  in the user's Deno  │ forward  │ │ auth·leases·policy│                   │
│  process)            │          │ │ capacity·tickets  │                   │
└──────────┬───────────┘          │ └─────────┬─────────┘                   │
           │                      │           │ supervisor.capnp            │
           │  ticketed tunnel     │           │ (root-owned UDS)            │
           │  (SBXTUN1 preface)   │ ┌─────────▼─────────┐   vsock   ┌───────┴──────┐
           └──────────────────────┼▶│ studiobox-rootd   │──────────▶│ studioboxd   │
                                  │ │ root · jailer     │  (UDS ⇄   │ guest agent  │
                                  │ │ Machine · journal │  AF_VSOCK)│ exec·fs·deno │
                                  │ │ reconcile · bridge│           └──────────────┘
                                  │ └───────────────────┘
```

Three long-lived processes, three trust levels:

- **`studiobox-hostd`** (unprivileged): the only process that speaks the public
  protocol. Owns authentication, protocol negotiation, leases, capacity
  accounting, network/egress policy decisions, tunnel tickets, and the
  exposeHttp port range. Never touches root resources directly.
- **`studiobox-rootd`** (root): the narrow supervisor. Owns
  `@nullstyle/firecracker` (`Machine.launch` with jailer, vsock dials,
  `reconcile()`), the durable sandbox journal, artifact staging into jails,
  TAP/netns/nftables/cgroup setup, and one-shot local bridges. Its capnp surface
  (`supervisor.capnp`) carries **logical IDs only** — no paths, argv, uids, or
  cgroup names cross that socket. Root parses no public protocol.
- **`studioboxd`** (in-guest): the agent. Implements process execution,
  filesystem access, env, Deno evaluation, and streaming for exactly one
  sandbox. Treats the host side of vsock as trusted and everything running in
  the guest as untrusted.

Sandboxes are **not** Lima instances. One Lima VM per host boots once and stays
warm; `Sandbox.create()` is a Firecracker launch inside it, with a p95 target of
~2 s. On Linux hosts (including CI), hostd/rootd run directly on any KVM-capable
machine — the Lima layer is macOS convenience, not architecture.

## 4. RPC: three Cap'n Proto planes

All control traffic is typed capnp RPC via `@nullstyle/capnp` (Level 1:
bootstrap capabilities, promise pipelining, embargoes). The five canonical
schemas carry over from limabox (stable file IDs and ordinals; `lbx`/`LBX`
identifiers renamed):

| Schema                | Plane                                                                                                                                    | Parties                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `common.capnp`        | shared vocabulary: `ProtocolVersion`, `ContractIdentity`, `TransportLimits`, `ErrorCode`/`SbxError`, auth results                        | all                              |
| `host_control.capnp`  | **HostControl** — create/attach/list/capacity, leases, `HostSandbox` (metadata, openTunnel, exposeHttp, extendTimeout, usage, kill)      | client ↔ hostd                   |
| `sandbox_agent.capnp` | **SandboxAgent** — `ProcessSpawner`/`Process`, `FileSystem`/`RemoteFile`/`Upload`, `Environment`, `DenoRuntime`/`DenoRepl`, `HttpClient` | client ↔ studioboxd (end-to-end) |
| `supervisor.capnp`    | **Supervisor** — launch/status/probeAgent/openBridge/reconcile/kill/health                                                               | hostd ↔ rootd                    |
| `streams.capnp`       | bounded bulk transfer: `ByteSink`/`ByteReader`/`OutputSink`, 64 KiB chunks, sequence numbers, SHA-256 `TransferCommit`                   | any                              |

**Connection lifecycle** (every plane): fail-closed bootstrap gate —
`connected → negotiated → authenticated → closed`. Negotiation checks protocol
major version, feature bitmask intersection, `ContractIdentity` (schema bundle
hash, capnp runtime/WASM ABI, artifact manifest hash, firecracker package pin)
and intersects `TransportLimits`. Auth failures are rate-limited; compares are
constant-time.

**The agent plane is end-to-end**, not proxied method-by-method: the client asks
`HostSandbox.openTunnel()`, hostd issues a **single-use ticket** (32-byte,
SHA-256 verifier, 15 s TTL, burn-before-check), the client dials the tunnel port
and sends a 44-byte `SBXTUN1` preface; hostd burns the ticket **before** asking
rootd to `openBridge`, rootd dials `vm.vsock.connect(AGENT_PORT)` via
`@nullstyle/firecracker/vsock`, and from then on bytes are spliced verbatim. One
tunnel = one vsock stream = one capnp `SandboxAgent` session. hostd never
interprets agent-plane traffic.

**Transports need no new adapters.** capnp-deno's `TcpTransport` constructor
accepts any `Deno.Conn`; `VsockConn` (host side, structural `Deno.Conn`) and
Deno's native in-guest AF_VSOCK conns (`Deno.listen({ transport: "vsock" })`)
both plug in directly. Framing is capnp's own length-prefixed segments via
`CapnpFrameFramer`.

**Bulk data** (file bodies, stdio, uploads) uses generated `-> stream` calls
with explicit backpressure (`StreamSender`), bounded in-flight windows from
`TransportLimits`, and a final commit carrying total bytes + SHA-256. No
unbounded buffering anywhere on the path.

**Upstream gap (capnp 0.2.0):** the published runtime cannot deliver a
FRESHLY-exported capability in a method return — the WASM session core rejects a
return frame that references an export id it never emitted, so the call hangs.
Until upstream fixes the fresh-export return path, capability handout serves the
gated interface as a **facet of the bootstrap/root capability** (already in the
export table) rather than exporting a new pointer per call; the root dispatch
accepts both interface ids and routes by the call's interface id. Relevant to M7
(the `Supervisor`/agent capability handout splits back into its own capability
once the return path is fixed).

## 5. Public API: fidelity to @deno/sandbox

Fidelity target: **`jsr:@deno/sandbox@0.13.2`** (parity inventory: 129 root
symbols / 473 members, carried from limabox `parity/`). The public surface is
tiered; every non-Tier-A behavior gets a PARITY.md entry.

**Tier A — full fidelity** (the execution surface):

- `Sandbox.create/connect`, `id`, `closed`, `close()`, `kill()`,
  `[Symbol.asyncDispose]` — with upstream's exact semantics: `close()` drops the
  connection (a `"session"` sandbox then terminates; a duration sandbox keeps
  running), `kill()` is authoritative termination, dispose === close.
- `sh` template-tag builder: `bash -c` with `BASH_ENV=$HOME/.bashrc`,
  per-argument single-quote escaping, arrays expanded, objects rejected;
  chainable `noThrow/sudo/cwd/env/stdout/stderr/signal`; terminal
  `text()/json()/result()/spawn()`; thenable; throws `SandboxCommandError`
  (which extends `Error`, not the SDK base — upstream quirk) on nonzero exit;
  error messages omit command text.
- `spawn()`/`ChildProcess`: stdio defaults stdin `"null"`, stdout/stderr
  `"inherit"` (client-side piping of a piped stream — never closes the host's
  stdout); `output()` with lazy `stdoutText`; `KillController`/`KillSignal` with
  128+n abort exit codes (SIGTERM→143, SIGKILL→137, …).
- `fs.*`: the full Deno-mirroring set (`readFile` … `utime`, `open`/`FsFile`
  with `SeekMode`, `walk`/`expandGlob` streamed) plus `upload`/`download`
  (SDK-side recursion, relative symlinks preserved).
- `env.*` (`get/set/toObject/delete`), `SandboxOptions.env` applied post-create.
- `deno.eval<T>` / `deno.repl()` (`eval`, `call`, state across snippets) /
  `deno.run({ entrypoint | code, watch, scriptArgs })`; `DenoProcess.fetch`
  targets the in-runtime HTTP server, `httpReady` resolves on first
  `Deno.serve`/`createServer`.
- `Sandbox.fetch` routed through the sandbox's (policy-filtered) egress.
- The error taxonomy, `Memory` grammar (bare number = **bytes**; 768–4096 MiB
  clamp; default 1280 MiB), `timeout` grammar (`"session"` | `"30s"`/`"5m"`),
  `extendTimeout` (≤30 min per call, returns the actual new deadline), labels
  (≤5, 64 B/128 B caps).
- Sandbox IDs match upstream's grammar so `connect(id)` round-trips:
  `sbx_loc_<20 chars of [0-9a-hjkmnp-z]>` — `loc` occupies the region slot.

**Tier B — emulated, documented divergence:**

| Surface              | Local behavior                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exposeHttp({port})` | Returns `http://127.0.0.1:<forwarded>` from the host's reserved range — reachable locally, **not** a public HTTPS URL                                                                   |
| `allowNet`           | Enforced as per-sandbox nftables egress rules on the TAP device (hostnames resolved at rule-apply time; wildcard subdomains via dnsmasq ipset). Unset = unrestricted, matching upstream |
| `region`             | Accepted, recorded as metadata, otherwise ignored; `Region` type widened to admit `"loc"`                                                                                               |
| `timeout`            | Enforced by hostd's lease clock rather than a cloud control plane; same observable semantics                                                                                            |
| oom reporting        | exit code 137 + cgroup memory.events, collapsed to the same boolean                                                                                                                     |
| auth/env             | `STUDIOBOX_TOKEN` replaces `DENO_DEPLOY_TOKEN`; no org concept (`org` accepted and ignored)                                                                                             |

**Tier C — throws `UnsupportedFeatureError`:** `secrets` (on-the-wire injection
needs a TLS-terminating egress proxy — post-1.0 candidate), `exposeSsh`,
`exposeVscode`, `deploy`/`Client.apps|revisions|timelines|layers`,
`volumes`/`snapshots`/`root` (post-1.0: map onto Firecracker snapshots + overlay
images), `ssh`/`port` create options.

**Additive divergence** (the one allowed extension): a `studiobox` options field
on `SandboxOptions` for host selection and artifact-set override, plus the
`./unstable-host`, `./cli`, and `./testing` exports. Nothing else is added to
upstream-named types.

## 6. Durable state and recovery

One **authoritative durable record per sandbox** (`SandboxRecord`), stored in a
create-only, compare-and-swap journal (`JsonFileSandboxStore`: single writer,
in-process serialization, fsync + atomic rename, revision-checked CAS/remove,
`StateConflictError`/`StateCorruptError`). Phases:

```
allocating → staging → booting → ready → terminating → terminated
                                   │
                                   └→ reconciling → terminated | quarantined
```

- **The firecracker journal nests inside it.** `@nullstyle/firecracker` requires
  a `VmRegistry` when jailed; studiobox implements it as a create-only CAS
  adapter that writes the `JailRecord` as a subrecord of the owning
  `SandboxRecord`. One store, one source of truth, no double-bookkeeping.
- **Execution IDs.** Every boot attempt gets a fresh `sbx-<uuidhex>` execution
  ID, distinct from the stable sandbox ID. A stale attempt (crashed, superseded)
  can never CAS over a newer execution's state.
- **Journal-before-spawn** is inherited: the record commits before the jailer is
  spawned, and is removed only after full reclaim.
- **Restart policy is deliberately destructive.** When `studiobox-rootd` starts,
  it runs composed reconciliation before accepting any supervisor call: first
  the package's `reconcile({ killLive: true })` (kills orphan VMMs after
  `/proc/<pid>/cmdline` identity checks, reclaims jail roots), then the
  studiobox layer reclaims what the package doesn't know about — cgroup residue,
  overlay files, TAP devices, netns, nftables chains, port reservations — and
  revokes all leases and tickets. Affected records land in
  `terminated(reason: "host-restart")`. Live adoption is not a 1.0 claim: the
  firecracker package has no adoption API by design, and adopting a VMM whose
  supervisor died is exactly the unsafe path this policy exists to avoid.
  Graceful upgrades drain instead: stop accepting creates, wait or terminate,
  then restart.
- **Quarantine.** A record whose reclaim fails (e.g. a file that won't unlink)
  parks in `quarantined` with the failure detail rather than being silently
  dropped; `studiobox host doctor` lists them.

## 7. Artifacts and staging

A sandbox boots from a **versioned artifact set** keyed by manifest hash:

- `vmlinux` — pinned Firecracker-CI kernel build per arch, sha256-verified at
  fetch.
- **Golden rootfs** — an ext4 built by pinned `debootstrap` (against
  `snapshot.debian.org` for reproducibility): user `sandbox` (uid 1000, home
  `/home/app` to match upstream), pinned Deno, the compiled `studioboxd` binary,
  and a minimal overlay-init that mounts a writable overlay and execs the agent.
- `manifest.json` — records versions + hashes of every input (kernel, rootfs,
  studioboxd build, Deno version, schema bundle hash). The manifest hash is part
  of `ContractIdentity`, so a client, hostd, and guest that disagree about
  artifacts fail negotiation instead of misbehaving.

**Staging is copy-only, never hardlink.** Kernel and rootfs are _copied_ into
each jail chroot (`stage: { mode: "copy" }` in firecracker-deno terms): hardlink
staging shares inodes, so an in-jail chmod/chown would mutate the golden source.
Each sandbox gets the read-only golden rootfs copy plus a fresh sparse overlay
image sized to its disk budget (created unformatted; the in-guest overlay-init
formats it on first boot). Artifact builds run inside the Lima VM (root; no loop
mounts); the cache lives under `~/.studiobox/artifacts/<manifest-hash>/` with GC
keyed by reference counts in the journal.

`studioboxd` is a `deno compile` binary per arch with the capnp WASM embedded
(`--include`); proving that compiled artifact does RPC is an M1 gate, not an
assumption.

## 8. Security model

Threat model: the **sandbox workload is hostile** (arbitrary code, kernel
boundary contains it); the macOS host user is trusted; other same-user local
processes are semi-trusted — but because a tunnel is exec-as-a-service, the
control plane still fails closed.

- **AuthN:** bearer token minted at `host up`, delivered to the daemons and read
  by the SDK from `STUDIOBOX_TOKEN` / `~/.studiobox/token` — provisioned via
  `limactl` file copy, never over the forwarded port. Bootstrap gate +
  rate-limited auth failures + constant-time compares (carried implementations).
- **Transport security, staged:** early milestones run token-over-loopback (Lima
  forwards bind 127.0.0.1). Before 1.0 the control and tunnel listeners move to
  pinned TLS (cert generated in-VM, fingerprint retrieved via `limactl`, client
  pins it) — carried from the limabox design as an M11 hardening item rather
  than a day-one requirement. _(Default taken: staged rather than day-one TLS —
  flag if you disagree.)_
- **Privilege split:** rootd's UDS is `0660 root:studiobox` at
  `/run/studiobox/supervisor.sock`; bridge sockets live under
  `/run/studiobox/b/` (paths validated against the ~104-byte `sun_path` budget).
  Logical IDs only; rootd resolves them to paths/uids internally.
- **Guest hardening:** jailer chroot + uid/gid drop + cgroups (inherited
  contract from firecracker-deno, including its CVE-2026-1386 staging
  hardening); no shared mounts; vsock is the only host↔guest channel.
- **Tickets** bind tunnels to leases: single-use, TTL 15 s (dial budget 10 s <
  ticket expiry), revoked en masse on lease revocation and daemon restart.

## 9. Resource accounting

hostd keeps a **capacity ledger**; `create()` either fits or fails fast with
`HostCapacityError` (no queueing):

- Committed guest memory (sandbox `memory`, upstream grammar/clamp) vs. host
  budget (default: Lima VM memory minus daemon+headroom reserve).
- vCPUs (2 per sandbox, matching upstream's fixed shape) vs. host vCPUs.
- Overlay disk bytes vs. artifact-volume budget; per-sandbox overlay quota.
- Tunnel/expose ports from the reserved forward range.

Enforcement is layered: Firecracker machine config (vcpu/mem) → jailer cgroups
(cpu quota, `pids.max`, memory.max as backstop) → overlay size cap → per-sandbox
fd budgets in the daemons. `HostSandbox.usage()` reports actuals (cgroup stats,
overlay bytes, uptime) and `HostControl.capacity()` reports the ledger, so
callers can schedule instead of colliding.

Timeouts: hostd's lease clock enforces `"session"` (sandbox dies when the
creating connection closes) and duration deadlines (kill at `stop_at_ms`
regardless of connections), identical to upstream observable behavior.

## 10. The guest agent: studioboxd

A single static `deno compile` binary (per arch) that overlay-init execs as
pid-adjacent supervisor inside the guest:

- Listens on AF_VSOCK
  (`Deno.listen({ transport: "vsock", cid: 3, port:
  AGENT_PORT })`), serving
  `AgentBootstrap` → negotiate/authenticate → `SandboxAgent`. Deno 2.9 gates the
  vsock transport behind `--unstable-vsock` (verified at M1 on Linux; recorded
  in `compat/wire.json`) — studioboxd's launch flags and in-guest tests carry it
  until the API stabilizes.
- **Processes:** `Deno.Command` under uid 1000 with the requested stdio modes;
  stdout/stderr flow over `OutputSink` streams; kill maps `Signal` →
  `Deno.kill`; `status` reports code/signal and cgroup-OOM annotation.
- **FileSystem:** near-passthrough to in-guest `Deno.*` (the fidelity work lives
  here for free); `walk`/`expandGlob` implemented against `@std/fs` in-guest and
  streamed.
- **Deno runtime:** `run` = spawn `deno run` with pinned flags; `repl`/`eval` =
  a driver process wrapping `deno repl` (or a small eval-server) that preserves
  state across snippets and structured-clones results — the wire contract is
  `DenoRuntime`/`DenoRepl`, the in-guest mechanism is an implementation detail.
- **HttpClient:** performs `fetch` from inside the guest (subject to the
  sandbox's egress policy) and proxies `DenoProcess.fetch` to the runtime's
  local server port.
- Enforces the same `TransportLimits` bounds as the host daemons; a hostile
  workload that compromises the guest userland is still confined by the VM
  boundary and egress policy.

## 11. Host lifecycle (macOS)

`deno run -A jsr:@nullstyle/studiobox/cli host <up|down|status|doctor|provision>`:

- `host up`: create/start `studiobox-host-<arch>` from the committed Lima
  template (`vmType: vz`, `nestedVirtualization: true`, `mounts: []`, containerd
  disabled, static loopback `portForwards`: control 40000, tunnel 40001, expose
  range 40100–40199), provision pinned firecracker + jailer (from
  `FIRECRACKER_COMPAT`), nftables/dnsmasq, install both daemons as systemd
  units, build/verify artifacts, mint the token.
- `host doctor`: end-to-end health — negotiate, capacity, probe a canary
  sandbox, list quarantined records.
- Idempotent re-runs; `--recreate` rebuilds the VM (the firecracker-deno
  `smoke:lima` pattern, generalized).

On Linux, `host up --no-lima` provisions the local machine directly (CI uses
this; it is also the supported path for Linux workstations).

## 12. Package shape

```
deno.json      name @nullstyle/studiobox · JSR-only 0.x · Deno ≥ 2.9
exports:
  "."               → SDK: Sandbox, Client, errors, KillController… (upstream-shaped)
  "./unstable-host" → host/daemon programmatic surface (LimaDriver, provisioning)
  "./cli"           → studiobox CLI entrypoint
  "./testing"       → FakeSandboxHost: in-process SandboxAgent + provider,
                      no VM required — test your studiobox-consuming app on any OS
src/
  api/        SDK façade (sandbox, command, process, fs, deno, env, errors, types)
  hostd/      control daemon (gate, leases, capacity, tickets, tunnel authorizer)
  rootd/      root supervisor (firecracker adapter, registry, staging, net, bridge)
  agent/      studioboxd (guest)
  state/      SandboxRecord model + CAS journal store
  wire/       negotiation contract, bootstrap gate, generated capnp bindings
  security/   tickets, token handling
  transports/ tunnel preface codec, splice
schema/       *.capnp (canonical bundle, hash-pinned)
images/       kernel fetch + rootfs build + manifest tooling
parity/       upstream inventory + member audit (regenerable)
compat/       dependency/wire provenance pins (checked by tools/check_*)
tools/        drift/compat/publish gates, smoke drivers
tests/        unit / fake / vm / e2e / parity / soak
```

Naming: `sbx-` ID prefixes, `SBX_*` error codes, `SBXTUN1`/`SBXACK1` tunnel
magics, `/run/studiobox/`, `~/.studiobox/`, Lima VM `studiobox-host-<arch>`.

## 13. Decisions taken (defaults — flag if you disagree)

1. **Keep the two-daemon privilege split** (hostd/rootd). The alternative — a
   single root daemon speaking the public protocol — saves one process at the
   cost of root parsing hostile-adjacent input. The split is already designed,
   validated, and partially implemented in limabox.
2. **Keep the three-plane, end-to-end-agent capnp topology.** No HTTP/JSON
   control fallback; the ticketed-tunnel design already exists with tests.
3. **TLS is staged** (token-over-loopback until M11 hardening), not day-one.
4. **Tier C at 1.0** for secrets/ssh/vscode/volumes/snapshots/PaaS.
5. **Destructive reconcile** on supervisor restart (user-confirmed direction).
6. **Copy-only staging** into each jail (user-confirmed direction).
7. **`@nullstyle/capnp` is consumed as a real dependency, never a vendored
   snapshot** (user decision, 2026-07-11). It is published — `0.1.0` on JSR —
   and studiobox pins `jsr:@nullstyle/capnp@^0.1`, with a `deno.local.json`
   override to the `../capnp-deno` checkout for coordinated dev. Gaps found
   during M1 qualification are fixed upstream and consumed as patch releases;
   there is no vendoring escape hatch.
8. Names: `studiobox-hostd`, `studiobox-rootd`, `studioboxd` (guest, as
   specified), `studiobox-host-<arch>` (Lima VM).
