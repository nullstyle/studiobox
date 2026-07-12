# @nullstyle/studiobox — Development Plan

Companion to DESIGN.md. Status: 2026-07-10, pre-M0. The repo is currently
design-only; M0 turns it into the committed foundation the design describes.

Guiding rule (inherited from the limabox plan and its production-readiness
review, and it bit us before): **do not start breadth work while a gate that
could force a redesign is open.** The gates are M1; everything wider waits.

## 1. Starting position

- `../limabox` holds an uncommitted M0 foundation: ~60 green host-safe tests, 3
  fake-VMM process-contract tests, five canonical capnp schemas, a
  129-symbol/473-member upstream parity audit, and four design docs (rev 5). It
  is the _source quarry_ for studiobox — harvested, renamed, then left archival.
  Nothing further lands there.
- `jsr:@nullstyle/firecracker@0.2.0` is published and CI-green on both arches
  (its 13 integration gaps G1–G13 all have dispositions; the ones studiobox
  depends on — copy staging, no-adoption, journal-before-spawn, registry
  required when jailed — are library contracts now).
- `@nullstyle/capnp@0.1.0` is **published to JSR** (Level-1 RPC, interop-tested
  serde). The two blockers limabox hit were fixed upstream before release —
  `fix(codegen): use declaring interface ids and merge
  generated barrels` (the
  cross-file-import/barrel-collision class) and
  `fix(streaming): make sender drains re-entrancy safe and window-atomic` (the
  `maxInFlight` race) — but neither has been exercised against _our_ five-schema
  bundle yet; M1 qualifies exactly that before breadth work. Studiobox pins
  `jsr:@nullstyle/capnp@^0.1`. **No vendored snapshots** (user decision,
  2026-07-11): limabox's `vendor/capnp-deno` does not carry over.
- Upstream fidelity target `@deno/sandbox@0.13.2` is fully digested (API + wire
  semantics); the parity inventory transfers.

## 2. Carry-forward map (limabox → studiobox)

Mechanical rename throughout: `limabox→studiobox`, `lbx→sbx`, `LBX→SBX`,
`fchostd→studiobox-hostd`, `fclauncherd→studiobox-rootd`, `sandboxd→studioboxd`,
`/run/limabox→/run/studiobox`.

