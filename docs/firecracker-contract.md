# `@nullstyle/firecracker` integration contract

**Status:** consumed as `jsr:@nullstyle/firecracker@^0.2` (published)\
**Audited:** 2026-07-10 (limabox baseline at commit
`73ed377ea28285bec1145c39ab69c31c7b458d97`); re-pinned to the published `0.2.0`
on 2026-07-11\
**Package baseline:** `jsr:@nullstyle/firecracker@0.2.0` (pinned Firecracker
`v1.16.1`, minimum `v1.15.0`)\
**Local development override:** `deno.local.json` maps the bare specifiers to
the sibling checkout `../firecracker-deno`

## Decision

Studiobox will consume `@nullstyle/firecracker` as its only normal low-level VMM
implementation. Studiobox will not build a second Firecracker HTTP client,
process supervisor, jailer argument builder, lifecycle state machine, host-side
vsock `CONNECT`/`OK` parser, or basic jail/socket cleanup engine.

The package is published as `jsr:@nullstyle/firecracker@0.2.0` from an audited
tag, which closes the former publication gap (G1). Studiobox consumes it through
the JSR range pin `^0.2` recorded in `compat/dependencies.json` and the
`deno.json` import map; the lockfile records the exact resolved version, and
`tools/check_compat.ts` verifies that the resolution stays inside the qualified
window. Coordinated development against the sibling checkout goes through the
`deno.local.json` override, never through raw git or vendored specifiers.

This contract corrects several assumptions in the package handoff after direct
source inspection. Studiobox must force copied jail staging, retain
crash-recovery ownership of cgroups, track outbound vsock connections itself,
and place an external bound around shutdown. The published package races vsock
dials against VM exit, exports process test doubles and journal metadata, and
contains an upstream compile smoke; those former gaps are verified rather than
reimplemented.

## Package contract

| Import                           | Studiobox use                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `@nullstyle/firecracker`         | `Machine`, `VmRegistry`, `reconcile`, errors, `FIRECRACKER_COMPAT`, and API types |
| `@nullstyle/firecracker/client`  | Reviewed `FirecrackerClient` escape hatch and injectable `ApiTransport` tests     |
| `@nullstyle/firecracker/vsock`   | `VsockConn` types; normal dialing remains `vm.vsock.connect()`                    |
| `@nullstyle/firecracker/jailer`  | Path validation and staging-plan helpers used by preflight/doctor                 |
| `@nullstyle/firecracker/types`   | Wire-verbatim Firecracker v1.16.1 schema types                                    |
| `@nullstyle/firecracker/testing` | Public `FakeFirecracker` plus spawnable VMM/jailer process doubles                |

Runtime contract:

- Deno 2.9 is the floor; development uses 2.9.1. The earlier vendored Cap'n
  Proto lockfile constraint is gone now that both foundations are published
  packages. The API client uses native
  `Deno.createHttpClient({ proxy: { transport: "unix" } })`.
- Linux `x86_64` and `aarch64`; macOS is suitable only for fake-backed tests.
- Firecracker and `jailer` must come from the same release.
- Read `FIRECRACKER_COMPAT` at build/setup time. For the pinned package it is
  `{ pinned: "v1.16.1", min: "v1.15.0" }`; do not duplicate those values as
  independent Studiobox constants. The package does not enforce this window at
  runtime, so setup verifies both binaries and 1.0 prefers the exact pinned
  release; use of the minimum version needs its own compatibility run.
- The package's only published runtime dependency is `@std/path`; the combined
  Studiobox runtime remains npm-free and uses no Deno FFI.
- Published runtime modules have no dynamic imports or runtime data-file loads.
  The package compile smoke and Studiobox adapter cross-compilation pass; actual
  execution of both Linux outputs remains a real-host qualification gate.
- Jailed launch requires root. The privileged process uses the honest `-A`
  posture inside the mount-free Lima host VM; it is not exposed directly to the
  physical host or sandbox network.

The compatibility manifest records the Studiobox package/protocol versions, the
`@nullstyle/firecracker` qualified version and JSR range pin,
`FIRECRACKER_COMPAT.pinned` and `.min`, actual Firecracker and jailer versions,
Deno version, architecture, and the existing Cap'n Proto/schema/WASM/artifact
hashes.

## Process boundary

For 1.0 the root-only package calls live in a narrow supervisor rather than the
network-facing control daemon:

