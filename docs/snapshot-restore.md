# Snapshot-restore fast-create (warm templates)

**Status:** DESIGN. No source changed by this document.\
**Goal:** cut `Sandbox.create()` from the ~3.7 s cold boot to sub-second by
restoring each sandbox from a pre-booted **warm-template** Firecracker snapshot
instead of cold-booting a fresh microVM. Snapshot is an **opt-in launch
strategy**: cold boot stays the default and the fallback (M11 proved it
leak-free); snapshot is selected by config, and `Sandbox.create()` semantics are
**byte-identical** between the two strategies.

This doc is a precise, buildable plan. Every current-state claim cites
`file:line`; every `@nullstyle/firecracker` shape is confirmed against the
pinned package via `deno doc "jsr:@nullstyle/firecracker@^0.2"` (0.2.0) — not
from memory.

---

## Executive summary (read this first)

- **Template lifecycle.** Cold-boot **one** template VM per golden manifest hash
  in a new "template mode": studioboxd up on vsock, Deno+capnp warm, an `eth0`
  NIC device present but **unconfigured**, and holding **no credential**. Pause
  it (`Machine.pause`), snapshot it (`Machine.snapshot({pause})` → `snapshot` +
  `mem` files), copy `{snapshot, mem, overlay.ext4}` out to
  `<cache>/templates/<hash>/`, kill it. The template is manifest-specific and is
  rebuilt whenever the golden set changes. Disk cost ≈ one guest-RAM mem image
  (~512 MiB) + a sparse overlay per hash.
- **The crux — per-restore personalization.** Every restore shares one
  snapshot's guest memory, so identity **cannot** be baked at boot (today's
  `studiobox.token` / `studiobox.ip` kernel cmdline,
  `launch_planner.ts:300-318`, `overlay-init.sh:71-99`). Instead rootd injects
  it **after restore+resume** over the in-jail vsock via a new pre-auth
  bootstrap method `personalize(...)` carrying
  `{credential, bootNonce, sandboxId, guestNetwork}`. studioboxd boots in a
  pre-personalization state that accepts **only** `personalize` (rejects
  `authenticate`/`agent`), and on `personalize` sets the credential the tunnel
  client must later present and reconfigures `eth0` in-band (`ip addr/route`,
  `/etc/resolv.conf`), then serves normally.
- **The restore call.** Stage `snapshot`+`mem`+`rootfs`(ro,shared)+a **copy of
  the template overlay** into the fresh jail → provision this sandbox's network
  exactly as cold (TAP `sbxtap<slot>` + egress + dnsmasq) → `Machine.restore`
  with
  `snapshot: { snapshot_path, mem_backend:{backend_type:"File"}, resume_vm:
  true, network_overrides:[{iface_id:"eth0", host_dev_name:"sbxtap<slot>"}],
  vsock_override:{uds_path:"v.sock"}, clock_realtime:true }`
  → rootd dials the restored vsock and calls `personalize(...)` → ready.
- **Security verdict: first-connection-personalize is SAFE.** Before
  personalization only rootd can reach the restored VM's vsock (it lives in the
  jail chroot, reachable only as root); the bridge UDS the client uses is
  `0700 root` and is not even created until the sandbox is `ready`
  (`main.ts:683-687`, `supervisor_core.ts:588` gates `openBridge` on ready).
  `personalize` is one-shot, each restore's credential+bootNonce are freshly
  minted (no shared secret to replay), and a never-personalized restore is
  reaped by the same destructive reconcile that reaps a never-ready cold boot.
- **Strategy seam + fallback.** Selection is a rootd `--launch-config` option
  (`launchStrategy: "cold" | "snapshot"`, default `cold`) resolved **below**
  `SupervisorApi.launch` in the planner/core — hostd, the SDK, and the wire
  never see it. If restore/personalize fails, the core **falls back to a cold
  boot for that create**, reusing the already-provisioned network, so a template
  problem never fails a create.
- **Latency win.** Restore ≈ **restore+resume + network provision + personalize
  + per-restore staging copies**. MEASURED end-to-end (client → hostd → rootd,
  fc-smoke aarch64): cold ≈ 5.4 s, restore ≈ 3.3-3.6 s — a **~1.6× win in 1.0
  copy-mode**, where the per-restore 512 MiB mem + 256 MiB overlay copies (ext4,
  no reflink) dominate. The larger win the restore OPERATION alone promises
  (~0.5 s, skipping kernel boot + Deno cold-start) is diluted by the shared
  create pipeline and gated on the **shared-read-only-mem COW optimization**
  (§6, post-1.0) that deletes the mem copy. It pairs naturally with a future
  pre-warm pool (`PLAN.md:291`).
- **Work order (serialization point = the schema change).** WI-1 `personalize`
  schema + codegen + wire ratchet + golden **rebake** (forced because the
  compiled studioboxd embeds the schema hash into its `ContractIdentity`, and
  the agent-binary sha is part of the manifest hash — `service.ts:157-175`,
  `manifest.ts:280-292`). Then WI-2 template-mode studioboxd + WI-3 overlay-init
  template branch + WI-4 adapter `restore` (parallel); WI-5 template builder;
  WI-6 snapshot planner + core restore/personalize/fallback; WI-7 strategy seam;
  WI-8 fc-smoke validation.
- **Top open decisions (recommendations).** Mem backend **File** for 1.0 (Uffd
  needs an external page-fault handler Deno cannot host); template build **lazy
  on first snapshot create**, persistently cached, with an optional explicit
  prewarm; personalize as a **bootstrap method** (not a separate channel);
  **network out of the template** (bake a single IP → conflict); **netless
  always cold** for 1.0; validate a **shared read-only mem** (COW) optimization
  in fc-smoke to delete the per-restore mem copy.

---

## 0. The hard constraint, and why it dictates the whole design

Every restore is a fresh VMM loading the **same** snapshot's guest memory. So
any per-sandbox identity that lives **in guest memory at snapshot time** is
shared by every restore — a security break (one credential for all) and an IP
conflict (one guest IP for all).

Today identity is baked **at boot**, into memory, from the kernel cmdline:

