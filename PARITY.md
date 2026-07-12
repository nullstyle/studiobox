# PARITY — `@nullstyle/studiobox` vs `@deno/sandbox`

**Fidelity target:** `jsr:@deno/sandbox@0.13.2` (129 root symbols / 473 declared
members; the machine-readable audit lives in
[`parity/inventory.json`](parity/inventory.json) and
[`parity/member-audit.json`](parity/member-audit.json)).

This is the authoritative, honest map of what studiobox does and does not
reproduce from the upstream SDK. Studiobox is a **local, Firecracker-backed**
substitute for the Deno Deploy cloud sandbox: swap the import and the execution
core of your program keeps working, but anything that depended on Deploy's cloud
control plane (the PaaS, public HTTPS ingress, managed secrets, SSH/VS Code
tunnels, persistent volumes/snapshots) behaves differently or is unsupported.

If a call is not listed as **Tier A**, read its row before you rely on it.

> Provenance note: tier assignments are pulled from **DESIGN.md §5** (the
> authoritative source). Where the current code has not yet caught up to the §5
> target, the row says so and names the milestone (see PLAN.md). PARITY.md
> describes the **1.0 fidelity contract**, not any single milestone snapshot.

## Tiers

| Tier  | Meaning                                                                                 |
| ----- | --------------------------------------------------------------------------------------- |
| **A** | **Full fidelity.** Upstream's exact observable semantics. Same call, same result.       |
| **B** | **Emulated, with a documented divergence.** It works, but the mechanism/result differs. |
| **C** | **Unsupported.** The type exists for source compatibility; the call throws at runtime.  |

- Tier C throws `UnsupportedFeatureError` (extends `SandboxSdkError`), carrying
  the feature name. It is a deliberate, typed rejection — never a silent no-op.
- Every non-Tier-A behavior below has a row. Tier A surface is summarized; the
  divergence tables are where the real content is.

## Summary

| Area                                                      | Tier                               |
| --------------------------------------------------------- | ---------------------------------- |
| `Sandbox` lifecycle (create/connect/close/kill/dispose)   | A                                  |
| `sh` command builder                                      | A                                  |
| `spawn()` / `ChildProcess`                                | A                                  |
| `fs.*`                                                    | A                                  |
| `env.*`                                                   | A                                  |
| `deno.eval` / `deno.repl` / `deno.run`                    | A                                  |
| `Sandbox.fetch`                                           | A (policy-filtered egress)         |
| `memory`, `timeout`, `extendTimeout`, `labels`            | A (`timeout` clock is local)       |
| Sandbox `id` grammar                                      | A (`sbx_loc_…`)                    |
| `exposeHttp`                                              | **B** — local `http://` URL        |
| `allowNet`                                                | **B** — nftables egress            |
| `region`                                                  | **B** — recorded, ignored, `"loc"` |
| oom reporting                                             | **B** — 137 + cgroup events        |
| auth / token / `org`                                      | **B** — `STUDIOBOX_TOKEN`, no org  |
| `secrets`                                                 | **C**                              |
| `exposeSsh`                                               | **C**                              |
| `exposeVscode` / `VsCode`                                 | **C**                              |
| `deploy` / apps / revisions / timelines / layers / builds | **C**                              |
| `volumes` / `snapshots` / `root`                          | **C**                              |
| `ssh` / `port` create options                             | **C**                              |
| additive `studiobox` / `lima` options field               | extension (not upstream)           |

---

## Tier A — full fidelity (the execution surface)

These reproduce upstream's exact observable semantics. They are the reason
studiobox exists: the code inside your sandbox does not know it is running on a
local microVM instead of Deploy.

### Sandbox lifecycle — `create` / `connect` / `id` / `closed` / `close` / `kill` / dispose

- `Sandbox.create(options?)` boots a microVM and returns the façade.
- `Sandbox.connect(id)` / `connect({ id })` re-attaches to a running sandbox.
- `close()` drops the connection: a `"session"` sandbox then **terminates**; a
  duration sandbox **keeps running**. `kill()` is authoritative termination.
  `[Symbol.asyncDispose]` === `close()`. `closed` resolves on teardown; calls
  after close throw `ConnectionClosedError`. This matches upstream exactly.

### Sandbox `id` grammar — Tier A, `loc` in the region slot

Studiobox mints ids with **upstream's grammar** so `connect(id)` round-trips:

```
sbx_loc_<20 chars of [0-9a-hjkmnp-z]>
```

The alphabet excludes `i`, `l`, `o`. The region segment is fixed to **`loc`**
(upstream uses e.g. `ord`/`ams`); it occupies the region slot without changing
the shape. Ids remain 100% source-compatible with any code that stores or
pattern-matches a sandbox id.