```text
client
  | pinned TLS: HostControl + ticket tunnel
  v
studiobox-hostd (unprivileged `studiobox` user)
  - Cap'n Proto control, leases, tickets, policy, error mapping
  - validates and burns tunnel ticket before privileged work
  - splices client TLS stream to a one-shot local bridge
  |
  | bounded authenticated local supervisor RPC / one-shot bridge
  v
studiobox-rootd (root, local UDS only)
  - resource-plan activation and durable VmRegistry adapter
  - @nullstyle/firecracker Machine lifecycle and reconcile
  - vm.vsock.connect() and opaque bridge to studiobox-hostd
  v
jailer -> Firecracker -> guest vsock -> studioboxd
```

`studiobox-rootd` never parses public HostControl requests, the external tunnel
preface, or SandboxAgent Cap'n Proto frames. `studiobox-hostd` never spawns a
VMM or mutates a jail/cgroup/netns directly. Because Deno has no supported
SCM_RIGHTS-based `Deno.Conn` transfer for this design, the supervisor exposes a
random, single-use local Unix-socket bridge for each authorized tunnel. This
adds a bounded byte-copy hop but no Cap'n Proto translation or re-encoding. The
bridge socket and supervisor control socket are root-owned, group-restricted,
short-lived where applicable, and unreachable from guest TAP networks.

M0 must prove this split. If it is not viable, the plan must explicitly accept
and independently review a root `studiobox-hostd`; merely calling an all-in-one
process "privilege-separated" is not acceptable.

The selected local control surface is `schema/supervisor.capnp` over
`/run/studiobox/supervisor.sock` (`0660`, `root:studiobox`) with a boot-scoped
32-byte credential stored `0640` in the same tmpfs. It has strict pre-auth frame
and call caps and only bounded methods for launch, status/usage, agent probe,
open bridge, shutdown/kill, reconcile, and health. It accepts logical artifact
and allocation IDs—not arbitrary commands, argv, host paths, UIDs, cgroup names,
or nftables fragments; studiobox-rootd resolves and validates those against the
signed manifest and reserved resource plan. No bulk guest payload travels
through supervisor RPC.

An authorized `openBridge` returns a short path under `/run/studiobox/b/`, a
random single-use bridge credential, and the HMAC-backed agent credential. The
socket accepts exactly one authenticated studiobox-hostd connection before its
short deadline, then is unlinked. Supervisor frames, resource plans, bridge
tokens, path resolution, and cross-sandbox substitution are fuzzed as
root-boundary inputs.

## Responsibility split

| `@nullstyle/firecracker` owns                                 | Studiobox owns                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Typed Firecracker API and wire types                          | Lima provisioning and nested-virt qualification                           |
| Firecracker/jailer spawn and observation                      | Authoritative sandbox, lease, ticket, and idempotency state               |
| Jailer argv/path validation and chroot staging mechanics      | Artifact construction and safe staging policy                             |
| Machine state, readiness, exit observation                    | Admission, UID/GID, overlay, TAP/netns, port, and credential allocation   |
| Shutdown/kill/disposal mechanics                              | External operation deadlines and public lifecycle semantics               |
| Host-side vsock handshake and `VsockConn`                     | Ticket authorization, local bridge, Cap'n Proto, and agent authentication |
| Identity-checked low-level process/jail/socket reconciliation | Network policy and remaining resource/overlay/cgroup reconciliation       |
| Stable `FC_*` error types                                     | Public SDK error mapping, redaction, telemetry, and retry policy          |

`vm.client` is a reviewed escape hatch for a missing façade operation, not the
normal integration surface. It exposes the 38 operations in the pinned v1.16.1
surface. Any use gets a focused test and a compatibility-manifest review.

## One authoritative journal

Studiobox does not run `DirRegistry` beside its own state. It implements
`VmRegistry` as an adapter over the authoritative durable sandbox record:

- `put()` is an atomic create-only transaction that adds the package
  `JailRecord` before spawn;
- `update()` records the PID and package-owned path changes;
- `remove()` clears only the low-level subrecord after confirmed death and full
  package reclaim; and
- `list()` exposes all remaining low-level subrecords to `reconcile()`.

The surrounding record retains Studiobox-owned state including lease generation,
deadline, UID/GID, overlay path, TAP/netns, cgroup path, nftables rules, exposed
ports, tickets, and artifact identity. The package's `JailRecord` carries
optional package-level `metadata` (as of `0.2.0`) but no cgroup path, and its
crash `reconcile()` does not remove cgroups; Studiobox cleanup therefore runs
after package reconciliation and clears the remaining resources before marking
the sandbox fully reclaimed.