- the credential: `studiobox.token=<hex>` is put on the cmdline by the planner
  (`launch_planner.ts:301`), parsed by `overlay-init.sh:74`, materialized to
  `/run/studioboxd.token` (`overlay-init.sh:113-114`), and read by studioboxd
  `--token-file` (`agent/main.ts:186-191`, `readCredentialFile` 206-225). It is
  the shared secret `AgentBootstrap.authenticate` checks constant-time
  (`agent/service.ts:1522-1540`).
- the network: `studiobox.ip/gw/dns` on the cmdline
  (`launch_planner.ts:315-317`) configure `eth0` in `overlay-init.sh:92-99` and
  write `/etc/resolv.conf` (`overlay-init.sh:118-121`).

A snapshot captures all of that in memory. **Therefore per-sandbox identity must
move out of boot and be injected after restore.** That injection is
`personalize` (§2). Everything else in this design exists to make that injection
correct, safe, and leak-free.

---

## 1. Warm-template lifecycle

### 1.1 What the template is

A template is a **paused, un-personalized** microVM captured to disk, specific
to one golden **manifest hash** (`images/manifest.ts` — the same hash that keys
the artifact cache, `images/cache.ts:182 setPath`). It is:

- studioboxd running and serving on AF_VSOCK cid 3 port 1024
  (`launch_planner.ts:66` `DEFAULT_AGENT_VSOCK_PORT`, `agent/main.ts:241-272`);
- Deno + the capnp WASM session core loaded and warm (studioboxd has already
  imported them — this is where most of the cold 3.7 s goes);
- **not** holding a real credential (template mode; §2.2);
- with the overlayfs mounted (`overlay-init.sh:53-63`) and chrooted
  (`overlay-init.sh:124`), i.e. exactly the runtime state a normal boot reaches
  **minus** the personalization;
- with an `eth0` NIC **device present but unconfigured** (link may be up, but no
  IP / route) so `network_overrides` has an interface to re-point on restore
  while no committed guest IP is baked into memory (§1.4).

### 1.2 Template artifacts on disk

Store per hash, alongside the golden set the cache already keys by hash
(`images/cache.ts:45-47` `vmlinux`/`rootfs.ext4`):

```
<cache>/templates/<manifestHash>/
  snapshot         # Firecracker snapshot state file (SnapshotCreateParams.snapshot_path)
  mem              # guest memory image  (SnapshotCreateParams.mem_file_path)   ~= mem_size_mib
  overlay.ext4     # the EXACT overlay the template VM had mounted at snapshot time (§3)
  template.json    # {manifestHash, arch, vcpu, memMib, vsockPort, builtAt, fcPinned}
```

The template's lifetime is tied to the manifest hash's artifact refcount:
acquire the golden set's refcount when a restore plan resolves (mirroring cold,
`launch_planner.ts:269 #cache.acquire`) so GC (`images/cache.ts`) never reaps a
set — or its template — while a live restore references it.

### 1.3 When to build it (recommended: lazy-first-use, persistently cached)

- **Lazy on first snapshot-strategy create** for a given manifest hash: if
  `<cache>/templates/<hash>/` is absent (or fails validation), build it once
  under a per-hash build lock, cache it, and every subsequent restore reuses it.
- Optional **explicit prewarm**: a `deno task template:build --arch … --hash …`
  (new, WI-5) that a deploy can run so the very first create is already fast.
- **Not** eager-at-rootd-start: that adds startup latency and builds templates
  that may never be used. (Alternative discussed in §9.)