### `sh` template-tag builder

`bash -c` with `BASH_ENV=$HOME/.bashrc`; per-argument single-quote escaping;
arrays expanded, objects rejected (`TypeError`). Chainable
`noThrow / sudo / cwd / env / stdout / stderr / signal`; terminal
`text() / json() / result() / spawn()`; thenable (awaiting runs it). Throws
`SandboxCommandError` on nonzero exit — which **extends `Error`, not
`SandboxSdkError`** (an upstream quirk faithfully reproduced). Error messages
**omit the command text**. OOM is appended as `(process ran out of memory)`.

### `spawn()` / `ChildProcess`

Stdio defaults: stdin `"null"`, stdout/stderr `"inherit"`. **`"inherit"` is
client-side**: the agent pipes the stream and the SDK pumps those bytes into the
host's stdout/stderr **without closing them**. `output()` buffers with lazy
`stdoutText` / `stderrText` (a stream read failure yields `null` buffers, never
a throw). `KillController` / `KillSignal` produce `128 + n` abort exit codes
(SIGTERM → 143, SIGKILL → 137, …).

### `fs.*`

The full Deno-mirroring set — `readFile` … `utime`, `open` / `FsFile` with
`SeekMode`, `walk` / `expandGlob` streamed — plus `upload` / `download`
(SDK-side recursion, relative symlinks preserved). In the real backend the guest
agent is a near-passthrough to in-guest `Deno.*`, so the fidelity work is
largely free.

> **Real-backend wire-plane status (M8 Parity-real gate).** The
> `sandbox_agent.capnp` `FileSystem` plane carries
> `stat / list / makeDir /
> remove / rename / open / beginUpload / beginDownload`.
> Over that core the SDK backend (`src/sdk/wire_agent.ts`) COMPOSES `copyFile`,
> `makeTempDir`, `makeTempFile`, `walk`, and `expandGlob` client-side — these
> are **green against real sandboxes**. `lstat`, `symlink`, `readLink`,
> `realPath` (and `chmod` / `chown` / `link` / `umask` / `utime`) each need a
> distinct guest syscall the core cannot express and remain **typed not-yet** on
> the real backend pending a `sandbox_agent.capnp` extension (an M1
> codegen-gated change); the fixture `fs: stat/lstat/symlink/readLink/realPath`
> is the one Tier-A fs row still red against real sandboxes.

### `env.*`

`get / set / toObject / delete`. `SandboxOptions.env` is applied **post-create**
through `env.set` (upstream behavior), not injected at boot.

### `deno.eval` / `deno.repl` / `deno.run`

- `deno.eval<T>(code)` — structured-clone result.
- `deno.repl()` — `eval`, `call`, state preserved across snippets.
- `deno.run({ entrypoint | code, watch, scriptArgs })`.
- `DenoProcess.fetch` targets the in-runtime HTTP server; `httpReady` resolves
  on the first `Deno.serve` / `createServer`.

> **Real-backend wire-plane status (M8 Parity-real gate).** `deno.eval`/`repl`
> with primitive, `Map`/`Set`/`Date`, and plain-object results, `repl` state,
> `close`, and `deno.run({ entrypoint })` are **green against real sandboxes**.
> Three Tier-A `deno.*` rows are still red against the real backend and need
> guest-agent work (batched with the next `sandbox_agent.capnp` extension): (1)
> an error THROWN by evaluated code surfaces as a generic `SandboxAgentError`
> rather than re-throwing with the guest error's `name` (the agent service
> returns a wire `SbxError` instead of a captured value/error frame); (2)
> `deno.run({ code })` with inline source (no entrypoint file) — the wire
> `DenoRuntime.run` requires the `SpawnSpec` to carry an entrypoint path; (3)
> `repl.call` with a non-JSON argument (e.g. a `Map`) — the wire `DenoRepl`
> exposes only `eval`, so `call` is composed as a JSON-argument `eval` and the
> codec-preserving native `call` op the repl server already implements is not
> reachable over the wire.

### `Sandbox.fetch`

Routed through the sandbox's egress — and therefore **subject to `allowNet`
policy** (Tier B). The call shape and semantics are upstream; the egress is the
local, policy-filtered path rather than Deploy's.

### `memory`, `timeout`, `extendTimeout`, `labels`

- `Memory` grammar: a bare number is **bytes**; unit suffixes
  (`GB/MB/kB/GiB/MiB/KiB`) accepted; clamped to **768–4096 MiB**; default 1280
  MiB. Out-of-range throws `InvalidMemoryError`.
- `timeout`: `"session"` | `"<n>s"` | `"<n>m"`. Observable semantics are
  upstream's; the **enforcement clock is local** — see Tier B.
