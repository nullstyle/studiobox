# Testing your app with `FakeSandboxHost`

You built something on `@nullstyle/studiobox` (or on `@deno/sandbox` — same
surface). You want to test it **without booting a microVM**, on **any OS**, in
plain `deno test`. That is what the `./testing` export is for.

`FakeSandboxHost` installs an in-process backend behind the `Sandbox.create` /
`Sandbox.connect` seam. Your code calls `Sandbox.create()` exactly as in
production; the fake runs the real SDK façade against an in-process agent core
rooted at a per-test temp directory. No VM, no daemons, no Lima, no root.

## Quick start

```ts
import { FakeSandboxHost } from "@nullstyle/studiobox/testing";
import { Sandbox } from "@nullstyle/studiobox";

Deno.test("greets from a sandbox", async () => {
  await using host = FakeSandboxHost.install();

  await using sandbox = await Sandbox.create();
  const greeting = await sandbox.sh`echo hello`.text();

  // your assertions here
  if (greeting.trim() !== "hello") throw new Error("unexpected");
});
```

`FakeSandboxHost.install()` constructs the host **and** registers it as the
process-wide provider. `await using` uninstalls it and tears down every live
sandbox at the end of the test — no cross-test leakage. (Prefer `install()`; the
bare `new FakeSandboxHost()` + `.install()` two-step exists if you need the host
handle before registering.)

Run it with the permissions the fake needs (it executes real host processes —
see the warning below):

```sh
deno test --allow-read --allow-write --allow-run --allow-env --allow-sys=uid,gid
```

## The warning you must read first

> **`FakeSandboxHost` is a test double, NOT an isolation boundary.**

Every process a fake sandbox spawns runs **directly on your host, as the current
user**, with the host's real filesystem under the per-sandbox root. Path
confinement is a **correctness contract for tests, not a security barrier**:
`sandbox.sh` and `sandbox.spawn()` execute arbitrary host commands as you.