Rebuild trigger: the template is keyed by manifest hash, so **any** golden-set
change (kernel/rootfs/overlay-init/guest-Deno/agent-binary pin —
`manifest.ts:280-292`) lands under a **new** hash and the old template simply
stops being referenced (and is GC'd with its set). No explicit invalidation is
needed; a new hash means a new template dir.

### 1.4 The template's placeholder network

The template VM must have an `eth0` device at snapshot time (else
`network_overrides` has nothing to override on restore — the override re-points
an existing NIC, it cannot add one; confirmed by
`NetworkOverride:{host_dev_name,
iface_id}` in the pinned schema, deno doc
`SnapshotLoadParams.network_overrides`). So the builder:

1. provisions a throwaway **placeholder host TAP** (e.g. `sbxtap-tmpl`) so the
   template's virtio-net has a backend to attach to at boot;
2. boots the template with a NIC
   (`network_interfaces:[{iface_id:"eth0",
   host_dev_name:"sbxtap-tmpl", guest_mac:…}]`,
   same shape as `launch_planner.ts:350-358`) but **does not** put
   `studiobox.ip/gw/dns` on the cmdline — so `overlay-init` leaves `eth0`
   **down/unconfigured** (`overlay-init.sh:92` gates all eth0 config on a
   non-empty `GUEST_IP`);
3. after snapshot, tears the placeholder TAP down. Restores never use it — each
   restore's `network_overrides` re-points `eth0` to its own `sbxtap<slot>`.

Net effect: the snapshot carries a NIC device but **no guest IP in memory**, so
there is no per-sandbox network identity to conflict — `personalize` supplies it
(§2.3).

### 1.5 Build sequence (fc-smoke; jailed, root)

Using the pinned package (deno doc: `Machine.launch`, `pause`, `snapshot`,
`Machine.restore`):

1. Stage `vmlinux` + `rootfs.ext4`(ro) + a **freshly-formatted empty**
   `overlay.ext4` into a template jail (copy mode, `adapter.ts:231-238`).
2. `Machine.launch` the template with cmdline
   `console=ttyS0 quiet … root=/dev/vda ro init=/sbin/overlay-init
   studiobox.vsock_port=1024 studiobox.mode=template`
   (no token, no ip) and the placeholder NIC +
   `vsock:{guest_cid:3, uds_path:"v.sock"}` (`launch_planner.ts:347`).
3. Wait for template readiness: dial the vsock and run only `negotiate`
   (verifies the guest's `ContractIdentity` — schema hash, firecracker pin —
   matches; `agent/service.ts:1558-1589`). Do **not** authenticate (there is no
   credential yet).
4. `Machine.pause()` (deno doc `pauseVm`), then
   `Machine.snapshot({ snapshot_path:
   "/snapshot", mem_file_path: "/mem", snapshot_type: "Full" })`
   — jailed, so these are **in-jail** paths (deno doc `Machine.snapshot`:
   "jailed machines take in-jail paths"); Firecracker requires a paused VM (deno
   doc note).
5. Copy `<jail>/snapshot`, `<jail>/mem`, and the template's `overlay.ext4` out
   to `<cache>/templates/<hash>/` (sparse-aware copy for `mem`/`overlay`); write
   `template.json`.
6. `Machine.kill()` + dispose (`adapter.ts:207-228`); tear down `sbxtap-tmpl`.

Resource cost of a live template between build and kill: one paused VM's memory
(≈ `mem_size_mib`, default 512 MiB — `launch_planner.ts:232 #memSizeMib`). On
disk afterward: the `mem` image (~512 MiB) + the sparse `overlay.ext4` (a few
MiB)

- the small `snapshot` state file, per hash.

---

## 2. Per-restore personalization — the crux

### 2.1 The wire (SCHEMA CHANGE → codegen + ratchet + golden rebake)

Add a pre-auth method to `AgentBootstrap` in `schema/sandbox_agent.capnp`
(current interface `sandbox_agent.capnp:255-261`). capnp ordinals are
append-only, so `personalize` is `@3`:

```capnp
struct GuestNetwork {
  guestCidr @0 :Text;   # e.g. 10.201.0.2/30 ; EMPTY ⇒ netless (leave eth0 down)
  gateway   @1 :Text;   # host TAP address (10.201.<t>.<b+1>)
  dns       @2 :Text;   # per-sandbox dnsmasq (written to /etc/resolv.conf)
}

struct PersonalizeParams {
  credential @0 :Data;        # per-restore authenticate secret (32 bytes)
  bootNonce  @1 :Data;        # per-restore boot nonce (bound like the cold path)
  sandboxId  @2 :Text;        # bound sandbox id
  network    @3 :GuestNetwork;# in-band eth0 config (empty guestCidr ⇒ netless)
}

struct PersonalizeAck {
  buildId       @0 :Text;     # echoes studioboxd buildId for the caller's log
  appliedCidr   @1 :Text;     # empty when netless
}

struct PersonalizeResult {
  union {
    ok    @0 :PersonalizeAck;
    error @1 :Common.SbxError;
  }
}

interface AgentBootstrap {
  negotiate   @0 (offer :Common.ProtocolOffer) -> (result :Common.HandshakeResult);
  authenticate@1 (credential :Data, sandboxId :Text, bootNonce :Data)
                -> (result :Common.AuthResult);
  agent       @2 () -> (agent :SandboxAgent);
  personalize @3 (params :PersonalizeParams) -> (result :PersonalizeResult);  # NEW
}
```

`network.guestCidr` empty ⇒ netless — this mirrors the existing cmdline contract
exactly (`overlay-init.sh:92` gates on non-empty `GUEST_IP`), so no separate
"netless" flag is needed.

**Regen procedure (identical to recent milestones):**

1. edit `schema/sandbox_agent.capnp`;
2. `deno task wire:generate` (regenerates
   `src/wire/generated/sandbox_agent_*.ts` via the sibling capnpc-deno toolchain
   — `deno.json` task, `compat/wire.json:26` `invocation`);
3. `deno task wire:check` (`tools/check_wire.ts`) — the byte-identical-regen +
   strict-typecheck ratchet over all six committed schemas
   (`compat/wire.json:28-35`);
4. re-hash `compat/wire.json.schemaSha256` (`compat/wire.json:15`) and append a
   note to `schemaSha256Note` (`:16`).

**This forces a golden REBAKE.** studioboxd's `ContractIdentity.schemaHash` is
read from `compat/wire.json` at build time (`agent/service.ts:157-175`,
`schemaHash` at `:164`), so a new `schemaSha256` changes the **compiled
studioboxd bytes** (`deno task agent:compile`). The agent binary's sha256 is a
manifest input pin (`manifest.ts:280-292 manifestPins` includes `agentBinary`;
`manifest.ts:337 overlayInitSha256`), so the manifest hash rolls, the golden set
lands under a new hash, and the **template must be rebuilt** under that hash.
This is why WI-1 is the serialization point (§8): every downstream item runs
against the rebaked set.

### 2.2 studioboxd's side: template mode + personalization state

**Boot in template mode.** `overlay-init` execs studioboxd with a `--template`
flag and **no** `--token-file` (§3). `agent/main.ts` today requires
`--token-file` (`main.ts:186-191`) and reads it before serving
(`main.ts:362-364`); template mode makes it optional and starts studioboxd in a
**pre-personalization** state.

**A process-global `PersonalizationController`** (new, in `agent/service.ts` or
a new `agent/personalize.ts`) holds the mutable identity that today is immutable
`AgentWireOptions.credential` (`agent/service.ts:1481`):

```
state: "pending" | "personalized"
credential: Uint8Array | null        // null while pending
expectedSandboxId?: string
expectedBootNonce?: Uint8Array
```

- **`pending` (template mode):** `authenticate`/`agent` are **rejected**
  (`failedPrecondition` "not yet personalized"); `personalize` is **accepted
  once**.
- **`personalized` (serving mode):** `personalize` is **rejected**
  (`failedPrecondition` "already personalized"); `authenticate`/`agent` proceed
  and check the now-set credential + sandboxId + bootNonce exactly as today
  (`credentialAccepted`, `agent/service.ts:1522-1540`).

`credentialAccepted` changes from reading a fixed `options.credential` to
reading `controller.credential` (and `controller.expectedSandboxId` /
`expectedBootNonce`). A `null` credential still fails every authentication
closed (`agent/service.ts:1526-1527`), which is exactly what we want while
pending.

**The `personalize @3` handler** (added to the `AgentBootstrapServer` bootstrap
object, `agent/service.ts:1558-1640`):

1. require this connection's gate to be `negotiated` (`bootstrap_gate.ts:47-56`)
   — i.e. `negotiate` ran and the `ContractIdentity` matched, so the caller and
   guest agree on the exact schema build. (personalize before negotiate ⇒
   `failedPrecondition`.)
2. require `controller.state === "pending"` — else reject
   `already personalized`.
3. validate `credential` (32 bytes), `bootNonce`, `sandboxId`.
4. **apply the network in-band** (when `network.guestCidr` non-empty): run, as
   root in the guest (overlay-init execs studioboxd as a pid-1 descendant
   without dropping uid — `overlay-init.sh:124`, so studioboxd holds
   `CAP_NET_ADMIN`, and `iproute2` is in the rootfs — `images/pins.json`
   packages):
   - `ip addr flush dev eth0`
   - `ip addr add <guestCidr> dev eth0`
   - `ip link set eth0 up`
   - `ip route replace default via <gateway>`
   - write `nameserver <dns>` to `/etc/resolv.conf` These replace
     `overlay-init.sh:92-121` for the snapshot path. `flush` first is
     load-bearing: even though the template leaves `eth0` unconfigured (§1.4), a
     flush makes personalize idempotent-safe against any residual state.
5. set `controller.credential/expectedSandboxId/expectedBootNonce`, flip
   `state → "personalized"`, return `ok(PersonalizeAck)`.

The single vsock listener and accept loop (`agent/main.ts:441-477`) are
unchanged — template mode differs only in the initial controller state and the
extra handler.

### 2.3 rootd's side: dial → personalize → ready

Extend the host dialer (`src/rootd/agent_dialer.ts`) with an
`openPersonalizeSession` (or a `personalize` step in a restore-specific dial):
open the vsock, run `negotiate` (bounded, exactly like `openAgentSession`,
`agent_dialer.ts:112-127`), call
`bootstrap.personalize({credential, bootNonce, sandboxId, network})` (bounded
like the other steps), check `result.which === "ok"`, close. rootd mints
`credential`/`bootNonce` fresh per restore (CSPRNG, `launch_planner.ts:237-238`,
32 bytes) — the same minting the cold path already does.

In the core (`supervisor_core.ts` `#launch`), the restore branch replaces the
cold "dial + close" readiness probe (`supervisor_core.ts:338-341`) with "dial +
personalize"; `ok` ⇒ transition `booting → ready` (`:342-347`); a personalize
failure or timeout ⇒ `machine.kill()` + dispose + throw (mirrors the cold path's
"agent never answered" handling, `:348-356`), which drives the record terminal
and reclaims via the hooks (§4). The minted `credential` is remembered per
execution exactly as today (`supervisor_core.ts:361-366 #agentCredentials`) so
`openBridge` returns it (`supervisor_core.ts:597-606`) and the tunnel client can
authenticate — no change to the bridge/tunnel path.

### 2.4 Security analysis (critical)

**Reachability boundary — who can reach the restored vsock before
personalization?**

- The restored VM's vsock UDS lives **inside the jail chroot** (in-jail name
  `v.sock`, `launch_planner.ts:74`). Only **rootd**, as root, reaches it — it
  dials via `machine.vsock.connect` (`adapter.ts:162-176`, deno doc
  `Machine.vsock.connect`, which resolves the host path under the chroot). The
  jailer confines it; an unprivileged process cannot open it.
