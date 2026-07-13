# Changelog

All notable changes to `@nullstyle/studiobox` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
aims to follow [semantic versioning](https://semver.org/) from 1.0 onward.

## [0.1.2] — 2026-07-13

### Fixed

- **`host up` no longer crashes when run straight from JSR.** The documented
  `deno run -A jsr:@nullstyle/studiobox/cli host up` threw
  `TypeError: URL must be a file URL: received https:` in the `HostLifecycle`
  constructor, before any provisioning ran: resolving the packaged
  `compat/wire.json` pin did `fromFileUrl(import.meta.resolve(...))`, which
  works only for a `file:` module URL (a local checkout) and throws for the
  `https:` URL a JSR-fetched module carries. `defaultCompatPath()` now imports
  the pin directly (embedded in the package) and materializes it to a temp file
  when the module was loaded remotely, so `host up` provisions the host — VM,
  Firecracker, directories, token, and systemd units — from JSR just as it does
  from a checkout. Re-serializing the pin is safe: the daemons and the
  host/supervisor contract identity read its `protocol` / `schemaSha256` /
  `codegen` fields, never a hash of the file bytes.
- Getting-started docs (README + `docs/host-lifecycle.md`) now state the real
  from-JSR flow accurately: `host up` provisions the host, but the compiled
  daemons (`deno task daemons:compile`) plus the agent and golden images still
  require a local checkout today, so `host up` from a bare `jsr:` invocation
  stops at a clear "no compiled daemon binaries present" warning rather than a
  crash.
- **`host up` provisioning actually brings the daemons up now.** A series of
  real bugs surfaced only against a live Lima VM (the path was previously
  unit-tested against a fake host env):
  - `copyIn` stages through a temp file then `sudo install`s it into place, so
    it can write root-owned config dirs (a bare `limactl cp` rsyncs unprivileged
    and is denied on `/etc/studiobox`);
  - `daemons:compile` cross-compiles the Linux targets the provisioner expects
    (it only built the host binary before, so the daemons were never installed);
  - `/etc/studiobox` is owned `root:studiobox` so the unprivileged hostd can
    traverse it, and `rootd.token` is `0640 root:studiobox` (hostd reads it via
    `--rootd-token-file`);
  - rootd binds its supervisor UDS `0660` and its unit runs `Group=studiobox`,
    so `/run/studiobox` and the socket are group-reachable and hostd can
    connect.

  `host up` now reaches a healthy control plane — both daemons active and
  `host
  doctor` green on negotiate, capacity, and quarantine.

### Added

- **`Sandbox.create()` boots a real microVM through a provisioned host, proven
  end to end.** With a golden set baked (`tools/build_golden_set.ts`), a host
  provisioned by `studiobox host up --manifest-hash <hash>` runs the full
  drop-in on real Firecracker: a client `Sandbox.create()` cold-boots a jailed
  microVM in ~4.7s, then `sh`, `fs.readTextFile`/`writeTextFile`, and
  `deno.eval` all execute in-guest over the ticketed tunnel, and `close()`
  reclaims it. Validated against a host provisioned entirely from source (no
  manual steps).
- **`host up|provision --manifest-hash <sha256>`** enables rootd's launch
  planner. Provisioning writes `/etc/studiobox/launch.json` (bin paths, uid/gid,
  chroot/overlay/cache dirs are fixed by the guest layout; the manifest hash is
  the one per-host input) and wires the rootd unit's `--launch-config`. Without
  it, `host up` still brings up a control-plane-only host and records a warning
  that `Sandbox.create` needs a golden set.

### Fixed

- **The ticketed tunnel now assembles through a provisioned (split-user) host.**
  Two bugs blocked the client's tunnel attach, both invisible until a real
  cross-user deploy:
  - the hostd unit binds the tunnel router on `0.0.0.0` (`--tunnel-listen`), not
    the guest loopback — Lima forwards a `0.0.0.0` bind to the mac loopback but
    never a `127.0.0.1` one, so the client could not reach the tunnel port;
  - rootd's per-tunnel bridge UDS is created `0660` under a `0710`
    group-traversable root, so the unprivileged hostd (in the `studiobox` group)
    can connect to it; it was `0700 root` before, and every ticket was refused
    `SupervisorUnavailable`. The 32-byte bridge credential, not the socket mode,
    remains the confinement boundary.
- **No first-`create` tunnel race.** hostd binds the tunnel router eagerly at
  startup (rather than lazily on the first `openTunnel`) so a front-of-host
  forwarder establishes the route before any client dials; the client also
  retries a refused tunnel connect for a few seconds, since the single-use
  ticket is presented only after the connect succeeds and so is never burned by
  a retry.

## [0.1.1] — 2026-07-12

### Fixed

- **`Sandbox.create()` is now a true drop-in.** With `STUDIOBOX_HOST` /
  `STUDIOBOX_TUNNEL` exported (after `studiobox host up`),
  `import { Sandbox }
  from "@nullstyle/studiobox"` followed by
  `Sandbox.create()` now auto-connects to the host — no separate
  `installStudiobox()` call required. The host-dialing provider is loaded lazily
  (via dynamic import) only when this fallback fires, so the client barrel stays
  free of daemon code, and an explicitly installed provider (a `FakeSandboxHost`
  or `installStudiobox()`) always wins.
- **Actionable error when unconfigured.** Calling `Sandbox.create` / `connect` /
  `list` with no provider and no usable environment now throws a dedicated
  `ProviderNotInstalledError` that spells out the fix (`host up`,
  `installStudiobox()`, or `FakeSandboxHost.install()`), instead of the
  misleading `ImplementationPendingError` ("not wired to a Studiobox runtime"),
  which now denotes only genuinely-unimplemented features.
- README getting-started corrected to document the auto-wire, the explicit
  `installStudiobox()` path, and the `FakeSandboxHost` test path.

## [0.1.0] — 2026-07-12

First public release: a Deno-native, source-compatible substitute for
`jsr:@deno/sandbox`, backed by jailed Firecracker microVMs on hosts you control
(macOS via a long-lived Lima VM, or a Linux + KVM host directly).

### Added

- **`@deno/sandbox` client drop-in** (package root `.`): `Sandbox.create` /
  `connect`, the `sh` builder, `spawn` / `ChildProcess`, `fs.*`, `env.*`,
  `deno.eval` / `repl` / `run`, `exposeHttp`, `extendTimeout`, and the studiobox
  error taxonomy — the same shapes as `@deno/sandbox@0.13.2`. Proven against
  real in-VM sandboxes by the M3 parity suite.
- **Three-daemon architecture**: an unprivileged `studiobox-hostd` (auth,
  leases, capacity, ticketed tunnels), a root `studiobox-rootd` (Firecracker
  jailer, launch, reconcile, networking), and an in-guest `studioboxd` agent,
  connected by Cap'n Proto RPC (`@nullstyle/capnp`) over an AF_VSOCK tunnel.
- **Tier-B networking**: per-sandbox TAP + host NAT + static guest IP, a
  fail-closed nftables egress engine implementing `allowNet` (with wildcard
  subdomains via dnsmasq), inter-sandbox isolation, a guest→host input guard,
  and `exposeHttp` loopback port-forwarding. Validated on real hardware.
- **Durable state + crash recovery**: a journal-before-spawn CAS store,
  destructive restart reconciliation, per-boot execution IDs, and a composed
  reclaim-hook chain (network → artifact) with a startup orphan sweep.
- **`@nullstyle/studiobox/testing`**: `FakeSandboxHost`, to test a
  studiobox-consuming app with no VM.
- **`@nullstyle/studiobox/unstable-host`**: the (pre-1.0, unstable) daemon
  assembly seams for embedders standing up a local host.
- **CLI** (`@nullstyle/studiobox/cli`): `host up` / `down` / `status` / `doctor`
  / `provision`.
- **No-leak soak drill**: a 200-cycle create/use/terminate + 12
  `kill-9`-mid-fleet reconcile drill audits 11 resource classes (process, TAP,
  netns, nftables egress + port-forward, dnsmasq, mount, overlay, jail root,
  port reservations, journal phases, artifact refcounts) — green on real
  Firecracker hardware with bounded RSS.

### Known limitations

- Cold boot is ~a few seconds per create; snapshot-restore and a pre-warm pool
  are planned fast-follow performance work.
- The real-VM test tiers (parity / networking / soak) run in a local Lima VM;
  wiring them into CI and proving x86_64 alongside aarch64 is the remaining bar
  for 1.0.
- JSR doc-score coverage of the upstream-shaped client interfaces is a
  work-in-progress.

[0.1.2]: https://jsr.io/@nullstyle/studiobox
[0.1.1]: https://jsr.io/@nullstyle/studiobox
[0.1.0]: https://jsr.io/@nullstyle/studiobox
