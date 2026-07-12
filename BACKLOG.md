# @nullstyle/studiobox — Working Backlog

Consolidated, de-duplicated enumeration of NOT-YET-DONE work, synthesized from
five audit sweeps (milestones, deferrals, design-vs-code, parity Tier B/C,
wire-stubs, infra/CI, security). Every item traces to a grounded sweep finding;
nothing here is speculative.

**Current state:** M0–M7 + the M10 egress *core* (nftables engine, not wired
into launch) + the M11 soak *harness* (host-safe, fake-backed) are DONE,
committed, CI-green. **In flight right now:** M8 (real `@deno/sandbox` provider
+ two-daemon tunnel assembly + parity-against-real) and a separate session doing
the M7 endpoint-scoped ticket-burn fix + the bridge-UDS split. Everything below
is what remains between here and a 1.0 / 0.1.0 release.

Tag legend per item: `[status · size · milestone · deps]`
status ∈ {not-started, partial, deferred, in-flight}; size ∈ {S, M, L}.

---

## M8 — Public SDK / Tier A complete (in flight)

**Real daemon-backed `SandboxProvider`** — The `Sandbox.create/connect` provider
seam has exactly one implementation, `FakeSandboxHost`; with no fake installed
`getSandboxProvider()` throws `ImplementationPendingError("Sandbox")`. The real
provider wiring create/connect → hostd `HostControl` → `openTunnel` →
`dialTunnel` → `SandboxAgent` capnp client is *the* M8 deliverable and the thing
that makes the README quickstart real. Every Tier A surface is proven only
against the in-process fake today.
`[in-flight · L · M8 · M7 tunnel/bridge assembly]`
Evidence: `src/api/provider.ts:24`; sole installer `testing/mod.ts:1013`; only
`class FakeSandbox extends Sandbox` in `testing/mod.ts:826`; `src/mod.ts`.

**`openTunnel` grant delivers empty `agentCredential`/`tunnelNonce`** — openTunnel
is wired (bridgeFactory + BridgeServer), but the wire adapter hardcodes
`TunnelGrant.tunnelNonce @6` and `agentCredential @7` to zero-length, the domain
`TunnelGrant` has no such fields, and `WireBridgeFactory` discards rootd's
`grant.agentCredential`. The client thus receives no credential to present to the
guest `AgentBootstrap.authenticate`, which requires a match.
`[in-flight · M · M8 · plumb rootd BridgeGrant through bridgeFactory→TunnelServer→control_core→wire]`
Evidence: `src/hostd/service.ts:452-453`; `src/hostd/control_core.ts:148-165`;
`src/hostd/wire_bridge.ts:75-117`.

**HttpClient egress plane — `Sandbox.fetch` / `DenoProcess.fetch` / `httpReady`
/ `SandboxAgent.http()`** — Entire in-guest HTTP plane is unbuilt: the agent
rejects `http()` (`SBX_AGENT_UNSUPPORTED`), and `DenoProcess.fetch`/`httpReady`
return `unsupportedFeature` ("deferred to M8"); the schema declares HttpClient /
HttpExchange / HttpResponseSink with no server impl. Backs the policy-filtered
egress fetch surface and the in-runtime Deno-server proxy (Tier A/B).
`[not-started · L · M8 · real provider; M10 allowNet for policy filtering]`
Evidence: `src/agent/service.ts:824,834,1444-1453`;
`schema/sandbox_agent.capnp:223-240,268`; `testing/mod.ts:387-390,456-462,885`;
`src/api/deno.ts:28`.

**`fs.upload` / `fs.download` recursive composition** — The agent exposes
single-file `beginUpload`/`beginDownload` primitives, but the SDK-side recursive
directory walk with relative-symlink preservation (upstream semantics) is not
built; even the fake throws. `src/api/fs.ts` exposes only the interface.
`[not-started · M · M8 · real provider agent fs plane]`
Evidence: `testing/mod.ts:703-712`; `src/agent/service.ts:57-64`;
`src/api/fs.ts:130,142`; `schema/streams.capnp` ByteReader impl at
`src/agent/service.ts:1022-1070`.

**`DenoRepl` full ChildProcess-shaped surface** — `deno.repl()`'s
pid/stdin/stdout/stderr/status/output/fetch/httpReady are all unimplemented, so
repl parity beyond eval/call is missing.
`[not-started · M · M8 · real provider]`
Evidence: `testing/mod.ts:456-480`.