- The **client** path never touches the vsock directly. hostd (unprivileged)
  dials a **bridge UDS** under `BRIDGE_SOCKET_ROOT`, created `0700 root`
  (`main.ts:683-687`), and rootd's `BridgeServer` splices it to the guest vsock
  (`main.ts:689-710`, `supervisor_core.ts:628-649 connectBridge`). That bridge
  is **only created after an `openBridge` grant**, and `openBridge` requires the
  sandbox to be **`ready`** (`supervisor_core.ts:588 #requireReadyAndLive`). We
  do not mark `ready` until `personalize` returns `ok` (§2.3). So **no bridge —
  hence no client reachability — exists before personalization**.

**Verdict: "first vsock connection personalizes" is SAFE**, because the only
party that can make that first connection before `ready` is rootd itself.

Sub-analyses:

- **Can a client personalize?** No. The client can only reach studioboxd via the
  bridge, which does not exist until `ready` (post-personalize). And once
  personalized, `personalize` is rejected (`already personalized`, §2.2), so
  even if a client somehow reached the vsock later it could not re-personalize.
  The safety rests on **reachability** (rootd-only pre-ready), not on a wire
  secret.
- **Can two rootd calls race?** No. `SupervisorCore` serializes per execution
  (`#inflight`, `supervisor_core.ts:272-281`), so one launch owns one execution.
  `personalize` is additionally one-shot on the guest (`state` check), so a
  duplicate is rejected rather than swapping the credential mid-life.
- **Replay?** Each restore mints a **fresh** `credential`+`bootNonce`
  (`launch_planner.ts:237-238`); the snapshot memory holds **no** credential
  (template mode), so there is no shared secret to replay across restores.
  `bootNonce` binding (`agent/service.ts:1535-1538`) is preserved.
- **A restore that never gets personalized (leak/timeout)?** rootd bounds the
  personalize step (like the dial, `agent_dialer.ts:44-45`) and kills the VM on
  failure (§2.3). If rootd crashes between restore and personalize, the record
  is journaled `booting` with its resources (`supervisor_core.ts:311-322`), and
  the destructive restart reconcile SIGKILLs the orphan VMM and runs the reclaim
  hooks (`supervisor_core.ts:742-823`) — identical to a never-`ready` cold boot.
  No new leak class.
- **Shared-memory entropy (new, snapshot-specific).** Every restore resumes with
  an **identical** guest RNG/entropy pool (same memory image). Mitigate by (a)
  configuring a **virtio-rng entropy device** in the template (deno doc
  `putEntropyDevice`) so the guest reseeds after resume, and (b)
  `clock_realtime:
  true` on load (§4) so time-based seeds differ. Flag: any
  in-guest secret generated **before** snapshot is shared — the template must
  generate **no** long-lived secret before the snapshot point (it holds none by
  construction: no credential, no per-sandbox state). This is why the credential
  is injected **after** restore, not merely re-read.
- **Cross-restore isolation.** Each restore is a **separate VMM** with its own
  memory (mapped from the shared `mem` file); a workload in one restore cannot
  read another's memory. And no untrusted workload runs before personalize —
  workloads spawn via the `SandboxAgent` (`agent/service.ts:1412-1464`),
  reachable only after `authenticate`, which is after `personalize`.

---

## 3. The overlay (byte-identical, per-restore copy)