The package's stable `sandboxId` and the jailer's execution ID are different.
Every boot attempt gets a new short execution ID; this prevents a failed or
stale attempt from overwriting the prior journal or colliding with a fresh-jail
check. The durable sandbox record maps the current execution ID back to the
public sandbox ID.

A pre-existing jail root is never adopted or overwritten. Idempotent retry must
first resolve the existing record and either return the completed result or
reconcile the stale attempt before reusing an ID.

Current package staging occurs after the registry `put()` but outside its spawn
cleanup block. A staging error can therefore leave a record. Every
`Machine.launch()` rejection triggers adapter inspection plus reconciliation;
admission for that execution/sandbox remains blocked while
`reconcile().failures` is nonempty. A package fix is required before Studiobox
relies on the stronger "all failed creates clean themselves" claim.

The package has no live `Machine` adoption API. The 1.0 policy is therefore
explicit: after an unexpected `studiobox-rootd` restart, run
`reconcile(registry, { killLive: true })`, revoke affected leases/tickets, mark
the sandboxes terminated with a stable host-restart reason, and finish Studiobox
resource cleanup. Graceful upgrades drain live machines first. Preserving live
VMs across supervisor restart requires a future upstream adoption API and is not
claimed by 1.0.

## Machine launch mapping

The supervisor's normal boot path is `Machine.launch()`; use `Machine.create()`
plus `start()` only when a pre-boot step cannot be expressed in `config`.

```ts
const vm = await Machine.launch({
  jailer: {
    jailerBin,
    firecrackerBin,
    id: executionId,
    uid,
    gid,
    chrootBaseDir: "/srv/jailer",
    newPidNs: true,
    cgroupVersion: 2,
    parentCgroup: "studiobox",
    cgroups: resourcePlan.cgroups,
    resourceLimits: resourcePlan.rlimits,
    netnsPath,
    stage: [
      { hostPath: kernel, jailPath: "/vmlinux", mode: "copy" },
      { hostPath: goldenRootfs, jailPath: "/rootfs.ext4", mode: "copy" },
      {
        hostPath: overlay,
        jailPath: "/overlay.ext4",
        mode: "copy",
        readWrite: true,
      },
    ],
  },
  config: {
    machine_config: { vcpu_count: vcpus, mem_size_mib: memMib },
    boot_source: { kernel_image_path: "/vmlinux", boot_args },
    drives,
    network_interfaces,
    vsock: { guest_cid: 3, uds_path: "/v.sock" },
    logger,
    metrics,
  },
  registry,
  readinessTimeoutMs: 5_000,
  signal: launchSignal,
});
```

Config keys deliberately preserve Firecracker's snake_case wire names and all
jailed paths are in-jail paths. Studiobox stages the kernel, golden filesystem,
and per-sandbox writable disk explicitly.

The audited staging implementation defaults to a hardlink and then applies
`chmod`/`chown` to the destination inode. That can mutate a shared source inode;
a read-write hardlink also writes the source. Studiobox therefore sets
`mode: "copy"` for every staged artifact until an upstream release provides and
tests non-mutating hardlink/reflink behavior. `doctor` reports the resulting
copy cost; an optimized staging strategy is a performance improvement, not a
correctness shortcut.

## Tunnel and vsock mapping

The external ticket sequence remains Studiobox-owned:

1. `studiobox-hostd` parses the fixed bounded tunnel preface.
2. It validates and atomically burns the ticket before requesting any VM work.
3. `studiobox-rootd` verifies the sandbox/lease/tunnel generation through its
   narrow local request and reserves a one-shot local bridge.
4. It calls:

   ```ts
   const conn = await vm.vsock.connect(agentPort, {
     retryTimeoutMs: 10_000,
     retryIntervalMs: 100,
     handshakeTimeoutMs: 1_000,
     signal: combineSignals(requestSignal, leaseSignal),
   });
   ```

5. The supervisor tracks the returned outbound `VsockConn`—`Machine` tracks
   listeners, not outbound dials—and bridges it to the one authorized local
   studiobox-hostd connection.
6. `studiobox-hostd` acknowledges external tunnel success and splices the local
   bridge to the client TLS connection. The client and `studioboxd` then
   bootstrap their independent end-to-end Cap'n Proto session.