**Agent `ContractIdentity` still uses M3 zero-digest placeholders** — Both the
real agent and the rootd dialer negotiate with `m3AgentContractIdentity`
(all-zero artifact/WASM/firecracker digests, "unpinned" package), so identity
negotiation compares zeros, not real artifact identity — despite M5 having
shipped.
`[partial · M · M5/M8 · real artifact manifest into identity]`
Evidence: `src/agent/service.ts:124,152,157`; `src/agent/main.ts:359`;
`src/rootd/agent_dialer.ts:116`.

**Parity fixture suite against real backends** — `runParitySuite`
(`tests/parity/suite.ts`) is parameterized for three backends (fake M3, in-VM
real M5, macOS-tunnel SDK M8) but only the `FakeSandboxHost` binding exists. The
M8 exit — the same parity file passing against real sandboxes in in-VM CI — is
unmet.
`[not-started · M · M8 · real provider; in-VM CI]`
Evidence: `tests/parity/suite.ts:7-13`; only `tests/parity/fake_host_test.ts`
calls `runParitySuite`.

**SDK create-path option plumbing (bundle)** — Several small Tier A/B options
land with the real provider and are trivial once it exists:
- **memory/timeout grammar applied on create** — `parseMemory` (768–4096 MiB
  clamp, `InvalidMemoryError`, default 1280) exists but no create path calls it;
  the fake ignores `options.memory`/`options.timeout`. Real provider must map to
  hostd `CreateSandboxInput` (memoryMiB + LeaseTimeout) and enforce the clamp
  observably. `[partial · S · M8]` — `src/api/memory.ts:27`;
  `testing/mod.ts:1023-1093`; `src/hostd/control_core.ts:80-91`.
- **`SandboxOptions.env` post-create replay** — fake applies env via `env.set`
  (fake-only); no real provider replays env over the Environment plane.
  `[in-flight · S · M8]` — `testing/mod.ts:1073-1075`.
- **`labels` round-trip** — caps (≤5 / 64B key / 128B value) enforced at the
  hostd wire adapter, but no real provider carries `options.labels` to hostd on
  create nor surfaces them via `list()`/metadata; fake enforces no caps.
  `[partial · S · M8]` — `src/hostd/service.ts:326-345`; `testing/mod.ts:1090`.
- **`extendTimeout` actual-deadline** — `HostControlCore.extendTimeout` + wire
  are implemented and return the real deadline, but the fake throws and the
  abstract SDK method has no backend. `[partial · S · M8]` —
  `src/hostd/control_core.ts:602-615`; `src/hostd/service.ts:460-469`;
  `testing/mod.ts:904`.

**Additive SDK-surface: `studiobox`/`lima` options field, `Region` widening,
`./unstable-host` export** — DESIGN §5/§12 deliverables still absent:
`SandboxOptions` (`src/api/sandbox.ts:21-35`) has no additive `studiobox`/`lima`
field for host/artifact selection; public `Region` is still `"ord" | "ams"`
(`src/api/types.ts:18`) and must widen to admit `"loc"` so a local sandbox's
region round-trips (fake casts `"loc" as Region`, hostd `regionToWire` maps
`loc→ord`); and the `./unstable-host` host/daemon export (LimaDriver,
provisioning) is not split — the host seam is re-exported from the root barrel
and no `LimaDriver` class exists. `[not-started · S · M8/M10/M12 · real provider]`
Evidence: `src/api/sandbox.ts:21-35`; `src/api/types.ts:18,627`;
`src/hostd/control_core.ts:58`; `testing/mod.ts:1026,1121-1122`;
`src/hostd/service.ts:286-298`; `deno.json` exports; `mod.ts:17-152`;
`docs/architecture.md:157`; `PARITY.md:279-287`.

---

## M7 — End-to-end tunnel (exit unmet; hardening in flight)

**macOS→hostd→rootd→guest E2E via the control plane** — The in-VM tunnel proof
drives `TunnelServer` + `SupervisorBridgeFactory` + agent session directly
inside the guest, not a macOS client through hostd's `HostControl.openTunnel`
over the real forwarded control port. The M7 exit (E2E exec/fs/eval from macOS
through the complete path) is unmet.
`[in-flight · M · M7→M8 · real provider; hostd/rootd as real processes]`
Evidence: `tests/vm/tunnel_vm_test.ts:136-208`; `src/hostd/main.ts:485-492`.