The snapshot's memory has the overlayfs **mounted** (`overlay-init.sh:53-63`
mkfs+mount, then `overlay-init.sh:61-63` mounts overlayfs, then chroot at
`:124`). The in-memory mount state references the exact ext4 superblock,
journal, and `upper`/`work` inodes present at snapshot time. If a restore's
`/dev/vdb` (the overlay drive, `launch_planner.ts:341-345`) diverged from that
image — e.g. a fresh `mkfs.ext4` — the mounted filesystem in memory would
reference blocks the new device does not have: **corruption**.

**Design:**

1. Snapshot the template with a **freshly-formatted, empty** overlay (the
   builder stages a fresh sparse `overlay.ext4`; `overlay-init` formats it once
   — `overlay-init.sh:54-57` — and mounts it; studioboxd writes little/nothing
   in template mode). Capture **that exact** `overlay.ext4` as the template
   overlay (§1.5 step 5).
2. Each restore's jail gets a **byte-for-byte copy** of that template overlay
   (not a fresh mkfs). Writes then diverge per-restore into the overlayfs
   `upper` dir on that private copy — full isolation, no shared writeback.

Contrast with the cold path, which stages a fresh **unformatted** sparse overlay
that `overlay-init` formats on first boot
(`launch_planner.ts:508-533
#createOverlay`, `overlay-init.sh:54-57`). The
snapshot path **cannot** do this — the guest already formatted+mounted at
snapshot time.

**Copy cost + staging.** The template overlay is nominally 256 MiB
(`launch_planner.ts:68 DEFAULT_OVERLAY_SIZE_BYTES`) but **mostly sparse** (fresh
ext4 + `upper`/`work` dirs ⇒ a few MiB allocated). Stage it into the fresh jail
with a **sparse-aware copy** (`SEEK_HOLE`/`SEEK_DATA`, or `cp --sparse=always`);
guest ext4 has no reflink, so a hole-preserving copy is the cheap primitive
(~tens of ms). The jailer stages via **copy mode** (the adapter forces it,
`adapter.ts:29,231-238`), so per-jail copy is already the contract; the planner
just points the overlay stage entry at `<cache>/templates/<hash>/overlay.ext4`
instead of at a freshly-created file. The per-restore overlay copy is journaled
as `resources.overlayPath` and reclaimed by `ArtifactReclaimHook`
(`launch_planner.ts:590-606`) exactly as the cold overlay.

---

## 4. The restore launch path (the fast path)

Confirmed against the pinned package (deno doc):
`Machine.restore(options:
RestoreOptions)`;
`RestoreOptions = DirectRestoreOptions | JailedRestoreOptions`;
`JailedRestoreOptions extends CommonRestoreOptions` with `jailer: JailerOptions`

- `registry` (required); `CommonRestoreOptions.snapshot: SnapshotLoadParams`
  (snapshot/mem paths are **in-jail** when jailed — deno doc). Field shapes
  (pinned schema):
  `SnapshotLoadParams = { snapshot_path, mem_backend?:
MemoryBackend, mem_file_path?, network_overrides?: NetworkOverride[], resume_vm?,
vsock_override?: VsockOverride, clock_realtime?, enable_diff_snapshots?,
track_dirty_pages? }`;
  `MemoryBackend = { backend_path, backend_type:
"File"|"Uffd" }`;
  `NetworkOverride = { host_dev_name, iface_id }`;
  `VsockOverride
= { uds_path }`. `vsock_override` is **@since v1.16**; the
  pinned Firecracker is **v1.16.1** (min v1.15.0 —
  `docs/firecracker-contract.md:8,55`), so it is available on the pinned binary
  (see the version gate in §5).

**Sequence** (rootd, jailed, root — mirrors `supervisor_core.ts:284-381` cold
`#launch` with a restore branch):

1. Resolve the restore plan (WI-6): acquire the golden/template refcount
   (`launch_planner.ts:269`), mint `credential`+`bootNonce` (`:237-238`), and
   **provision this sandbox's network exactly as cold**
   (`launch_planner.ts:426-476 #provisionNetwork` — TAP `sbxtap<slot>`, egress
   seal, dnsmasq; unchanged). Journal `resources` (`supervisor_core.ts:311-322`)
   BEFORE spawn.
2. Stage into the fresh jail (copy mode): `snapshot`, `mem`, `rootfs.ext4`(ro,
   shared read-only across sandboxes — same as cold
   `launch_planner.ts:378-386`), and a **copy** of the template `overlay.ext4`
   (§3).