| limabox source                                                                                    | destination              | disposition                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/state/` (model, CAS store)                                                                   | `src/state/`             | **carry** — the create-only CAS journal, already tested                                                                                             |
| `src/fclauncher/firecracker/` (adapter, CreateOnlyVmRegistry, error normalization, execution IDs) | `src/rootd/firecracker/` | **carry** — battle-tested against the real package; re-pin imports to `jsr:@nullstyle/firecracker@^0.2`                                             |
| `src/security/tickets.ts`                                                                         | `src/security/`          | **carry**                                                                                                                                           |
| `src/transports/tunnel_preface.ts`                                                                | `src/transports/`        | **carry** (magics → `SBXTUN1`/`SBXACK1`)                                                                                                            |
| `src/fchost/tunnel_authorizer.ts`                                                                 | `src/hostd/`             | **carry**                                                                                                                                           |
| `src/wire/` (contract, bootstrap gate, supervisor validators)                                     | `src/wire/`              | **carry**                                                                                                                                           |
| `src/api/command.ts`, `process.ts`, `errors.ts`                                                   | `src/api/`               | **carry** — real `sh` builder + KillController + taxonomy                                                                                           |
| `src/api/` abstract façade (sandbox, fs, deno, env, types)                                        | `src/api/`               | **carry as scaffold** — compile-compat shell until M8 installs a provider                                                                           |
| `schema/*.capnp` (5 canonical)                                                                    | `schema/`                | **carry** — keep file IDs & ordinals, rename identifiers, re-hash bundle                                                                            |
| `parity/` (inventory, member audit)                                                               | `parity/`                | **carry** — expensive to reproduce                                                                                                                  |
| `compat/` + `tools/check_{compat,wire,publish}.ts`                                                | same                     | **carry** — provenance gates                                                                                                                        |
| `.github/workflows/ci.yml`                                                                        | same                     | **carry + extend**                                                                                                                                  |
| `vendor/capnp-deno` snapshot                                                                      | —                        | **drop** — replaced by `jsr:@nullstyle/capnp@^0.1` (published); `deno.local.json` maps to the `../capnp-deno` checkout for coordinated dev          |
| `src/wire/generated/` (all six schemas)                                                           | —                        | committed five-schema bindings + codegen_probe at toolchain `f61257b` / capnp 0.2.0; ratchet enforces byte-identical regen — see `compat/wire.json` |
| 4 design docs                                                                                     | —                        | superseded by DESIGN.md/PLAN.md; keep `FIRECRACKER_INTEGRATION.md`'s G1–G13 table as `docs/firecracker-contract.md`                                 |
| `@nullstyle/firecracker` raw-URL imports                                                          | —                        | **drop** — JSR pin + `deno.local.json` sibling override                                                                                             |

## 3. Milestones

Each milestone ends demoable and CI-green. Points are relative effort (limabox's
73-pt scale, reduced by the transplant head start).

### M0 — Repo bring-up + transplant (5 pts)

Scaffold `deno.json` (JSR shape, tasks: `check`, `test` tiers, `compat:check` —
`test:vm` and `smoke:host` land with M5/M9), LICENSE (Apache-2.0), `.gitignore`,
CI skeleton. Apply the carry-forward map with the mechanical rename. Pin
`jsr:@nullstyle/firecracker@^0.2` and `jsr:@nullstyle/capnp@^0.1`; add
`deno.local.json` sibling overrides for both. **Exit:** all carried tests green
on macOS (`deno task check && deno task
test`, ~60 unit/host-safe + 3
process-contract); CI green; history starts committed (limabox's zero-commit
mistake is not repeated). **Demo:** clean clone → green board.

### M1 — Foundation qualification (8 pts) ← go/no-go

`@nullstyle/capnp@0.1.0` (JSR) claims fixes for both limabox-era blockers — the
codegen barrel/interface-id fix and the window-atomic stream sender. M1 proves
those claims against _our_ workload before breadth work; any gap goes upstream
to `capnp-deno` and comes back as a patch release.

1. **Codegen:** generate all five canonical schemas with the published
   `capnpc-deno`; verify cross-file struct/interface imports resolve to real
   types (the old `AnyPointer` lowering) and barrels merge without collisions;
   commit bindings behind a `wire:check` drift gate. _Fallback if a gap resists
   upstream fixing (recorded, ugly, workable): merge the five schemas into one
   file._
2. **Streaming bounds:** 1 GiB transfer soak holding `maxInFlight` and memory
   bounds under concurrent senders.
3. **Close/EOF ownership:** transport-close conformance tests (who closes, EOF
   propagation, no double-close) for `TcpTransport` over UDS/TCP/vsock conns.
4. **Compiled-runtime proof:** `deno compile` a probe binary embedding the capnp
   WASM from the JSR package (`--include`; the loader must resolve it via the
   package, not a repo-relative path), cross-compiled to linux-aarch64 + x86_64;
   prove an RPC round-trip from the compiled artifact. Also settle the in-guest
   vsock flag question (unstable flag or not) on the pinned Deno.

**Exit:** five schemas → committed drift-checked bindings from the published
toolchain; compiled probe does RPC on both arches; streaming soak green.
**Demo:** `deno task wire:check` + probe binary round-trip.

**Outcome (2026-07-11): the go/no-go answered NO on gate 1 and YES on gates
2–4.** Codegen at toolchain `ad07911` still lowers cross-file types to
`AnyPointer` (83 fields), leaves 159 cross-file names unresolved, and collides
101 barrel exports — `c7f33fb` fixed barrel _merging_, not cross-file resolution
or namespacing; `compat/wire.json` `codegen.blockers` is retained as historical
provenance (capnp 0.2.0 resolved every entry) and `wire:check` now ratchets on
the committed five-schema bindings, enforcing byte-identical regeneration and a
strict typecheck of all six schemas. The published _runtime_ is cleared: it
round-trips the cross-file wire shape given correct descriptors
(`cross_file_roundtrip_test.ts`), the 1 GiB soak held window and memory bounds
(window-atomic fix confirmed under burst sends), close/EOF conformance is pinned
(17 tests; three upstream gaps filed: `connect()` lacks prompt remote-EOF
teardown, out-of-band conn destruction leaves a half-open transport

- global unhandledrejection, no UDS composition surface), and the compiled-WASM
  probe passed on macOS + real aarch64-linux (x86_64 compile-only until x86_64
  CI; vsock verdict: Deno 2.9 needs `--unstable-vsock`). **Resolved
  (2026-07-11): the upstream emitter fix merged and shipped as capnp 0.2.0; the
  five-schema bindings are committed under `src/wire/generated/` and M2-wire is
  delivered — no schema-merge fallback needed.**

### M2 — Supervisor plane on fakes (6 pts)

`studiobox-rootd` v1, split by the M1 NO-GO into domain-core-first: M2 delivers
the transport-free **`SupervisorApi` domain core** (`src/rootd/supervisor_core*`
— launch / status / kill / reconcile / openBridge-grant) against the **fake VMM

- fake jailer shims** from `@nullstyle/firecracker/testing` — all macOS-safe;
  the `supervisor.capnp` service over the root UDS becomes a thin adapter over
  that interface once the upstream emitter fix lands (**M2-wire**). Journal
  wired end-to-end (SandboxRecord + nested JailRecord + execution IDs +
  journaled artifact reference) through the carried adapter. **Exit tests:**
  kill -9 the supervisor with live executions → restart → destructive reconcile
  reaps everything, journal converges to `terminated(host-restart)`; stale
  execution CAS rejection; bridge refuses unauthorized logical IDs. **Demo:**
  scripted create→status→kill cycle on a Mac with no VM anywhere. _Status
  2026-07-11: domain core + M2-wire delivered._

### M3 — studioboxd v1 + agent plane on fakes (8 pts)

The guest agent as a portable Deno service behind a transport seam (UDS/TCP in
dev, vsock in prod): `ProcessSpawner`/`Process` (spawn, stdio streaming via
`OutputSink`, kill/status/wait), `FileSystem` core (read/write/stat/
list/mkdir/remove/rename + streamed bodies), `Environment`, `DenoRuntime.eval`
(state-preserving REPL driver). Build **FakeSandboxHost** around it: an
in-process provider + agent over memory/UDS transport → the `./testing` export.
Start the **parity fixture suite** (same test file, upstream semantics
assertions) running against the fake. **Exit:** parity fixtures for
sh/spawn/fs/env/eval pass against FakeSandboxHost on macOS; `deno compile` of
studioboxd (both arches) boots and serves the plane over UDS. **Demo:**
`Sandbox`-shaped calls executing against an in-process guest. _Status
2026-07-11: the interim JSON scaffold protocol was replaced by the capnp
`sandbox_agent.capnp` plane (M3-wire) over the domain core._

### M4 — Artifact pipeline (8 pts)

`images/`: kernel fetch + sha256 verify (per arch); golden rootfs build via
pinned debootstrap against `snapshot.debian.org` (user `sandbox`/uid 1000, home
`/home/app`, pinned Deno, studioboxd baked in — committed placeholder until
M3/M5 delivers the compiled agent; the agent sha is an input pin so the manifest
hash rolls automatically on swap — overlay-init); sparse overlay creation
(unformatted; in-guest overlay-init formats on first boot); a `manifest.json`
whose hash covers input pins only, feeding `ContractIdentity`; copy-only staging
into jail layout; artifact cache + refcount GC under `~/.studiobox/artifacts/`,
with journal-referenced sets protected from GC. Builds run inside the Lima VM
(or any Linux as root — no loop devices needed; `mke2fs -d` packs the tree
directly). **Exit:** `studiobox images build` produces a manifest-addressed set
twice with identical hashes — rootfs reproducibility is defined as
**content-manifest identity** (sorted path/mode/owner/sha per file; raw ext4
byte-identity is unattainable with mke2fs and the manifest supports `imageBytes`
identity if e2fsprogs becomes reproducible); staging drill copies into a fake
jail and never mutates the golden inode (regression test). **Demo:** one command
→ verified artifact set. _Status 2026-07-11: delivered and fc-smoke-validated
(two builds, identical content-manifest hashes)._

### M5 — First real microVM (in-VM happy path) (8 pts)

Inside `studiobox-host-<arch>`: rootd + real jailer + real Firecracker boots the
M4 image; studioboxd comes up on real vsock; `probeAgent` green;
create→exec→fs→eval→terminate cycle driven by tests running _inside_ the VM (no
macOS tunnel yet). Port the firecracker-deno `smoke:lima` pattern as
`deno task test:vm` (provisions/reuses the Lima VM, runs the in-VM suite).
Planner wiring note (from the M4 adversarial pass): `acquire()` the artifact
cache refcount before (or atomically with) journaling the launch's
`ArtifactReference` — a GC sweep in the store→journal window reaps a just-stored
set and fails the launch closed at staging (safe, but spurious). **Exit:** in-VM
integration suite green on aarch64 locally and x86_64 on a KVM CI runner (runner
= "the Lima VM", no Lima involved). **Demo:** `deno task test:vm` from a Mac →
real microVM sandbox lifecycle.

### M6 — hostd control plane (7 pts)

`studiobox-hostd`: HostControl bootstrap → negotiate → authenticate (gate +
token, provisioned via `limactl` copy); leases (TTL, renew, revoke,
session-vs-duration timeout clocks); capacity ledger + `HostCapacityError`;
list/attach/metadata/usage; hostd↔rootd supervisor client. **Exit:** lease
expiry kills sandboxes; over-capacity create fails fast; attach from a second
client observes the first's sandbox; restart of hostd revokes leases and
tickets. **Demo:** two concurrent clients, capacity exhaustion, clean recovery.

### M7 — End-to-end tunnel (6 pts)

`openTunnel` → ticket → `SBXTUN1` preface → burn-before-bridge → `openBridge` →
vsock splice. Client on macOS drives the full SandboxAgent plane against a real
guest. **Exit:** E2E exec/fs/eval from macOS through the complete path; ticket
replay/expiry/rate-limit tests; tunnel teardown propagates EOF both ways and
frees the port; vsock dial racing VMM death yields the typed error, not a hang
(leans on firecracker-deno's dial-races-death contract). **Demo:** `sandbox.sh`
from a Mac terminal, microVM answering.

### M8 — Public SDK, Tier A complete (8 pts)

Install the real provider behind the carried API façade:
`Sandbox.create/
connect` (ID grammar `sbx_loc_…`), full `sh` builder semantics,
spawn/ ChildProcess stdio contract ("inherit" = client-side pipe), complete
`fs.*` (incl. upload/download, walk/expandGlob, FsFile), `env.*`,
`deno.eval/repl/
run` (+ `DenoProcess.fetch`, `httpReady`), `Sandbox.fetch`,
timeout/memory grammars, error taxonomy. Write **PARITY.md** (every Tier B/C
divergence). **Exit:** the parity fixture suite passes against real sandboxes
(in-VM CI) — same file that ran against FakeSandboxHost in M3; a `@deno/sandbox`
demo script runs unmodified except the import line. **Demo:** README quickstart
is real.

### M9 — Host lifecycle automation (5 pts)

`./cli`: `host up|down|status|doctor|provision` (idempotent; `--recreate`;
`--no-lima` for Linux); Lima template committed; systemd units; token mint;
health/doctor incl. quarantine listing. **Exit:** fresh Mac → `host up` →
quickstart works in one sitting; doctor detects and reports a deliberately
wedged daemon. **Demo:** cold-start-to-sandbox screencastable flow.

### M10 — Tier B emulations (6 pts)

`exposeHttp` (port range lease → `http://127.0.0.1:<port>`); `allowNet` nftables
egress per TAP (+ dnsmasq/ipset for wildcard hosts); `region` metadata echo; oom
boolean (137 + memory.events); `SandboxOptions.env` post-create application;
labels; `extendTimeout` actual-deadline semantics. **Exit:** parity fixtures
extended to Tier B rows; egress tests prove allow/deny both ways; exposed HTTP
survives sandbox restarts of _other_ sandboxes (port isolation).

### M11 — Hardening + the 1.0 soak (9 pts)

Resource enforcement to the ledger (cgroup cpu quota, `pids.max`, memory.max
backstop, overlay quota, daemon fd budgets); pinned-TLS on control + tunnel
listeners (staged decision lands here); structured logs + diagnostics bundle;
fleet reconcile drills. **The soak drill (the 1.0 bar, runs in CI on both
arches):**

- ≥200 sequential + batched create→use(sh/fs/eval)→terminate cycles;
- kill -9 rootd mid-fleet at random points, restart, reconcile; repeat ≥10×;
- assertions after every phase: zero leaked VMM/jailer processes, TAPs, netns,
  nftables rules, mounts, overlay files, jail roots, port reservations, journal
  entries outside terminal phases; daemon RSS and journal-dir size bounded;
  create p95 within target on warm cache. **Exit:** soak green on aarch64 +
  x86_64 three consecutive scheduled runs.

### M12 — Docs + 0.1.0 release (4 pts)

Docs (permissions matrix per daemon, threat model, PARITY.md polish, macos/linux
host guides, testing-your-app with FakeSandboxHost); JSR publish (the
`@nullstyle/capnp`-on-JSR prerequisite is already satisfied); tag-driven release
workflow (configure the JSR GitHub-Actions publishing link from day one — the
firecracker-deno lesson). **Exit:** `deno add jsr:@nullstyle/studiobox` +
quickstart verbatim in a fresh project.

**Total: ~88 pts ≈ 6–7 focused weeks.** 1.0 is declared when M11's soak holds
across releases, not at M12 — 0.x continues until the soak criteria have
survived real use.

### Post-1.0 horizon (explicitly out of scope until then)

Volumes/snapshots mapped onto Firecracker snapshots + overlay images;
secret-on-the-wire via TLS-terminating egress proxy; `exposeSsh` /
`exposeVscode`; warm sandbox pools for sub-second create; multi-host federation;
live adoption (requires an upstream adoption API in firecracker-deno —
coordinate, don't fork).

## 4. Testing strategy

| Tier     | Needs        | Runs                                            | What lives here                                                                                                                         |
| -------- | ------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| T1 unit  | nothing      | everywhere, every PR                            | escaping, preface codec, CAS store, validators, ledger math, ID grammars                                                                |
| T2 fake  | UDS only     | macOS + Linux, every PR                         | FakeFirecracker + fake VMM/jailer shims (from `@nullstyle/firecracker/testing`), FakeSandboxHost, rootd/hostd logic, parity fixtures v1 |
| T3 in-VM | Linux + KVM  | x86_64 CI runners; aarch64 via `test:vm` (Lima) | real jailer/microVM/vsock/studioboxd, parity fixtures v2, reconcile drills                                                              |
| T4 e2e   | macOS + Lima | scheduled + pre-release                         | full topology client→hostd→rootd→guest, tunnel, CLI flows                                                                               |
| soak     | T3 env       | scheduled (M11+)                                | the 1.0 drill                                                                                                                           |

Parity is enforced two ways: **compile parity** (a fixture that imports both
SDKs and type-checks shared call sites against the carried inventory) and
**behavior parity** (one fixture suite, three backends: FakeSandboxHost → in-VM
real → e2e).

CI mirrors firecracker-deno's proven shape: check + drift gates (`wire:check`,
`compat:check`, parity-inventory drift), test matrix (ubuntu-24.04 + macos ×
Deno floor + latest), KVM integration job with udev rule, compile-smoke for
daemons/agent on both arches, concurrency-canceling groups, tag-gated publish.

## 5. Risks

| #  | Risk                                                               | Mitigation                                                                                                                                                                |
| -- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 | the published codegen still fails on our five-schema bundle        | M1 is first and gated; gaps fixed upstream + consumed as patches; fallback = single-file schema merge (loses modularity, keeps ordinals)                                  |
| R2 | WASM session core misbehaves compiled/in-guest                     | M1 gate 4 proves it before anything depends on it; last-resort fallback is a pure-TS session core (large) — decide only on hard failure                                   |
| R3 | copy staging blows the 2 s create p95                              | measure at M5; levers: smaller golden rootfs (debootstrap --variant=minbase, or Alpine), parallel copies, warm page cache, pre-staged spare jails                         |
| R4 | debootstrap reproducibility drifts                                 | pin `snapshot.debian.org` epoch in the manifest                                                                                                                           |
| R5 | nested-virt constraints (M3+ Mac, macOS 15+)                       | documented requirement; Linux `--no-lima` path is first-class                                                                                                             |
| R6 | in-guest Deno vsock needs unstable flags / regresses               | settled at M1: Deno 2.9 requires `--unstable-vsock` (recorded in `compat/wire.json`); studioboxd carries the flag; `DENO_SERVE_ADDRESS=vsock:` as alternate serving path  |
| R7 | upstream `@deno/sandbox` moves (0.13.x → …)                        | parity inventory regen task + pinned-target policy: track latest, hold a two-minor compat window, PARITY.md records the delta                                             |
| R8 | scope creep vs. one maintainer                                     | Tier C stays Tier C until the soak holds; the horizon list is a fence, not a menu                                                                                         |
| R9 | an M1 qualification gap needs a breaking `@nullstyle/capnp` change | same maintainer on both sides — fix upstream, pin the new release; 0.x semver churn is acceptable while studiobox is pre-release (no vendoring escape hatch, by decision) |

## 6. Immediate next actions (M0)

1. `git init`, commit the founding docs (this file, DESIGN.md, README, LICENSE).
2. Execute the carry-forward map from `../limabox` with the mechanical rename;
   get the carried test suite green.
3. Swap firecracker imports to `jsr:@nullstyle/firecracker@^0.2` +
   `deno.local.json` overrides.
4. Stand up CI (check + `compat:check` + T1/T2; compile smoke arrives with the
   first compiled artifact in M1/M3) — green board before M1 starts.
