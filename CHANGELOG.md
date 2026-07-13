# Changelog

All notable changes to `@nullstyle/studiobox` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
aims to follow [semantic versioning](https://semver.org/) from 1.0 onward.

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

[0.1.0]: https://jsr.io/@nullstyle/studiobox