3. `Machine.restore` (jailed) with:

   ```
   {
     jailer: { …same as launch_planner.ts:369-376… id: executionId },
     registry: <CreateOnlyVmRegistry>,          // journal-before-spawn, as always jailed
     snapshot: {
       snapshot_path: "/snapshot",              // in-jail path
       mem_backend: { backend_type: "File", backend_path: "/mem" },
       resume_vm: true,                         // come back "running", not "paused"
       clock_realtime: true,                    // correct guest wall-clock on load
       network_overrides: [
         { iface_id: "eth0", host_dev_name: "sbxtap<slot>" }  // re-point NIC to this TAP
       ],
       vsock_override: { uds_path: "v.sock" }   // rebind host-side vsock UDS in THIS jail
     }
   }
   ```

   No `VmConfig` is applied — the snapshot carries the machine config (deno doc
   `Machine.restore`: "No VmConfig applies — the snapshot carries the
   configuration"). Restored VMs come back `running` because `resume_vm` is set
   (deno doc), open host vsock connections are gone but the **guest listener
   survives** (deno doc `CommonRestoreOptions.snapshot`) — so studioboxd is
   already listening.
4. **Dial + personalize** (§2.3): `machine.connectVsock(1024)` → `negotiate` →
   `personalize({credential, bootNonce, sandboxId, guestNetwork})`.
   `guestNetwork` is derived from the same `SubnetAllocation` that provisioned
   the TAP (`allocator.ts:150-183`: `guestCidr` = `10.201.<t>.<b+2>/30`,
   `gateway` = `hostIp` `.<b+1>`, `dns` = the per-sandbox dnsmasq on the
   gateway).
5. `ok` ⇒ transition `booting → ready` (`supervisor_core.ts:342-347`), track the
   machine + credential (`:357-366`). The sandbox is now indistinguishable from
   a cold-booted one to everything above.

**Journaling + reclaim are identical to cold.** The restore records the same
`SandboxResources` (`model.ts:84-102`:
`tapName/hostIp/guestIp/subnet/
dnsmasqPidfile/overlayPath/exposedPorts`).
Terminate/kill (`supervisor_core.ts:839-900`) and the destructive reconcile
(`:742-823`) reclaim via the existing hooks — `NetworkReclaimHook`
(TAP/egress/dnsmasq/slot) then `ArtifactReclaimHook` (overlay copy + refcount) —
with **no** new reclaim logic (`main.ts:583-588` registration order preserved).

**Jailer/pidfile authority for a restored VMM.** `Machine.restore` spawns a
**fresh** jailed VMM, so `machine.pid` is pidfile-derived exactly as for a
launched jailed machine (deno doc `Machine.pid`: "pidfile-derived for reparented
jailed modes"), and the `JailRecord` is journaled before spawn via the same
`registry` (deno doc `JailedRestoreOptions.registry` "required … journal
committed before spawn"). So liveness, `reconcile`, and orphan-kill treat a
restored VMM identically to a cold one (`adapter.ts:69-113` launch path,
`:116-131` reconcile) — there is no separate authority to build.

---

## 5. The launch-strategy seam

### 5.1 Selection (default cold)

Selection lives **below** `SupervisorApi.launch`, in the planner + core — hostd,
the SDK, `schema/supervisor.capnp`, and the client see nothing (this is what
makes `Sandbox.create()` byte-identical). Add to `LaunchPlannerConfig`
(`main.ts:394-406`):

```
launchStrategy?: "cold" | "snapshot"   // default "cold"
templateCacheDir?: string              // where <hash>/templates live (default under artifactCache)
```

`loadLaunchPlanner` (`main.ts:542-604`) wires the strategy into the planner.
When `snapshot`, the planner resolves a **restore plan** (§4); when `cold` (or
unconfigured), it resolves today's cold plan (`launch_planner.ts:256-416`),
unchanged.

### 5.2 The plan shape

`SupervisorLaunchPlan` (`supervisor_core.ts:70-111`) becomes a discriminated
union so the core can branch:

- **cold:** carries `config: VmConfig` + `stage` (today's shape).
- **snapshot:** carries `restore: { snapshot: SnapshotLoadParams }` + `stage`
  (snapshot/mem/rootfs/overlay-copy) + a **`fallbackCold`** recipe (a cold
  `config` + a fresh-overlay stage entry) for §5.3.

Both carry the shared `jailer`, `resources` (network), `agentVsockPort`,
`agentCredential`, `artifact` fields already present
(`supervisor_core.ts:71-111`). `SupervisorCore.#launch` branches on the
discriminant: `restore` → §4 path; `config` → today's `adapter.launch`
(`supervisor_core.ts:323-332`).

The adapter needs a `restore(request)` sibling to `launch` (WI-4): add
`restore(options: RestoreOptions): Promise<RuntimeMachine>` to
`FirecrackerRuntime` (`runtime.ts:36-43`) mapping to `Machine.restore`, and
`FirecrackerAdapter.restore` (`adapter.ts:69-113` twin) with the same
`executionId`/registry/metadata wiring and cleanup-on-failure reconcile.

### 5.3 Fallback (a template problem never fails a create)

If restore or personalize fails with a **restore-specific** typed error (missing
/ invalid template, `Machine.restore` API error, personalize timeout), the core
**falls back to a cold boot for that same create**:

1. `machine.kill()` + dispose the failed restore VMM (network stays provisioned
   and journaled — it is generic per-sandbox, not restore-specific).
2. Cold-boot a fresh VMM with the plan's `fallbackCold` config, **reusing the
   same `SubnetAllocation`** (same `sbxtap<slot>`, egress, dnsmasq — already up)
   and a **fresh unformatted** overlay (cold semantics, `#createOverlay`),
   baking the already-minted `credential` on the cmdline (`studiobox.token`,
   `launch_planner.ts:301`) — so cold readiness (`supervisor_core.ts:338-341`)
   proves it, no personalize needed.
3. Proceed `booting → ready` as cold.

This keeps the create atomic and never strands network/overlay. The alternative
(fail the create and let hostd retry cold) is worse UX and is rejected (§9). The
first fallback should **also** mark the template dir suspect (log + optionally
quarantine the template file) so a corrupt template does not fall back on every
create — but that repair is out of the create's critical path.

### 5.4 Composition with netless

Recommended for 1.0: **netless always cold.** A netless sandbox has no NIC and
no TAP, but the template carries an `eth0` device for `network_overrides`
(§1.4). A netless restore would need either a second **netless template** (no
NIC) per hash or a restore that skips `network_overrides` on a NIC-carrying
snapshot (guest `eth0` then references a gone backend). Both add cost for a rare
case; netless is uncommon and cold-booting it is already fast (no network
provisioning). So: when `request.netless === true` (`launch_planner.ts:430`),
the planner resolves a **cold** plan regardless of `launchStrategy`. (A netless
template variant is a clean post-1.0 addition — §9.)

### 5.5 Firecracker version gate

The snapshot strategy **requires** `vsock_override` (@since v1.16). The compat
window is `{ pinned: "v1.16.1", min: "v1.15.0" }`
(`docs/firecracker-contract.md:8,55`). So a host running the **min** (v1.15)
must **not** select snapshot. `loadLaunchPlanner` should verify the actual
firecracker binary version (studiobox already reads `FIRECRACKER_COMPAT` and
verifies binaries at setup — `docs/firecracker-contract.md:54-57`) and refuse
`launchStrategy: "snapshot"` (fail-closed to cold) below v1.16.

---

## 6. Latency + resource model

**Cold baseline ≈ 3.7 s** (kernel boot + `mkfs.ext4` the overlay + Deno/capnp
warm-up + studioboxd start + agent dial). Copy staging of the golden set is a
known contributor (`PLAN.md:321` R3).

**Restore create, component estimate:**

| Step                                                        | Est.        | Notes                                                                          |
| ----------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| Stage `snapshot`+`mem`+`overlay` copy into jail             | ~100-300 ms | `mem` ~512 MiB copy dominates (warm page cache); §6 optimization can remove it |
| Network provision (TAP+egress+dnsmasq)                      | ~50-150 ms  | identical to cold `#provisionNetwork`                                          |
| `Machine.restore` (spawn fc + `loadSnapshot` File + resume) | ~100-300 ms | File backend pages in lazily; no kernel boot, no `mkfs`, no Deno/capnp warm-up |
| Dial vsock + `negotiate` + `personalize` (+ in-guest `ip`)  | ~20-50 ms   | one round-trip + a few `ip` calls                                              |

**MEASURED (fc-smoke, WI-8):** end-to-end create cold ≈ 5.4 s vs restore ≈
3.3-3.6 s — a **~1.6× win in 1.0 copy-mode**. The per-restore 512 MiB mem +
256 MiB overlay copies (ext4, no reflink) dominate the restore time; the §6
shared-RO-mem COW optimization (post-1.0) that deletes the mem copy, plus a
warm-pool, are what unlock the larger win the restore operation itself allows.

**Template build cost (one-time per hash):** a full cold boot (~3.7 s) + pause +
snapshot + copy-out (~1-2 s) ≈ a few seconds, amortized across every subsequent
restore of that hash.

**Disk cost:** per hash, the `mem` image (~`mem_size_mib`, 512 MiB default —
`launch_planner.ts:232`) + a sparse `overlay.ext4` (a few MiB) + the small
`snapshot` state file. Per live restore, transiently: the staged `mem` copy (512
MiB, File approach) + overlay copy (sparse), reclaimed on terminate.

**Optimization to validate (removes the per-restore 512 MiB):** if Firecracker's
File mem backend maps guest RAM **copy-on-write (MAP_PRIVATE)** — i.e. a resumed
VM does not mutate the backing `mem` file — then all restores of a hash could
**share one read-only `mem`** file (staged by hardlink/bind read-only instead of
copy), eliminating the 512 MiB per-restore copy. This is a hypothesis to **prove
in fc-smoke** (WI-8: restore twice, diff the `mem` file, assert unchanged), and
it needs an adapter change to allow a **read-only shared** stage for `mem`
(`adapter.ts:29` currently forces copy). For 1.0, use the per-restore copy (safe
and correct). This is the natural pairing with a **pre-warm pool**
(`PLAN.md:291`) where restores draw from pre-staged jails.

**Pairs with a pre-warm pool.** Restore's fast, uniform cost makes a pool of
pre-staged, pre-restored-but-un-personalized jails trivial: personalize is the
only per-create step, so a pool member is "create-ready" the moment it is
restored — a post-1.0 follow-on this design deliberately leaves room for.

---

## 7. fc-smoke validation plan (WI-8)

All in the `fc-smoke` Lima VM (real KVM), reusing the M8 driver
(`tools/parity_vm_test.ts`) and the `SBX_VM_*` contract:

1. **Build a template.** New `deno task template:build` (WI-5) inside the guest,
   producing `<cache>/templates/<hash>/`; assert `template.json` + the three
   artifacts exist and validate.
2. **Restore a sandbox.** A new gate `tests/vm/snapshot_vm_test.ts` (or
   `parity_vm_test.ts --strategy snapshot`) launches rootd with
   `launchStrategy:"snapshot"`, creates a sandbox, and asserts it restored (not
   cold-booted) — e.g. via a rootd log marker / a `template.json` refcount bump.
3. **Prove it is faster than cold.** Measure create latency for both strategies
   on the same warm cache; assert snapshot p50/p95 are materially below cold
   (target: snapshot p95 < 1 s and < cold p50).
4. **Prove functional identity.** Run the **existing M8 parity gate**
   (`tests/vm/parity_vm_test.ts`) **against a restored sandbox** — the same
   upstream-parity fixtures (exec/fs/eval) and the network gate
   (`test:vm:network`) must pass, proving personalize produced a sandbox
   byte-identical in behavior to cold (credential auth works; `eth0` reaches its
   gateway/dnsmasq; egress seal holds).
5. **Prove leak-free.** Run the **M11 soak** (`tools/soak/soak_vm_main.ts`,
   `docs/soak.md`) with the snapshot strategy: ≥ 200 create→use→terminate cycles
   - ≥ 10× `kill -9`-mid-fleet + destructive reconcile, asserting **zero** leaks
     across all ten `LeakAudit` classes (`docs/soak.md:38-49`), plus bounded RSS
     / journal. Add a template-specific check: templates and their
     `mem`/`overlay` files are not leaked and refcounts return to zero.
6. **Security assertions.** (a) a client cannot personalize (attempt
   `personalize` over the bridge — it must not exist pre-ready; post-ready it is
   rejected); (b) two restores of the same hash have distinct credentials and
   cannot auth to each other; (c) a restore whose personalize is skipped is
   reaped by reconcile.

---

## 8. Work-item decomposition (dependency order)

`▶` = depends on. **HS** = host-safe-testable (unit/fake). **VM** =
fc-smoke-only.

- **WI-1 — `personalize` schema + codegen + wire ratchet + golden REBAKE.**
  _Touch:_ `schema/sandbox_agent.capnp`; `src/wire/generated/sandbox_agent_*.ts`
  (regenerated); `compat/wire.json` (`schemaSha256` + note). _Run:_
  `deno task
  wire:generate`, `deno task wire:check`, then rebake the golden
  set (`deno task images:build`) → new manifest hash. **HS** (codegen +
  ratchet + typecheck). **SERIALIZATION POINT — every item below runs against
  the rebaked set.**

- **WI-2 — studioboxd template mode + `personalize` handler.** ▶ WI-1. _Touch:_
  `src/agent/main.ts` (`--template` flag, optional `--token-file`, controller
  wiring, ready line); `src/agent/service.ts` (`personalize @3` handler, the
  `PersonalizationController`, `authenticate` gated on `personalized`,
  `credentialAccepted` reads the controller); new `src/agent/personalize.ts`
  (the in-guest `ip`/`resolv.conf` applier). **HS** for the wire/state machine
  (fake transport, cf. `tests/fake/agent/agent_wire_test.ts`); the `ip` apply is
  **VM**.

- **WI-3 — overlay-init template branch.** ▶ WI-1 (coordinate the rebake).
  _Touch:_ `images/overlay_init/overlay-init.sh` (`studiobox.mode=template` ⇒
  exec `studioboxd --template` with no token/ip; else today's path). Rolls
  `overlayInitSha256` (`manifest.ts:337`) — folded into WI-1's rebake. **HS**
  for the cmdline-parse logic in isolation; boot proof is **VM**.

- **WI-4 — firecracker adapter `restore` surface.** ▶ (independent of WI-1).
  _Touch:_ `src/rootd/firecracker/runtime.ts` (add `restore` to
  `FirecrackerRuntime` + `nullstyleFirecrackerRuntime` → `Machine.restore`);
  `src/rootd/firecracker/adapter.ts` (`FirecrackerAdapter.restore` twin of
  `launch`, `:69-113`, with metadata/registry/cleanup);
  `src/rootd/firecracker/mod.ts` (exports). **HS** with a fake runtime injecting
  `restore`.

- **WI-5 — template builder + artifact store.** ▶ WI-2, WI-3, WI-4. _Touch:_ new
  `tools/build_warm_template.ts` (boot template → pause → snapshot → copy-out);
  new `src/rootd/template/store.ts` (path layout `<cache>/templates/<hash>/`,
  `template.json` validate, refcount tie-in); `deno.json` (`template:build`
  task). **HS** for the store/paths/validation; the bake is **VM**.

- **WI-6 — snapshot planner + core restore/personalize/fallback.** ▶ WI-1, WI-4,
  WI-5. _Touch:_ `src/rootd/supervisor_core.ts` (`SupervisorLaunchPlan` union;
  `#launch` restore branch: restore → dial → personalize → ready;
  fallback-to-cold §5.3); `src/rootd/launch_planner.ts` (restore-plan
  resolution: `SnapshotLoadParams` with
  `network_overrides`/`vsock_override`/`resume_vm`/`mem_backend:File`, stage
  snapshot/mem/rootfs/overlay-copy, `fallbackCold`); `src/rootd/agent_dialer.ts`
  (`openPersonalizeSession`). **HS** with fake runtime + fake agent.

- **WI-7 — strategy seam + config + version gate.** ▶ WI-6. _Touch:_
  `src/rootd/main.ts` (`LaunchPlannerConfig.launchStrategy`/`templateCacheDir`,
  wiring, firecracker >= v1.16 gate §5.5); docs. **HS**.

- **WI-8 — fc-smoke validation.** ▶ all. _Touch:_ `tools/parity_vm_test.ts`
  (`--strategy snapshot`) or new `tests/vm/snapshot_vm_test.ts`;
  `tools/soak/soak_vm_main.ts` (snapshot backend); `docs/`. **VM**.

**Critical path:** WI-1 → (WI-2 ∥ WI-3 ∥ WI-4) → WI-5 → WI-6 → WI-7 → WI-8.

---

## 9. Open decisions (with recommendations)

1. **Mem backend: File vs Uffd for 1.0 → File.** Uffd requires an external
   page-fault handler process listening on the backend path; "Deno cannot
   receive the userfaultfd over SCM_RIGHTS, so no in-process handler exists"
   (deno doc `CommonRestoreOptions.snapshot`). File is "fully supported". Use
   **File** for 1.0; Uffd (with a small non-Deno uffd helper) is the post-1.0
   path to demand-page a shared mem without copying.

2. **Template build timing → lazy on first snapshot create, persistently cached,
   with an optional explicit prewarm.** Eager-at-rootd-start adds startup
   latency and builds templates that may never be used; lazy-first-use amortizes
   and keeps the artifact keyed purely by manifest hash. Provide
   `deno task
   template:build` so a deploy can prewarm deliberately.

3. **personalize: bootstrap method vs separate channel → bootstrap method (`@3`
   on `AgentBootstrap`).** It reuses the identity handshake (`negotiate`
   verifies the schema/firecracker pin match before we trust the guest), needs
   no second listener/port, and the process-global personalization state cleanly
   gates `authenticate`. A separate rootd-only channel would duplicate the vsock
   listener and the negotiate machinery for no security gain (reachability, not
   a second port, is what makes it safe — §2.4).

4. **Snapshot post-network-config, or keep network out of the template → keep
   network OUT.** Baking `eth0`'s IP into the template bakes **one** IP into
   shared memory → conflict across restores (the core constraint, §0). The
   template carries a NIC **device** but no address; personalize configures it
   in-band. (This is also why the template needs the placeholder TAP, §1.4.)

5. **Netless: always cold vs a netless template → netless always cold for 1.0.**
   Simplest; avoids a second template variant per hash; netless is rare and cold
   is already fast for it. A netless template (no NIC) is a clean post-1.0 add.

6. **Fallback granularity → in-core fallback to cold, reusing the provisioned
   network (§5.3).** Never fail a create on a template problem. The rejected
   alternative (surface the error and let hostd retry cold) doubles create
   latency on failure and risks stranding network/overlay.

7. **Shared read-only mem (COW) optimization → validate in fc-smoke, defer to
   post-1.0.** If restore does not mutate the `mem` file, share one read-only
   mem per hash (hardlink/bind) and delete the per-restore 512 MiB copy — a
   large win, but it needs the COW behavior **proven** (WI-8) and an adapter
   change to allow a read-only shared stage (`adapter.ts:29`). Keep the copy for
   1.0.

8. **Firecracker version gate → require >= v1.16 for snapshot, fall back to cold
   below (§5.5).** `vsock_override` is @since v1.16; the compat min is v1.15.0.
   Do not let a v1.15 host select snapshot.

---

## Appendix: distinct from `src/api/snapshot.ts`

This "snapshot" is the **Firecracker microVM** snapshot (guest memory + device
state). It is **not** the `@deno/sandbox` `Snapshot`/`Volume` parity surface in
`src/api/snapshot.ts` (filesystem/disk snapshots), which is deferred post-1.0
(`BACKLOG.md:496-499`). Keep the vocabulary separate in code (e.g. "warm
template" / "restore" for the VMM snapshot) to avoid collision.
