# The no-leak soak harness (`tools/soak`)

**Status:** host-safe harness delivered early (PLAN.md §M11); the real-microVM
drill (`soak:vm`) is deferred until it can run in `fc-smoke` without contending
for the VM.\
**Home:** `tools/soak/` (the harness) and `tests/soak/` (host-safe proof).

The soak drill is the fitness bar that **defines studiobox 1.0** (DESIGN.md §1):
studiobox is 1.0 only when it can _repeatedly_ create → use → terminate and
reconcile real microVM sandboxes on both Linux architectures **with bounded
resources and no leaks**. This document describes what the soak asserts, the
leak taxonomy, how to run the host-safe (`soak`) vs. the real (`soak:vm`) drill,
and how any milestone can self-check for leaks with `LeakAudit`.

## What the 1.0 soak asserts

The drill (PLAN.md §M11) runs in CI on both arches and asserts, **after every
phase**:

- **≥ 200** sequential + batched `create → use(sh/fs/eval) → terminate` cycles
  complete;
- `kill -9` of `studiobox-rootd` mid-fleet at random points, restart, and
  destructive reconcile — repeated **≥ 10×** — reaps every orphan;
- **zero** leaked resources of every class in the taxonomy below;
- daemon **RSS** and **journal-dir size** stay bounded (no unbounded growth);
- create-latency **p95** is within target on a warm cache.

Any violation fails **loud**, naming the exact leak class and the exact
resources that leaked.

## The leak taxonomy

`LeakAudit` checks ten independently-reportable classes. Each has an enumerator
scoped to a caller-supplied state-dir / jail-base / artifact-cache (never a
wildcard sweep of shared host state) and, in `tests/soak/`, a catch-test that
seeds a leak of that class and asserts the audit flags exactly it.

| Class              | Leak it catches                                          | Host-safe enumerator                    | In-guest enumerator                               |
| ------------------ | -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `process`          | orphan firecracker / jailer VMMs                         | `trackedProcessEnumerator` (pid ledger) | `procCmdlineOrphanEnumerator` (`/proc/*/cmdline`) |
| `tap`              | leaked TAP devices                                       | —                                       | `tapEnumerator` (`ip -j link show`)               |
| `netns`            | leaked network namespaces                                | —                                       | `netnsEnumerator` (`ip -j netns list`)            |
| `nftables`         | leaked egress chains (`sbx_eg_*`)                        | —                                       | `nftablesEnumerator` (`nft -j list tables`)       |
| `mount`            | leaked jail mounts                                       | —                                       | `mountEnumerator` (`/proc/mounts`)                |
| `overlay`          | leaked per-boot overlay ext4 files                       | `overlayFileEnumerator`                 | (same)                                            |
| `jailRoot`         | leaked jail root dirs                                    | `jailRootEnumerator`                    | (same)                                            |
| `portReservation`  | forward-range ports outliving their sandbox              | `portReservationEnumerator` (journal)   | `hostPortLedgerEnumerator`                        |
| `journalPhase`     | records left outside terminal phases (incl. quarantined) | `journalPhaseEnumerator`                | (same)                                            |
| `artifactRefcount` | artifact-cache refcounts stuck above zero                | `artifactRefcountEnumerator`            | (same)                                            |

The four Linux-only classes (`tap`/`netns`/`nftables`/`mount`) have no host-safe
enumerator, so the host-safe `soak` reports them as **bounded coverage** and
logs it once at start — a partial run is never mistaken for a clean one. The
in-guest `soak:vm` wires all ten (see `buildInGuestAudit`).

## How to run

### `deno task soak` — host-safe, runs anywhere

```
deno task soak
```

Drives `SoakRunner` against `FakeVmmSoakBackend`: a real `SupervisorCore`
lifecycle over the fake VMM / jailer shims from `@nullstyle/firecracker/testing`