**Endpoint-scoped ticket-burn fix + two-daemon bridge-UDS split** — Uncommitted
working-tree work: new `src/hostd/wire_bridge.ts`, `src/rootd/bridge_server.ts`,
`src/transports/bridge_preface.ts` + edits to `tickets.ts`, `tunnel_server.ts`,
`supervisor_client.ts`, `rootd/service.ts`. Splits the bridge across the
hostd→rootd UDS and makes single-use ticket burn endpoint-scoped.
`[in-flight · M · M7]`
Evidence: git status new/modified files above.

**Ticket temporal issuance rate-limit (M7 exit gap)** — M7's exit calls for
ticket replay/expiry/rate-limit tests. The in-flight session adds a
`maxOutstanding` concurrent-capacity cap (`TicketCapacityError`), but
`SingleUseTicketStore.issue()` still has no *temporal* per-session rate limit —
confirm whether the exit requires one or the capacity cap suffices.
`[in-flight · S · M7 · ticket-burn session]`
Evidence: `src/security/tickets.ts:74-76`; PLAN §M7.

---

## M9 — Host lifecycle automation

**Compile + install the two daemons (provisioning prerequisite)** —
`daemons:compile` exists and both daemons type-check clean, but `.build/`
contains only `studioboxd` (all arches); there are no `studiobox-hostd` /
`studiobox-rootd` binaries, so `provision` skips their systemd units and waits on
the "deno compile step for the daemons". No CI compile-smoke produces or verifies
them. Blocks cold `host up`. `[partial · S · M9 · none (type-checks pass)]`
Evidence: `.build/`; `src/cli/provision.ts:25-28,248,257`; `deno.json`
`daemons:compile`.

**Cold `host up` real validation (fresh Mac → quickstart, one sitting)** —
`HostLifecycle` is exercised only against a FAKE `limactl` with no VM; the real
cold-start flow and doctor-detects-wedged-daemon are validated only manually. The
M9 exit has no automated end-to-end coverage and depends on the still-missing
real provider. `[partial · M · M9 · real provider; compiled daemons installed]`
Evidence: `src/cli/host_lifecycle.ts:8-11`; `docs/host-lifecycle.md`.

**Two-daemon socket privilege boundary not enforced** — DESIGN §8 requires
rootd's supervisor UDS at `0660 root:studiobox` (so only hostd's group can dial)
and bridge sockets under `/run/studiobox/b/`. The server binds via
`Deno.listen({transport:"unix"})` with no chmod/chown; the bridge root is created
`0700` (root-only), contradicting an unprivileged hostd dialing bridge sockets
under it. The group-based boundary is documented but not realized; security rests
on the bootstrap credential alone. `[not-started · M · M9/M11 · provisioning
creates the `studiobox` group + /run/studiobox]`
Evidence: `src/rootd/main.ts:8-16,237-253,530`; no chown/group primitive in src.

**Artifact-cache GC never triggered at runtime** — `ArtifactCache.gc(reader)` is
fully implemented (refcount-zero + not-journal-referenced + abandoned-temp
sweep) but has no non-test caller — not rootd startup, not the reconcile sweep,
not any CLI subcommand. Reclaim releases refcounts on terminate but nothing
collects the now-unreferenced sets, so `~/.studiobox/artifacts/` grows unbounded.
`[partial · S · M9/M11 · JournalArtifactReferenceReader (built); only the trigger
is missing]`
Evidence: `images/cache.ts:409`; no `.gc(` caller outside tests;
`artifact_refs.ts:4,37`.

---

## M10 — Tier B emulations

**Wire the allowNet nftables egress engine into launch (linchpin)** — The
fail-closed nftables core (`src/rootd/network/`: spec/resolver/ruleset/apply +
`EgressReclaimHook`) is built and fc-smoke-validated but never called from
launch: `launch_planner` emits a VmConfig with no `network_interfaces`, creates
no TAP/netns, journals no `tapName`/`netnsPath`, calls no `applyAllowNet`, and
never registers `EgressReclaimHook` on `SupervisorCore`. Until wired, allowNet is
silently a no-op and the reclaim hook (which keys off `resources.tapName`) can
neither apply nor reap. This item is the dependency for every egress-hardening
item below. `[partial · M · M10 (M6/M10 convergence) · launch_planner TAP/netns +
firecracker NIC config; M8 real launch path]`
Evidence: `src/rootd/network/reclaim_hook.ts:6-26,63`;
`src/rootd/launch_planner.ts:235-259`; `state/model.ts:81-82`; no
EgressController/applyAllowNet/EgressReclaimHook callers in launch_planner /
main.ts / supervisor_core.ts; `docs/networking.md:203-223`.