The package reads the `OK <host-port>\n` acknowledgement one byte at a time with
a 64-byte ceiling, so it never consumes pipelined guest payload. Studiobox has
no second Firecracker acknowledgement parser. `VsockConn.read() === null` is
normal Deno EOF and must close the bridge, abort the SandboxAgent connection,
and reject all pending RPC waiters. Kill, lease replacement, tunnel replacement,
VM exit, and supervisor shutdown close every tracked outbound connection.

At the current pin `vm.vsock.connect()` internally combines the caller signal
with a machine-lifetime abort fired by `vm.exited`, so death rejects a dial
promptly. Ticket validation still precedes the dial so unauthenticated clients
cannot spend VM/vsock resources. The total dial budget stays below the 15-second
external ticket lifetime.

## Lifecycle and deadlines

- `vm.state` and `vm.waitFor()` provide local observation; Studiobox's durable
  state remains authoritative for the public lifecycle.
- `vm.exited` resolves exactly once and never rejects. It is wired into every
  launch, dial, bridge, and operation abort scope.
- `vm.shutdown()` escalates from guest Ctrl-Alt-Del to signals and is
  idempotent; concurrent calls share one promise.
- `vm.kill()` requests immediate SIGKILL; `vm[Symbol.asyncDispose]()` confirms
  death and performs normal package cleanup before the registry subrecord can
  disappear.
- A failed/aborted launch must be followed through disposal/reconciliation
  before Studiobox clears its intent or owned-resource record.

The advertised 10/5/2-second shutdown stages are not currently a strict
17-second wall bound: the first API request has its own default timeout, and
`Machine` does not expose that client timeout; `kill()` also lacks a caller
deadline. Studiobox wraps shutdown in an outer deadline, records an incomplete
cleanup rather than pretending success, and invokes reconciliation. A
publishable 1.0 requires upstream deadline plumbing or a proven bounded wrapper
that handles unkillable processes without deleting live resources.

The `signal` supplied to `Machine.launch()` covers initial readiness/pidfile
work but does not currently flow through every configuration and start request.
Studiobox maintains an outer create deadline, disposes on expiry, and treats
full cancellation propagation as a dependency qualification gate.

## Error mapping

| Dependency code | Studiobox internal/public treatment                                                  |
| --------------- | ------------------------------------------------------------------------------------ |
| `FC_API`        | Configuration or VMM API failure; retain bounded status/fault/method/path internally |
| `FC_TRANSPORT`  | API socket or aborted HTTP request; classify with VM state before mapping            |
| `FC_VMM_EXITED` | Immediate machine death with bounded stderr tail                                     |
| `FC_TIMEOUT`    | Readiness failure, distinct from a dead VMM                                          |
| `FC_SHUTDOWN`   | Host-level shutdown failure; quarantine/reconcile resources                          |
| `FC_VSOCK_DIAL` | Agent connection failure with stable bounded reason/attempt count                    |
| `FC_JAILER`     | Invalid or unsafe jail/staging configuration                                         |
| `FC_STATE`      | Studiobox/package lifecycle programming error or stale request                       |
| `FC_CLEANUP`    | Never hide; retain failures/leaked paths for GC and operator diagnostics             |

Dependency errors never leak directly as the public SDK contract. Error details
are bounded/redacted and correlated with the Studiobox operation and sandbox
IDs. Not every dependency failure is a `FirecrackerError`:
filesystem/spawn/registry paths, validation, listener setup, and caller abort
reasons can be native or arbitrary errors. The supervisor has a final
unknown-error normalization boundary; API abort/timeout currently appears as
`FC_TRANSPORT` and is reclassified using the operation deadline and VM state.

## Jailer, path, and resource constraints

- Sandbox IDs passed to the jailer are 1–64 ASCII alphanumeric/hyphen. The
  existing `sbx-<ulid>` form qualifies.
- Use a short base such as `/srv/jailer`. Every host-view API/vsock/listener
  Unix path must stay below the platform `sun_path` budget (approximately 104
  bytes). Setup, `doctor`, and create preflight compute the exact worst case and
  reject before launch. Guest-initiated listeners are not used in 1.0; any
  future use must budget the longer `${uds}_${port}` suffix because the package
  listener does not preflight it.
- The `jailer` executable and Firecracker binary come from the same compatible
  release; the `--exec-file` basename contains `firecracker`.