**Never point `FakeSandboxHost` at untrusted code.** Hostile workloads belong in
the real microVM backend, which is the entire reason the VM boundary exists. The
fake is for testing _your_ code, which you already trust. (This is the same
stance as `@nullstyle/firecracker`'s `FakeFirecracker`.)

## What is faithful

The fake honors upstream (`@deno/sandbox@0.13.2`) semantics precisely enough
that the same test file runs against the fake, a real in-VM sandbox, and the
full e2e path (PLAN.md §4, the three-backend parity suite):

- **Ids** — `Sandbox.create()` mints the real grammar
  `sbx_loc_<20 of [0-9a-hjkmnp-z]>`.
- **Lifecycle** — `close()` terminates (the fake is always session-shaped),
  `kill()` is authoritative termination, `[Symbol.asyncDispose]` === `close()`;
  `closed` resolves on teardown; calls after close throw
  `ConnectionClosedError`.
- **`SandboxOptions.env`** — applied post-create through `env.set`, exactly as
  upstream.
- **`sh` builder** — `bash -c` with `BASH_ENV=$HOME/.bashrc`, quote-escaping,
  `noThrow`/`sudo`/`cwd`/`env`/`stdout`/`stderr`/`signal`,
  `text()`/`json()`/`result()`, thenable, `SandboxCommandError` on nonzero exit.
- **`spawn` / `ChildProcess`** — stdio defaults (stdin `"null"`, stdout/stderr
  `"inherit"`), where `"inherit"` is the **client-side** contract: the agent
  pipes and the fake pumps those bytes into the host's stdout/stderr **without
  closing them**. `output()` buffers with lazy text getters; a stream read
  failure yields `null` buffers, never a throw; signal exits report `128 + n`.
- **`fs.*`** — the full set (read/write/stat/list/mkdir/remove/rename, `open` /
  `FsFile` with `SeekMode`, `walk` / `expandGlob`, temp files, symlinks…).
- **`env.*`** — `get`/`set`/`toObject`/`delete`.
- **`deno.eval` / `deno.repl` / `deno.run`** — eval returns structured-clone
  results; the repl preserves state across `eval`/`call`; `run` spawns with the
  upstream `entrypoint | code` shape.
- **`list()` / `connect()`** — label filtering, running/stopped status, and the
  `"loc"` region metadata.
- **oom** — inject an `oomAnnotator` (host option) to exercise
  `status.oom === true` without real cgroups.
- **Tier C** — `exposeSsh` / `exposeVscode` / `deno.deploy` / `secrets` /
  `volumes` / `root` / `ssh` / `port` throw `UnsupportedFeatureError` exactly as
  the real backend will, so your Tier C error handling is tested too.

## What the fake cannot emulate

These are the honest gaps. Two kinds: **fundamental** (the fake is not a VM) and
**milestone** (surface that lands later — it throws
`ImplementationPendingError`, distinct from Tier C's `UnsupportedFeatureError`).

### Fundamental — it is not an isolation boundary

- **No VM, no privilege drop.** Processes run as _you_, not as uid 1000 in a
  jailed guest. Anything that depends on the guest being a separate kernel /
  separate user / separate filesystem root will behave like your host instead.
- **No chroot, so absolute symlink targets differ.** A symlink whose target is
  an absolute in-sandbox path (e.g. `/etc/passwd`) resolves against the **host**
  `/` (landing outside the per-sandbox root → `SBX_AGENT_PATH_ESCAPE`), whereas
  a real guest resolves it against the guest's own `/`. **Use relative targets**
  for in-sandbox links to keep the fake and the real backend in agreement.
- **`$HOME` is a host path.** `HOME` points at `<root>/home/app` on your host so
  `BASH_ENV` sourcing works — an intentional divergence from the in-guest
  `/home/app`.
- **No resource limits.** There are no cgroups, no memory ceiling, no vcpu
  quota; `HostCapacityError` and real OOM-kills do not occur (use `oomAnnotator`
  to simulate the boolean).
- **No network isolation.** `allowNet` egress rules (nftables on a TAP) do not
  exist; network calls hit your host network directly.

### Milestone — throws `ImplementationPendingError`

The fake wires the M3 agent core; a few upstream surfaces attach later (PLAN.md
§M6–M8) and currently throw `ImplementationPendingError`:

- `Sandbox.fetch` (M8 egress plane)
- `Sandbox.exposeHttp` (M7 tunnel surface)
- `Sandbox.extendTimeout` (M6 lease surface)
- `fs.upload` / `fs.download` (M8 SDK-side recursion)
- `DenoProcess.httpReady` / `DenoProcess.fetch` and the `DenoRepl` process
  members (`pid`/`stdin`/`stdout`/`stderr`/`status`/`output`) — M8, the wire
  `HttpClient` / `DenoProcess` plane

If your test needs one of these today, it needs a real backend
(`deno task
test:vm`), not the fake. Guard those paths behind a backend switch,
or assert the `ImplementationPendingError` until the milestone lands.

## Patterns

**Seed a base environment for every sandbox:**

```ts
await using host = FakeSandboxHost.install({
  env: { MY_FLAG: "1" }, // layered over PATH (host) and HOME (sandbox)
});
```

**Simulate an OOM kill without cgroups:**

```ts
await using host = FakeSandboxHost.install({
  oomAnnotator: () => true, // every exit annotated status.oom === true
});
```

**Assert a Tier C feature is rejected:**

```ts
await using host = FakeSandboxHost.install();
await using sandbox = await Sandbox.create();
// exposeSsh is Tier C — this rejects with UnsupportedFeatureError
```

## Related documents

- [PARITY.md](../PARITY.md) — the full fidelity map; every Tier B/C row the fake
  mirrors.
- [docs/permissions.md](permissions.md) — why the fake needs
  `--allow-run`/`--allow-write`/etc. (it runs as you).
- [docs/architecture.md](architecture.md) — where the agent core the fake reuses
  sits in the real system.
- Source of truth: [`testing/mod.ts`](../testing/mod.ts) — the fake's module doc
  restates these caveats inline.