**`CreateOptions` fields dropped at the wire boundary** — Schema `CreateOptions`
declares `vcpus @2`, `allowNet @3`, `netless @6`, `kernelArgs @7`, but
`createInputFromWire` reads only timeout/memoryMiB/region/labels/idempotencyKey,
and `CreateSandboxInput` has no slots for the four. allowNet is the input to the
egress engine; vcpus/netless/kernelArgs are silently ignored.
`[partial · M · M10 (allowNet) / launch_planner (vcpus,kernelArgs)]`
Evidence: `src/hostd/service.ts:331-359`; `src/hostd/control_core.ts:80-91`;
`schema/host_control.capnp:25-34`.

**allowNet wildcard-subdomain dnsmasq/ipset path** — `renderDnsmasqFragment`
renders a config fragment and the ipset-backed wildcard set is modeled in the
ruleset, but nothing installs/reloads dnsmasq or manages the ipset lifecycle at
launch/reclaim, so short-TTL/wildcard hosts have no live plumbing.
`[partial · M · M10 · allowNet launch wiring]`
Evidence: `src/rootd/network/mod.ts` exports `renderDnsmasqFragment`; no
install/reload caller.

**`exposeHttp` (port-range lease → `http://127.0.0.1:<port>`)** — hostd's wire
handler returns `unsupportedFeature` ("not yet wired (M10 egress path)"),
`HostControlCore` has no `exposeHttp` at all, the fake throws, and the abstract
`Sandbox.exposeHttp` has no impl. The reserved 40100–40199 forward range, the
port lease, the host→guest forward, journaling/reclaiming
`SandboxResources.exposedPorts` (field exists, unused), and the port-isolation
requirement (exposed HTTP survives other sandboxes' restarts) are all unbuilt.
`[not-started · M · M10 · hostd forward-range allocator; rootd port forwarding;
per-sandbox NIC]`
Evidence: `src/hostd/service.ts:503-520`; `schema/host_control.capnp:219`;
`state/model.ts:83-84`; `testing/mod.ts:911`.

**oom boolean: cgroup `memory.events` source missing** — The `status.oom` seam
exists (`oom = (code===137) && annotate(...)`, injectable `oomAnnotator`), but
there is no real cgroup `memory.events`/oom_kill reader; the default annotator is
`() => false` and one agent path hardcodes `oom: false`. A real cgroup-backed
annotator must be wired into the guest/rootd path.
`[partial · M · M10 · cgroup v2 accounting in guest/rootd]`
Evidence: `src/agent/processes.ts:301-303,404-433`; `src/agent/service.ts:796`.

**`region` metadata echo of `"loc"` on the real path** — Because `Region` is
still `ord|ams` and `regionToWire` maps `loc→ord`, a real sandbox's
`SandboxMetadata.region` would report `"ord"` not the contracted `"loc"`. Needs
the Region-union widening (see M8 item) plus dropping the loc→ord downcast, and a
schema `Region` enum bump (`loc` arm) with codegen + `compat/wire.json` hash
update. `[partial/deferred · S · M8/M10 · schema regen]`
Evidence: `src/api/types.ts:18`; `src/hostd/service.ts:286-298`;
`src/hostd/control_core.ts:58-59`; `schema/host_control.capnp:13-16`;
`PARITY.md:192-196`.

**`resumeLease` / durable-lease resume across hostd restart** — Wire
`HostControl.resumeLease @3` returns `unsupportedFeature` and `HostControlCore`
has no `resumeLease` method at all. A hostd restart currently revokes all leases;
recovering them needs durable lease persistence (`state/store.ts`) that this path
never consults. `[not-started · M · post-M6 · durable lease/state persistence]`
Evidence: `src/hostd/service.ts:634-651`; no `resumeLease` in
`control_core.ts`/`leases.ts`.

---

## M11 — Hardening + the 1.0 soak

**Real-microVM 1.0 soak drill (`soak:vm`)** — The 1.0-defining drill (≥200 real
create→use→terminate cycles, kill-9 rootd mid-fleet ≥10× + reconcile, 10-class
no-leak audit, bounded RSS/journal, create p95) has never run against real VMs.
The entrypoint refuses to launch VMs and the real create/use/terminate backend
over the M5 agent plane is not wired even in-guest. Host-safe harness +
`buildInGuestAudit` are done. `[deferred · L · M11 · M5 agent-plane soak backend;
M8 real backend; KVM CI + scheduling; #14]`
Evidence: `tools/soak/soak_vm_main.ts:4-8,87,101-127`; `docs/soak.md:79-97`.

**Resource enforcement to the capacity ledger** — DESIGN §9's layered enforcement
is unbuilt: launch sets only Firecracker `machine_config` (hardcoded
`vcpu ?? 1` / `mem ?? 512`, ignoring the Memory grammar / §9 2-vCPU shape and a
fixed 256 MiB overlay), with no jailer cgroup `cpu.max`/`pids.max`/`memory.max`
backstop, no per-sandbox overlay quota, and no per-daemon fd budget. A hostile
workload can exhaust host CPU/pids/fds beyond the memory clamp. `usage()` returns
all zeros. `[not-started · L · M11 · capacity ledger (done) → enforcement]`
Evidence: `src/rootd/launch_planner.ts:55,171-176,235-259`;
`src/rootd/supervisor_core.ts:304-317`; no
`pids.max`/`memory.max`/`cpuQuota`/`rlimit`/`fdBudget` in src.

**Real resource-usage accounting (`usage()` returns zeros)** — `SupervisorCore`
/ `Supervisor.usage` / `HostSandbox.usage` are wired end-to-end but rootd returns
a hardcoded zeroed `MachineUsage` (cpu/mem/disk/rx/tx = 0); no cgroup/disk/net
counters are read, so capacity/usage reporting is fake.
`[partial · M · M10/M11 · cgroup v2 + tap/disk counters in the fc adapter]`
Evidence: `src/rootd/supervisor_core.ts:306-317`;
`src/rootd/supervisor_core_api.ts:59-71`; `src/hostd/supervisor_client.ts:85`.

**Pinned-TLS on control + tunnel listeners** — Everything runs
token-over-loopback; hostd's control and tunnel listeners are plaintext
`Deno.listen` with no TLS, cert generation, or fingerprint pinning anywhere. The
staged design (cert generated in-VM, fingerprint retrieved via limactl, client
pins it) still has to land in code. `[deferred · M/L · M11 · hostd/rootd
listeners; CLI fingerprint retrieval]`
Evidence: no tls/cert/fingerprint/x509 in src or tools;
`src/hostd/main.ts:200,209`; `src/hostd/tunnel_server.ts:131-132`;
DESIGN §8/§13.3; `docs/threat-model.md:87-100`.

**Structured logs + diagnostics bundle + fleet reconcile drills** — Daemons and
guest agent emit ad-hoc `console.log`/`console.error`; no structured (JSON)
logging module, no `host doctor` diagnostics/support bundle, and the fleet-scale
reconcile drills named in M11 aren't present (only per-unit + single-cycle in-VM
reconcile tests). Blocks soak-failure triage and the 1.0 soak bar.
`[not-started · M · M11 · none]`
Evidence: `src/agent/main.ts:403,437,449`; PLAN §M11 (`262-263`); no
logging/diagnostics module; `tests/vm/reconcile_test.ts` only.