- Every VM gets a unique UID/GID, cgroup-v2 subtree, jail root, netns, TAP,
  overlay, log/metrics endpoints, and owned resource record.
- Jailer cgroup values are pass-through mechanics. Studiobox computes admission
  and policy values and independently records the cgroup path because crash
  `reconcile()` does not remove it.
- Reparented/new-PID-namespace exit observation uses pidfile polling and cannot
  report an exit code. The supervisor is long-lived; every short-lived CLI talks
  to it rather than directly owning reparented machines.

## Test integration

Unit and protocol tests use the public `FakeFirecracker` for real Unix-socket
API traffic, boot-phase rules, request recording, `failNext()` injection,
host-initiated vsock handlers, guest connections, and chroot path emulation.
Pure client tests may inject `ApiTransport`.

Process-level VMM/jailer shims are exported from the pinned
`@nullstyle/firecracker/testing` source alongside `FakeFirecracker`. Binary-path
injection remains the supported spawn seam; Studiobox does not keep forked
copies or create a second production spawner abstraction.

`firecracker:contract` runs the same selected lifecycle/vsock/error scenarios
against `FakeFirecracker` and real Firecracker. `it:bare` runs real KVM on
`x86_64`; the full Lima tier provides sustained `aarch64` coverage. Both
architectures run a compiled-supervisor smoke test before 1.0.

Required cases include:

- journal-before-spawn and removal only after confirmed death/full reclaim;
- failed/aborted launch leaves no process, jail, socket, staged copy, or record;
- staging failure after journal creation is reconciled and blocks conflicting
  admission until cleanup succeeds;
- stale jail roots fail closed and are recovered before ID reuse;
- VM exit promptly aborts a vsock dial and every active bridge;
- vsock EOF rejects all Cap'n Proto waiters;
- ticket-before-dial ordering and bridge-token replay resistance;
- concurrent shutdown shares one result; kill/dispose/reconcile are idempotent;
- every `FC_*` error maps predictably with bounded/redacted details;
- socket-path overflow fails before spawn;
- copied staging cannot mutate the artifact cache;
- crash reconciliation clears Studiobox-owned cgroups, overlays, TAP/netns,
  firewall rules, ports, and credentials after package reclaim;
- fake/real contract symmetry for boot-phase, fault, vsock, and cleanup
  behavior;
- `deno compile` and execution on Linux `x86_64` and `aarch64`; and
- 100 create/destroy cycles plus the full hostile soak leave zero resources.

### Carried implementation evidence (limabox M0, 2026-07-10)

- The audited baseline was the immutable remote commit `73ed377…`; Studiobox now
  consumes the published `jsr:@nullstyle/firecracker@^0.2` (qualified `0.2.0`)
  built from that line, and the compatibility manifest checks the package
  identity and `{ pinned: "v1.16.1", min: "v1.15.0" }` window.
- `src/rootd/firecracker` provides a narrow injected runtime adapter, copy-only
  staging, unique jailer-safe execution IDs, stable/redacted error mapping,
  tracked outbound connections, a shutdown wall bound, scoped failed launch
  reconciliation, and destructive restart reconciliation.
- `SandboxStateJailRecordStore` implements create-only `VmRegistry` semantics
  inside the one authoritative durable record. CAS retries stop when a
  replacement execution owns the sandbox, and package removal preserves the
  surrounding resource journal for composed cleanup.
- Fifteen host-safe adapter/registry/error tests pass against the audited
  baseline. Three process-contract tests additionally launch the package's fake
  VMM through the real adapter: copied 0400 staging preserves the source
  inode/mode, jailed vsock echo works, open outbound connections are reclaimed,
  exit-before-bind is normalized and cleaned up, and destructive restart
  reconciliation kills and removes a live execution.
- A native compiled adapter smoke runs, and Deno 2.9.1 cross-compiles the same
  entrypoint for Linux `x86_64` and `aarch64`.
- Still open: re-qualification of the carried suites against the published
  `0.2.0`, real KVM lifecycle/contract symmetry, failure-transition cgroup
  cleanup, execution of both cross-built binaries on their Linux architectures,
  strict end-to-end cancellation bounds, and safe staging performance.

## Dependency gaps and disposition