- `extendTimeout(timeout)`: ≤ 30 min per call, returns the **actual** new
  deadline.
- `labels`: ≤ 5, 64 B key / 128 B value caps.

---

## Tier B — emulated, documented divergence

These work, but the mechanism or the returned value differs from Deploy. This is
the section to read before shipping something that assumed the cloud's behavior.

### `exposeHttp({ port })` / `exposeHttp({ pid })`

|               |                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Upstream**  | Returns a **public HTTPS URL** served by Deploy's ingress.                                             |
| **Studiobox** | Returns `http://127.0.0.1:<forwarded>` from the host's reserved forward range (default `40100–40199`). |

The port is leased from the host's reserved range and forwarded to the sandbox.
It is reachable **only from the host** (or wherever you tunnel loopback to). It
is **plain HTTP, not HTTPS**, and **not internet-reachable**. If your code
constructed a public URL and handed it to a third party, that will not work
locally — the URL is a developer-loopback convenience.

### `allowNet`

|               |                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream**  | Cloud egress allowlist.                                                                                                                                       |
| **Studiobox** | Per-sandbox **nftables egress rules on the sandbox's TAP device**. Hostnames are resolved to IPs at rule-apply time; wildcard subdomains use a dnsmasq ipset. |

`allowNet` **unset = unrestricted egress**, matching upstream. When set, only
the listed destinations are reachable; everything else is dropped at the TAP.
Because names are resolved at apply time, a host that later changes IP
(short-TTL DNS, CDN rotation) may drift from the allowlist until rules are
re-applied — the wildcard/ipset path exists to reduce that.

### `region`

|               |                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream**  | Selects a Deploy region (`ord`, `ams`, …); affects placement.                                                                                                        |
| **Studiobox** | **Accepted, recorded as metadata, otherwise ignored.** There is one location: the host you are running on. `SandboxMetadata.region` reports the literal **`"loc"`**. |

The upstream `Region` union is **widened to admit `"loc"`** so metadata
round-trips. Passing a real cloud region (`"ord"`, `"ams"`) is accepted and
ignored — it does not error, and it does not move your sandbox anywhere.

> Current-code note: `src/api/types.ts` still declares `Region = "ord" | "ams"`
> (upstream), and `FakeSandboxHost` casts `"loc" as Region`. The union widening
> is a PLAN M8/M10 deliverable; the **behavior** (recorded, ignored, reports
> `"loc"`) is already the contract.

### `timeout` enforcement

|               |                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstream**  | Enforced by Deploy's control plane.                                                                                                                                             |
| **Studiobox** | Enforced by **`studiobox-hostd`'s lease clock**. `"session"` → sandbox dies when the creating connection closes; a duration → killed at `stop_at_ms` regardless of connections. |

The **observable semantics are identical**; only the clock's owner differs.
There is no cloud scheduler — a local daemon holds the lease.

### OOM reporting

|               |                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Upstream**  | An OOM boolean on process status.                                                                      |
| **Studiobox** | Derived from **exit code 137 + cgroup `memory.events`**, collapsed to the same boolean (`status.oom`). |

Same boolean, local source of truth. `sh` surfaces it as
`(process ran out of memory)` in the thrown error message.

### auth / token / `org`

|               |                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Upstream**  | `DENO_DEPLOY_TOKEN`; org-scoped cloud account.                                                                                                   |
| **Studiobox** | **`STUDIOBOX_TOKEN`** (or `~/.studiobox/token`); a bearer token minted locally at `host up`. **No org concept** — `org` is accepted and ignored. |

`MissingTokenError` / `InvalidTokenError` exist for type compatibility but
studiobox never validates a cloud token. The token authenticates you to your own
local daemon over loopback (see [`docs/threat-model.md`](docs/threat-model.md)).

---

## Tier C — throws `UnsupportedFeatureError`

The types are present so `@deno/sandbox`-shaped code compiles unchanged, but
these throw at runtime. They are **out of scope for 1.0 by design** (DESIGN.md
§1 non-goals, §5). Several are post-1.0 candidates (noted).