**Reconcile studiobox-layer reclaim coverage incomplete** — DESIGN §6 requires
the studiobox reconcile to reclaim what the firecracker package cannot (cgroup
residue, overlay files, TAP/netns/nftables chains, port reservations) and revoke
leases/tickets. Quarantine itself is correctly implemented and reachable, but the
production rootd assembly registers only the artifact overlay+refcount hook — no
cgroup/TAP/netns/nftables or port-reservation reclaimer — so a destructive
host-restart sweep converges the record to `terminated(host-restart)` while the
resources leak. `[partial · M · M10/M11 · depends on egress-at-launch, cgroup
enforcement, and port-lease items landing first (their hooks then register here)]`
Evidence: `src/rootd/main.ts:520-522`; `src/rootd/supervisor_core.ts:546-576,725-740`.

---

## M12 — Docs + 0.1.0 release

**`deno.json` version still `0.0.0`** — Never bumped from scaffold; a hard
release blocker on its own, and no first JSR publish can proceed at 0.0.0.
`[not-started · S · M12]`
Evidence: `deno.json:3`; `tools/check_publish.ts:40-42`; `tools/check_compat.ts:114`.

**Tag-driven JSR publish/release workflow + provenance** — `.github/workflows/`
holds only `ci.yml` (permission `contents: read`, no `id-token: write` for JSR
OIDC). Nothing publishes the package: no tag trigger, no `deno publish`, no
provenance. The M12 exit (`deno add jsr:@nullstyle/studiobox` + verbatim
quickstart) cannot be met. `[not-started · M · M12 · M8 real SDK; version bump;
green board]`
Evidence: `.github/workflows/ci.yml`; PLAN.md:274-281.