| Gap                                                           | Disposition                                                                  | 1.0 gate                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| G1: package not on JSR                                        | **Closed:** published `0.2.0`, consumed as `jsr:@nullstyle/firecracker@^0.2` | Lockfile resolution stays inside the qualified window |
| G2: vsock dial did not race VM exit                           | Closed at `6b6819c`; adapter contract test                                   | Keep regression coverage on every pin                 |
| G3: process shims were not exported                           | Closed at `b7de13b` under `./testing`                                        | Keep export and compiled-source coverage              |
| G4: `JailRecord` lacked metadata                              | Closed in `0.2.0`; durable adapter still owns policy state                   | Keep substitution and stale-execution tests           |
| G5: no injected spawner interface                             | Use binary-path injection                                                    | Accepted unless tests demonstrate a real blocker      |
| G6: compiled operation was unverified                         | Package smoke plus Studiobox native and both-target cross-compile            | Execute both outputs in Linux CI                      |
| G7: reparented poller keeps event loop live                   | Only long-lived supervisor owns machines                                     | Every CLI disposes or delegates; accepted             |
| G8: hardlink staging mutates shared source inode              | Force `mode: "copy"`                                                         | Safe staging proven; optimization may remain deferred |
| G9: crash reconcile omits cgroups                             | Studiobox records and reclaims them after package reconcile                  | Transition fault tests prove zero cgroup leaks        |
| G10: launch/shutdown cancellation lacks one strict wall bound | Outer abort/deadline + dispose/reconcile                                     | Upstream plumbing or proven bounded wrapper           |
| G11: no live machine adoption                                 | Kill and reconcile on unexpected supervisor restart                          | Destructive restart behavior tested and documented    |
| G12: staging failure can leave a journal record               | Unique execution IDs, create-only adapter, mandatory reconcile               | Upstream cleanup fix plus fault-injection proof       |
| G13: compatibility window is not runtime-enforced             | Setup/doctor verify exact binaries                                           | Pinned/same-release binaries and skew tests           |

## Acceptance gates

1. **Publication:** satisfied by the published `0.2.0` (audited tag, license,
   OIDC release); retained evidence: checksum, SBOM, and provenance. The
   lockfile resolution must stay inside the `^0.2` qualified window.
2. **Compatibility:** installed Firecracker/jailer satisfy the programmatic
   compatibility window, match each other, and are verified before admission;
   upgrade/skew tests pass.
3. **Privilege:** the local supervisor/bridge split is proven, its sockets and
   credentials are least-privilege, and root parses no public protocol.
4. **Lifecycle:** create, exit, shutdown, kill, dispose, restart, and reconcile
   converge under transition-by-transition fault injection with zero leaks.
5. **Transport:** ticket-before-dial, VM-exit abort, byte-exact handshake,
   bridge teardown, half-close, EOF, and backpressure pass against fake and real
   VMMs.
6. **Build:** compiled supervisor and `studiobox-hostd` run on both Linux
   architectures.
7. **Security:** IDs, paths, staging, cgroups, process identity, and cleanup
   pass hostile-input tests and independent review.

## Requirements changed from the original plan

| Previous plan                                        | Integrated plan                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Custom Firecracker client/runner/jailer code         | Range-pinned `@nullstyle/firecracker` adapter                                 |
| `FakeFcRunner` and custom handshake fakes            | Public `FakeFirecracker`, `ApiTransport`, and fake/real contract suite        |
| `hostd` manually parses `CONNECT`/`OK`               | Root supervisor calls `vm.vsock.connect()` after ticket authorization         |
| Separate host metadata and low-level cleanup notions | One durable record with a `VmRegistry` subrecord and composed reconciliation  |
| Implicit all-in-one root daemon                      | Unprivileged public daemon plus narrow root supervisor/local bridge           |
| Hardcoded Firecracker release assumptions            | Programmatic `FIRECRACKER_COMPAT` plus actual binary manifest values          |
| Shared hardlink staging as an optimization           | Forced copied staging until non-mutating behavior is proven                   |
| Daemon restart recovery left ambiguous               | Supervisor restart kills/reconciles VMs and reports deterministic termination |

`PLAN.md` remains the product/milestone source of truth. This document is the
normative dependency and low-level lifecycle contract.

---

Provenance: transformed from limabox's `FIRECRACKER_INTEGRATION.md` (audited
2026-07-10). Limabox's `CAPNP_DENO_INTEGRATION.md`, `PLAN.md`,
`PRODUCTION_READINESS_REVIEW.md`, and `README.md` were deliberately not carried;
they are superseded by Studiobox's `DESIGN.md` and `PLAN.md`.