| Surface                                                       | Why unsupported / disposition                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `secrets` (`SandboxOptions.secrets`, `SecretConfig`)          | On-the-wire injection needs a TLS-terminating egress proxy. **Post-1.0 candidate.**             |
| `exposeSsh` (`Sandbox.exposeSsh`, `ssh` create option)        | No SSH ingress path in the local model. **Post-1.0.**                                           |
| `exposeVscode` / `VsCode` / `VsCodeOptions`                   | No VS Code tunnel service. **Post-1.0.**                                                        |
| `deploy` (`Sandbox.deploy`, `SandboxDeno.deploy`, `Client.*`) | The Deploy PaaS surface — apps, revisions, timelines, layers, builds — is an explicit non-goal. |
| `Client.apps` / `.revisions` / `.timelines` / `.layers`       | PaaS management surface. (`Client.sandboxes` **is** Tier A.)                                    |
| `volumes` (`SandboxOptions.volumes`, `Volume`, `Volumes`)     | Persistent volumes. **Post-1.0:** map onto Firecracker snapshots + overlay images.              |
| `snapshots` (`Snapshot`, `Snapshots`, `SnapshotId`, …)        | **Post-1.0:** same snapshot/overlay mapping.                                                    |
| `root` (`SandboxOptions.root`)                                | Boot-from-volume/snapshot. **Post-1.0.**                                                        |
| `port` (`SandboxOptions.port`)                                | Cloud-specific create option; no local equivalent.                                              |

Notes:

- **`Client.sandboxes` is Tier A** — list/create/connect against the local host
  work. Only the PaaS-management sub-clients on `Client` are Tier C.
- The PaaS type zoo (`App*`, `Revision*`, `Layer*`, `Timeline*`, `Build*`,
  `EnvVar*`, `Deploy*`, `RuntimeConfig`, `LogLevel`, `Cursor`, `PaginatedList`,
  …) is present as **type-only stubs** for source compatibility. Referencing the
  types compiles; invoking the operations throws.
- `ApiError` is exported for type compatibility but studiobox never calls the
  cloud API, so it is not raised by the local backend.

---

## Additive divergence — the one allowed extension

Studiobox adds **exactly one** field to upstream-named option types: a
`studiobox` (and nested `lima`) options object on `SandboxOptions`, for **host
selection and artifact-set override**. It is optional; upstream code that never
sets it is unaffected, and upstream never sees it. Nothing else is added to
upstream-named types.

Beyond the SDK surface, studiobox ships additional **exports** that are not part
of the `@deno/sandbox` shape and never collide with it:

- `.` — the upstream-shaped SDK (`Sandbox`, `Client`, errors,
  `KillController`…).
- `./testing` — [`FakeSandboxHost`](docs/testing-your-app.md): an in-process,
  no-VM backend for testing your studiobox-consuming app on any OS.
- host/daemon programmatic seams (DESIGN.md §12 names `./unstable-host` and
  `./cli`) — the host lifecycle and daemon internals, not upstream surface.

> Current-code notes (for maintainers reconciling docs ↔ code):
>
> - The additive `studiobox` / `lima` field is **not yet present** on
>   `SandboxOptions` in `src/api/types.ts`; it is a designed extension (DESIGN
>   §5) landing with the real provider (PLAN M8).
> - `deno.json` currently exports `.`, `./images`, and `./testing`. The
>   `./unstable-host` and `./cli` exports named in DESIGN §12 are not yet split
>   out (the host/daemon seams are re-exported from the root `mod.ts` today);
>   `./images` is an extra build-tooling export.

## Errors you will actually see

| Error                          | Tier / cause                                                             |
| ------------------------------ | ------------------------------------------------------------------------ |
| `SandboxCommandError`          | A — nonzero `sh`/command exit (extends `Error`, not `SandboxSdkError`).  |
| `ConnectionClosedError`        | A — a call after `close()`/`kill()`.                                     |
| `ConnectionEstablishmentError` | A — `connect()` to an unknown/unreachable sandbox.                       |
| `InvalidMemoryError`           | A — `memory` outside 768–4096 MiB or malformed.                          |
| `InvalidTimeoutError`          | A — malformed `timeout`.                                                 |
| `SandboxKillError`             | A — kill failed.                                                         |
| `HostCapacityError`            | Studiobox extension — the shared host cannot admit the VM (no queueing). |
| `UnsupportedFeatureError`      | Studiobox extension — a Tier C call.                                     |

`HostCapacityError` and `UnsupportedFeatureError` are the two symbols studiobox
adds to the error taxonomy; both extend `SandboxSdkError`.

---

## Related documents

- [DESIGN.md](DESIGN.md) — §5 is the source of these tier assignments.
- [PLAN.md](PLAN.md) — the milestones (M8 Tier A, M10 Tier B) that deliver them.
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together.
- [docs/threat-model.md](docs/threat-model.md) — the isolation and trust model.
- [docs/permissions.md](docs/permissions.md) — Deno permissions per component.
- [docs/testing-your-app.md](docs/testing-your-app.md) — `FakeSandboxHost`.
- [parity/inventory.json](parity/inventory.json) /
  [parity/member-audit.json](parity/member-audit.json) — the machine-readable
  129-symbol / 473-member audit.