**Publish-readiness guard + real `deno publish --dry-run` in CI** —
`tools/check_publish.ts` (with a passing unit test) is a static allowlist guard
but no `publish:check` task exists and no CI step invokes it; nor is there a real
`--dry-run` validating `publish.include`, exports resolution, or slow-types. The
guard is effectively dead code. `[partial · S · M12 · release workflow]`
Evidence: only `tests/unit/tools/check_publish_test.ts` references it; no
`publish*` task; `ci.yml` has no publish/dry-run step.

**JSR doc-score / slow-types gate** — M12 targets a JSR doc-score, but nothing
checks it: no `deno doc --lint` / slow-types gate, so exported-symbol
documentation and JSR fast-check compliance are unverified before publish.
`[not-started · S · M12 · release workflow / dry-run]`
Evidence: `deno.json` check task (`fmt --check && lint && check .`); PLAN.md:278.

**Release docs polish** — README still declares "Design stage… Not usable yet";
the permissions-matrix / threat-model / testing-your-app docs exist but need
release polish, and the M12 "doc score" gate isn't in place. (Also depends on the
`./unstable-host` split — see the M8 additive-surface item.)
`[partial · S · M12 · M8/M9 surfaces landing]`
Evidence: `README.md`; `docs/`; `PARITY.md:286-287`.

---

## Cross-cutting — Security / Egress hardening

*(All egress items below depend on "Wire the allowNet engine into launch" in M10;
they are the adversarial-review recommendations from `docs/networking.md`.)*

**Guest uid-drop + `pivot_root` (studioboxd + workloads run as root in-guest)** —
`overlay-init` execs studioboxd as root via `chroot` (not `pivot_root`), and
`AgentProcesses.spawn()` uses `Deno.Command` with no uid/gid drop, so studioboxd
and every workload run as root inside a chroot — contradicting DESIGN §8/§10 and
`docs/permissions.md`, which claim a drop to uid 1000. A root process escapes
chroot trivially, so in-guest defense-in-depth is absent and the VM boundary is
the sole containment. Implement setpriv/su to uid 1000 and pivot_root.
`[partial · L · M5/M11 · none — also a docs-vs-code divergence to reconcile]`
Evidence: `images/overlay_init/overlay-init.sh:91`;
`src/agent/processes.ts:451-459`; `docs/permissions.md:19,120`; DESIGN.md:350.

**Egress link-local / metadata protection FLOOR (even unrestricted)** — An
unrestricted sandbox (unset allowNet) gets an nft table with an empty
policy-accept egress chain, so the guest can reach 169.254.169.254 (metadata),
RFC-1918 hosts, other sandboxes' subnets, and the Lima host. Add an unconditional
floor blocking link-local (169.254.0.0/16, fe80::/10) + metadata + host address.
`[not-started · S · M10/M11 · egress-into-launch]`
Evidence: `src/rootd/network/ruleset.ts:230-239`; `docs/networking.md:90-93,245-249`.

**Egress input-hook guard for gateway-colocated services** — The per-sandbox
table hooks only `forward`, so traffic terminating on the host/gateway (the
dnsmasq resolver, anything on the TAP gateway / Lima host, hostd's loopback
control/tunnel/expose listeners) traverses the `input` hook unfiltered by the
egress ruleset. Add an input-hook guard chain to confine host-terminated egress.
`[not-started · M · M10/M11 · egress-into-launch]`
Evidence: `src/rootd/network/ruleset.ts:103,244-320`; `docs/networking.md:245-249`.