- a temp journal, with periodic `kill -9`-mid-fleet (a doomed **child**
  supervisor is launched, `kill -9`d, and reconciled from a fresh core over the
  same journal — the real M5 restart drill) + budget enforcement. No VM, no
  root; runs in the CI batch and the dev loop on macOS or Linux.

Tunable via env: `SBX_SOAK_CYCLES` (default 200), `SBX_SOAK_CRASHES` (default
~12), `SBX_SOAK_BATCH` (default 2), `SBX_SOAK_SEED` (default 1).

This proves the **harness + assertions**: that the runner completes N cycles +
kill-9-reconcile, that `LeakAudit` catches a deliberately-injected leak of every
class, and that a clean run reports zero — without a real VM.

### `deno task soak:vm` — the real microVM drill (DEFERRED)

```
SBX_VM=1 SBX_VM_CACHE=… SBX_VM_MANIFEST_HASH=… SBX_VM_WORK=… deno task soak:vm
```

The real 1.0 drill boots ≥ 200 real jailed Firecracker microVMs and repeatedly
`kill -9`s rootd, so it must run **inside the `fc-smoke` Lima VM** (or a KVM CI
runner) — reusing the M5 `test:vm` provisioning and the same `SBX_VM_*`
environment contract (`tests/vm/support.ts`). It drives the same `SoakRunner`
against a real backend built on `SupervisorCore` + `GoldenArtifactLaunchPlanner`

- the M5 agent dialer, auditing with the full ten-class in-guest `LeakAudit`
  (`buildInGuestAudit`).

It is **deferred in this batch** to avoid contending for the shared `fc-smoke`
VM; `tools/soak/soak_vm_main.ts` refuses to launch VMs here and prints how to
turn it on. The exit criterion for 1.0 is `soak:vm` green on aarch64 + x86_64
across three consecutive scheduled runs.

## Self-checking any milestone for leaks

`LeakAudit` is reusable — any milestone can assert its own cleanliness by
pointing enumerators at its state-dir / jail-base / artifact-cache:

```ts
import {
  artifactRefcountEnumerator,
  jailRootEnumerator,
  journalPhaseEnumerator,
  LeakAudit,
  overlayFileEnumerator,
} from "../tools/soak/leak_audit.ts";

const audit = new LeakAudit([
  journalPhaseEnumerator(store),
  overlayFileEnumerator(overlayDir),
  jailRootEnumerator(chrootBaseDir),
  artifactRefcountEnumerator(cache, references),
]);

// After a teardown, assert nothing leaked (throws LeakDetectedError, naming
// the exact class + resources, if anything did):
await audit.assertClean({}, "after terminate");
```

The M5 in-VM tests (`tests/vm/`) already do single-cycle leak checks + a
kill-9-reconcile inline; this harness generalizes those into a repeatable drill.
New milestones should add their enumerators here (or wire the existing ones) so
the soak's coverage grows with the surface — an unenumerated class shows up as
`skipped` in the report, keeping the gap visible.

## Module map

| Module                            | Role                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `tools/soak/leak_audit.ts`        | `LeakAudit`, `LeakDetectedError`, the taxonomy, and the host-safe enumerator factories     |
| `tools/soak/enumerators_linux.ts` | the `ip` / `nft` / `/proc` enumerators for the in-guest classes (injected, parse-tested)   |
| `tools/soak/soak_runner.ts`       | `SoakRunner` + the `SoakBackend` seam + metrics (latency percentiles, RSS/journal budgets) |
| `tools/soak/fake_backend.ts`      | `FakeVmmSoakBackend` — the host-safe backend over fake VMM/jailer shims                    |
| `tools/soak/soak_main.ts`         | `deno task soak` entrypoint                                                                |
| `tools/soak/soak_vm_main.ts`      | `deno task soak:vm` entrypoint + `buildInGuestAudit` (deferred)                            |
| `tests/soak/`                     | host-safe proof: per-class catch-tests, real-enumerator tests, runner + budget tests       |
