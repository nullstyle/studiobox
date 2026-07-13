# @nullstyle/studiobox

A Deno-native local substitute for
[`@deno/sandbox`](https://jsr.io/@deno/sandbox): the same SDK surface, backed by
Firecracker microVMs on machines you control instead of Deno Deploy's cloud. On
macOS, sandboxes run inside one long-lived Lima Linux VM; on Linux, directly on
any KVM-capable host. Every sandbox is a jailed microVM — a kernel isolation
boundary, not a container.

```ts
// import { Sandbox } from "@deno/sandbox";
import { Sandbox } from "@nullstyle/studiobox";

// Auto-connects to your local host from STUDIOBOX_HOST / STUDIOBOX_TUNNEL
// once `studiobox host up` has run (see Getting started).
await using sandbox = await Sandbox.create();

await sandbox.sh`ls -lh /`;
await sandbox.fs.writeTextFile("hello.ts", `console.log("hi");`);
const result = await sandbox.deno.eval(`1 + 2`); // 3
```

Built on [`jsr:@nullstyle/firecracker`](https://jsr.io/@nullstyle/firecracker)
(microVM lifecycle, jailer, vsock, crash recovery) and
[`jsr:@nullstyle/capnp`](https://jsr.io/@nullstyle/capnp) (typed Cap'n Proto RPC
between client, host daemons, and the in-guest agent, `studioboxd`). Studiobox
adds the policy, authorization, durable state, resource accounting, and recovery
layers.

## Status

**0.1.1 — early release, working end-to-end.** The `@deno/sandbox` client
surface runs against real jailed Firecracker microVMs: `sh`, `spawn`, `fs`,
`env`, `deno.eval`/`repl`/`run`, `allowNet` egress policy, and `exposeHttp`. It
is validated on real hardware — the M3 parity suite passes against real in-VM
sandboxes, the Tier-B networking suite reaches the internet / enforces
`allowNet` / forwards `exposeHttp`, and a 200-cycle create/use/terminate +
`kill-9`-reconcile soak drill runs with **zero leaks** across 11 resource
classes.

As a pre-1.0 release the client API mirrors `@deno/sandbox` (stable-shaped), but
the host/daemon internals (`@nullstyle/studiobox/unstable-host`) may change
between minor versions, and snapshot-restore / pre-warm-pool fast-create are
still fast-follow work (cold boot is ~a few seconds per create).

### Getting started

```sh
deno add jsr:@nullstyle/studiobox

# One-time: provision + start the local host (Lima VM on macOS, native on Linux).
# `host up` prints the STUDIOBOX_HOST / STUDIOBOX_TUNNEL values to export.
deno run -A jsr:@nullstyle/studiobox/cli host up
```

With `STUDIOBOX_HOST` / `STUDIOBOX_TUNNEL` (and optional `STUDIOBOX_TOKEN`)
exported, `import { Sandbox } from "@nullstyle/studiobox"` is a true drop-in:
`Sandbox.create()` auto-connects to the host from the environment, so the
quickstart above runs verbatim. To wire the host explicitly instead — a
different endpoint, or to be independent of the ambient environment — call
`installStudiobox(...)` from `@nullstyle/studiobox/sdk` before your first
`Sandbox.create()`:

```ts
import { installStudiobox } from "@nullstyle/studiobox/sdk";

using _ = installStudiobox(); // or installStudiobox({ control, tunnel, token })
```

To develop or test a studiobox-consuming app with **no host and no VM**, install
the in-process fake from `@nullstyle/studiobox/testing`
([docs/testing-your-app.md](docs/testing-your-app.md)):

```ts
import { FakeSandboxHost } from "@nullstyle/studiobox/testing";

using _ = FakeSandboxHost.install();
```

If you call `Sandbox.create()` with none of the above in place, it throws a
`ProviderNotInstalledError` explaining exactly these options. Use
`studiobox
host status` and `studiobox host doctor` to report and diagnose the
host. Requires either macOS with Lima, or a Linux host with KVM.

- [DESIGN.md](DESIGN.md) — architecture, API fidelity tiers, state and security
  model
- [PLAN.md](PLAN.md) — carry-forward map, milestones M0 → 1.0, testing strategy,
  risks

## Documentation

- [PARITY.md](PARITY.md) — the authoritative fidelity map vs
  `@deno/sandbox@0.13.2`: what works, what diverges, what throws.
- [docs/architecture.md](docs/architecture.md) — a concise architecture overview
  (start here).
- [docs/permissions.md](docs/permissions.md) — the Deno permission matrix per
  daemon/component.
- [docs/threat-model.md](docs/threat-model.md) — trust boundaries and the
  two-daemon privilege split.
- [docs/testing-your-app.md](docs/testing-your-app.md) — test your
  studiobox-consuming app with `FakeSandboxHost`, no VM required.
- [docs/firecracker-contract.md](docs/firecracker-contract.md) — the low-level
  `@nullstyle/firecracker` integration contract.

1.0 means: repeatedly create, use, terminate, and reconcile real microVM
sandboxes on both supported Linux architectures with bounded resources and no
leaks — proven by a soak drill in CI, not by assertion.

## License

Apache-2.0