**Egress TTL-bounded re-resolution of exact-host allowlist entries** — Exact
allowNet hostnames are resolved once at apply time and baked into the nft sets; a
name repointed after apply keeps its point-in-time allowance for the sandbox's
whole life (DNS-drift / rebinding). Add periodic/TTL-bounded re-resolution.
`[not-started · M · M10/M11 · egress-into-launch]`
Evidence: `src/rootd/network/resolver.ts:10-16`; `docs/networking.md:227-233`.

**Egress per-sandbox conntrack zone** — `ct state established,related accept`
trusts the shared default conntrack zone (0) across every sandbox and the host,
so a guest could ride an established/related flow it didn't originate. Assign each
TAP its own nft `ct zone` (raw/prerouting). `[not-started · S · M10/M11 ·
egress-into-launch]`
Evidence: `src/rootd/network/ruleset.ts:258`; `docs/networking.md:259-261`.

---

## Tech-debt / Test-gaps / CI

**No CI job runs the real in-VM (T3) integration suite** — CI's `test` job runs
only host-safe `deno task test` (unit+fake+parity+host-safe soak); the real
`tests/vm/` suite (cycle/reconcile/tunnel/handshake-leak booting jailed
Firecracker over real vsock) runs only via local `test:vm` through Lima on a Mac.
M5's exit (in-VM suite green on a KVM runner) is unmet in CI. `[not-started · M ·
M5 · KVM CI runner with /dev/kvm + udev rule]`
Evidence: `.github/workflows/ci.yml` (jobs check+test only); `deno.json` test
composition; `tools/lima_vm_test.ts`.

**x86_64 real-KVM leg unproven (compile-only)** — Only aarch64 is validated
locally; x86_64 is compile-only for both the compiled-probe RPC round-trip and
in-VM lifecycle. Closing it needs the x86_64 KVM CI job M5 deferred.
`[deferred · M · M5 · the KVM CI job above]`
Evidence: `compat/wire.json` compiledProbe.targets.x86_64; PLAN.md:194.

**Both-arch soak + KVM in CI (scheduled runs)** — No KVM integration job, no
scheduled soak, no x86_64 in-VM leg. The M11 exit (soak green on aarch64 +
x86_64 across three consecutive scheduled runs) and the M5 x86_64 leg both depend
on this. CI only triggers on pull_request + push to main — no `schedule:` cron
for the T4 e2e and soak tiers. `[not-started · M · M11 (+M5) · #13 real soak;
KVM runner + udev]`
Evidence: `.github/workflows/ci.yml` `on:`/matrix; PLAN.md:296-313,302-303.

**No compile-smoke CI job for daemons/agent on both arches** — `daemons:compile`
(hostd+rootd) and `agent:compile` (studioboxd native + cross aarch64/x86_64)
exist but never run in CI, so cross-compile/platform breakage is uncaught until a
manual/in-VM run. `[not-started · S · M5 · none]`
Evidence: `deno.json` tasks; `ci.yml` has no compile refs; PLAN.md:312-313.

**`wire:check` reproduction leg never runs in CI; toolchain pin maintenance** —
CI runs `wire:check`, but its byte-identity regeneration and full-binding
qualification legs skip loudly because the `../capnp-deno` codegen toolchain is
not checked out in CI; only the schema-hash/compiler-pin/typecheck legs enforce.
The recorded toolchain commit (capnp 0.4.0) needs re-pinning as capnp-deno
advances. `[partial · S · M1 · none]`
Evidence: `ci.yml:78-81`; `tools/check_wire.ts:104-133`;
`compat/wire.json` codegen.toolchain.

**Qualification suites (`qualify:images`, `qualify:streaming`) run in no CI job**
— The `SBX_QUALIFY`-gated kernel-fetch (network→S3) and memory-bounded
streaming-soak tasks are defined but never invoked by CI, so the M1 streaming
-bounds proof and per-arch kernel-pin verification exist only as local manual
legs. `[partial · S · M1 · none]`
Evidence: `deno.json` `qualify:*` tasks; no `qualify` ref in `ci.yml`.

**`streams.capnp` `ByteSink` interface vestigial** — `ByteSink`
(chunk/finish/abort) is declared and codegen'd into `streams_types.ts` but no
schema method returns/accepts it and no server implements it; `Upload` in
`sandbox_agent.capnp` duplicates its shape. Decision: adopt it as the push-upload
sink or remove it. (`ByteReader` *is* implemented for `beginDownload`.)
`[not-started · S · schema cleanup · none]`
Evidence: `schema/streams.capnp:45-49`; impl gap vs `src/agent/service.ts:1022-1070`.

---

## Tier C — correctly-rejected non-goals (post-1.0 / permanent; listed for completeness)

These are deliberate source-compat stubs that throw `UnsupportedFeatureError`;
they are NOT backlog work for 1.0 — only kept compiling against upstream drift.

- **secrets** (`SandboxOptions.secrets` / `SecretConfig`) — needs a
  TLS-terminating egress proxy; post-1.0 candidate. `[deferred · L · post-1.0]` —
  `src/api/types.ts:837`; `testing/mod.ts:970-976`.
- **exposeSsh + `ssh` create option** — no SSH ingress in the local model;
  post-1.0. `[deferred · M · post-1.0]` — `src/api/sandbox.ts:111`.
- **exposeVscode / VsCode** — no VS Code tunnel service; post-1.0.
  `[deferred · M · post-1.0]` — `src/api/sandbox.ts:112-115,136`.
- **volumes / snapshots / root** (+ Volume/Snapshot classes) — map onto
  Firecracker snapshots + overlay images; post-1.0. `[deferred · L · post-1.0]` —
  `src/api/client.ts:28-42`; `src/api/volume.ts:15-26`; `src/api/snapshot.ts:17-27`.
- **deploy / apps / revisions / timelines / layers** (PaaS surface) — permanent
  non-goal; type-only stubs. `[deferred · S · non-goal]` —
  `src/api/client.ts:24-54`; `src/api/sandbox.ts:117-119`; `src/api/types.ts:207`
  (inherited upstream `TODO(kt3k)` on `Timeline.active_revision`).
- **`port` create option** — cloud-specific; no local equivalent; terminal Tier C.
  `[deferred · S · non-goal]` — `src/api/sandbox.ts:34`; `testing/mod.ts:970-976`.

---

## Fastest path to 1.0

The critical chain is **M8 → M10 networking → M11 real soak → M12**:

1. **M8 real `SandboxProvider`** is the single biggest unblock — it turns the
   fake-only Tier A into a live path and is the dependency for the parity-against
   -real suite, the HttpClient plane, fs.upload/download, DenoRepl, and every
   create-path option (memory/env/labels/extendTimeout). The in-flight M7
   ticket-burn + bridge-UDS split and the `openTunnel` credential plumbing must
   land first (they gate the tunnel the provider dials through).
2. **M10 "wire allowNet into launch"** is the networking linchpin: TAP/netns +
   NIC config + `applyAllowNet` + `EgressReclaimHook` registration. It unblocks
   `exposeHttp`, the four egress-hardening items, the dnsmasq/ipset wildcard
   path, `usage()` net counters, and completes the reconcile reclaim coverage.
3. **M11 real soak (`soak:vm`)** cannot start until a real create/use/terminate
   backend exists over the M8 agent plane *and* a KVM CI runner is stood up; it
   is the literal 1.0 bar and also surfaces the resource-enforcement and
   structured-logging/diagnostics gaps.
4. **M12** (version bump off 0.0.0, tag-driven JSR publish + provenance, publish
   dry-run + doc-score gates, README/exports polish) is mechanical once M8's SDK
   surface is real and the board is green.

**Genuinely parallelizable off the critical chain:**
- CI infrastructure (KVM runner job, compile-smoke for daemons/agent, scheduled
  cron for T4/soak, wiring `qualify:*` and the `wire:check` reproduction leg) can
  be built now — it's the substrate M5/M11 exits need and blocks nothing else.
- Guest uid-drop + `pivot_root` hardening, the two-daemon socket
  privilege-boundary chmod/chown, artifact-cache GC triggering, and pinned-TLS
  are independent hardening items that can proceed alongside M8.
- The M12 mechanical bits (version bump, `./unstable-host` export split,
  publish-guard task) can be prepped ahead of the green board.
- Tier C stubs need no work beyond keeping them compiling against upstream drift.
