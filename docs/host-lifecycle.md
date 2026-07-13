# Host lifecycle: `studiobox host up|down|status|doctor|provision`

Studiobox runs Firecracker microVM sandboxes on a Linux host. On macOS that host
is one long-lived Lima VM (`studiobox-host-<arch>`); on Linux the daemons run
directly. The `studiobox host` CLI brings that host up, provisions it, checks
its health, and tears it down — the automation behind PLAN.md §M9 and DESIGN.md
§11.

```
deno run -A jsr:@nullstyle/studiobox/cli host <up|down|status|doctor|provision> [flags]
```

The five verbs, the macOS vs. Linux split, what provisioning installs, and the
token flow are below. Everything the CLI does externally goes through `limactl`
(macOS) or `bash`/`sudo` (Linux), so the flow is identical whether you watch it
or drive it from a script.

### From JSR vs. a local checkout

`host up` runs straight from JSR and provisions the whole host — the VM,
Firecracker, the directories, the bootstrap token, and the systemd units. The
packaged `compat/wire.json` identity pin travels with it, so no checkout is
needed for provisioning itself.

The **compiled daemons** (`studiobox-hostd` / `studiobox-rootd`), the in-guest
**agent** (`studioboxd`), and the **golden image set** are not shipped in the
JSR package yet — they are built from a checkout. So a bare
`deno run -A jsr:@nullstyle/studiobox/cli host up` provisions the host and then
stops with a clear warning that no compiled daemon binaries are present (the
units are written but not enabled). Build the artifacts from a checkout and
re-run `host up` (or `host provision`) to install and start them:

```sh
git clone https://github.com/nullstyle/studiobox && cd studiobox
deno task daemons:compile   # .build/studiobox-{hostd,rootd}-<arch>-unknown-linux-gnu
deno task agent:compile     # .build/studioboxd
deno task images:build      # golden kernel + rootfs
deno task cli host up       # now installs + enables the daemons
```

## The verbs

| Command          | What it does                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host up`        | Create/start the Lima VM (macOS) from the committed template, verify `/dev/kvm`, then **provision**. Idempotent; reuses a running VM.              |
| `host provision` | Run the provisioning sequence only (no VM create). Idempotent — safe to re-run.                                                                    |
| `host down`      | Stop the Lima VM (macOS) or stop the systemd units (`--no-lima`).                                                                                  |
| `host status`    | Report VM existence/running, daemon `is-active`, token presence, and the loopback ports.                                                           |
| `host doctor`    | Open a HostControl session (negotiate + authenticate), read the capacity ledger, create + kill a **canary** sandbox, and list quarantined records. |

### Flags

| Flag                 | Applies to     | Meaning                                                                       |
| -------------------- | -------------- | ----------------------------------------------------------------------------- |
| `--recreate`         | up             | Delete and recreate the VM before provisioning (the `smoke:lima` pattern).    |
| `--no-lima`          | all            | Provision **this** Linux machine directly — no Lima VM (CI + Linux desktops). |
| `--rotate-token`     | up, provision  | Re-mint the bootstrap token even if one already exists.                       |
| `--json`             | status, doctor | Machine-readable output.                                                      |
| `--name <name>`      | all            | Override the Lima instance name (default `studiobox-host-<arch>`).            |
| `--arch <arch>`      | all            | Target `aarch64` or `x86_64` (default: this host).                            |
| `--control-port <n>` | all            | Override the HostControl port (default 40000; tunnel/expose derive from it).  |
| `--build-dir <dir>`  | up, provision  | Where the compiled daemon binaries live (default `.build`).                   |
| `--hostd-bin <path>` | up, provision  | Explicit `studiobox-hostd` binary source.                                     |
| `--rootd-bin <path>` | up, provision  | Explicit `studiobox-rootd` binary source.                                     |

Exit codes: `0` success, `1` a runtime failure (incl. an unhealthy `doctor`),
`2` a usage error.

## macOS: the Lima VM

`host up` on macOS starts `studiobox-host-<arch>` from the committed template
[`tools/lima/studiobox-host.yaml`](../tools/lima/studiobox-host.yaml), rendered
by `renderLimaTemplate()` in `src/cli/lima_template.ts` (the file is asserted
byte-identical to the generator, so it can never drift). The template pins:

- `vmType: vz` + `nestedVirtualization: true` — the microVMs studiobox launches
  run **inside** this VM, so `/dev/kvm` must be present (Apple Silicon M3+,
  macOS 15+). `host up` fails loudly if `/dev/kvm` is missing.
- `mounts: []` — **no** path from the VM back to your filesystem. A sandbox
  workload is hostile (DESIGN.md §8); the VM must not be able to reach your
  files.
- `containerd: { system: false, user: false }` — studiobox launches microVMs,
  not containers.
- Three static **loopback** port forwards, each binding the host side to
  `127.0.0.1` only: control `40000`, tunnel `40001`, and the exposeHttp range
  `40100–40199`.

`host up` is idempotent: a present, running VM is reused (`limactl start` is a
no-op when running). `--recreate` deletes the instance first.

## Linux / CI: `--no-lima`

On a Linux host there is no Lima layer. `host up --no-lima` (or
`host provision --no-lima`) provisions the local machine directly: guest scripts
run as `bash`/`sudo` on the box itself, and files are installed with
`install -m` rather than copied over `limactl cp`. This is the path CI uses and
the supported path for Linux workstations. A Linux developer who specifically
wants a Lima VM would set `vmType: qemu` (KVM-accelerated) — studiobox does not
commit that variant because `--no-lima` is the first-class Linux path.

## What provisioning installs

`provision` is a fixed, ordered, **idempotent** sequence
(`PROVISION_STEP_ORDER`):

1. **`packages`** — `nftables`, `dnsmasq`, and the rootfs-build deps
   (`debootstrap`, `e2fsprogs`, `unzip`), guarded by `command -v`.
2. **`firecracker`** — the pinned Firecracker + jailer from `FIRECRACKER_COMPAT`
   (currently `v1.16.1`, min `v1.15.0`), guarded by a version check.
3. **`directories`** — `/etc/studiobox`, `/var/lib/studiobox`, `/run/studiobox`,
   and the unprivileged `studiobox` service user that runs hostd (DESIGN.md §3).
4. **`binaries`** — the compiled `studiobox-hostd` / `studiobox-rootd` binaries
   into `/usr/local/bin`, plus `compat/wire.json` (the `ContractIdentity` pin)
   into `/etc/studiobox/wire.json`.
5. **`token`** — mint + install the bootstrap tokens (see below). A re-run does
   **not** rotate an existing token unless `--rotate-token` is given.
6. **`systemd`** — write both units, `daemon-reload`, and `enable --now`.

The two systemd units (`renderSystemdUnits()`):

- `studiobox-rootd.service` runs as **root** —
  `studiobox-rootd --socket /run/studiobox/supervisor.sock --state
  /var/lib/studiobox/journal.json --token-file /etc/studiobox/rootd.token
  --compat /etc/studiobox/wire.json`.
- `studiobox-hostd.service` runs as the unprivileged **studiobox** user, ordered
  `After=`/`Requires=` rootd —
  `studiobox-hostd --listen 0.0.0.0:40000 --rootd-socket
  /run/studiobox/supervisor.sock --token-file /etc/studiobox/hostd.token
  --rootd-token-file /etc/studiobox/rootd.token --compat
  /etc/studiobox/wire.json`.

> The compiled daemon binaries (`deno compile` of `src/hostd/main.ts` and
> `src/rootd/main.ts`, cross-compiled to the target arch) are an **input** to
> provisioning. If they are not present, `provision` reports a warning, writes
> the units, and does not enable them — provisioning still completes everything
> else. Compile them, then re-run `host provision`.

## The token flow

The bearer token is minted at provision time and delivered **off the forwarded
port** (DESIGN.md §8) — never over the control channel:

- Two 32-byte tokens are minted (64 hex chars each): `hostd.token` (client ↔
  hostd) and `rootd.token` (hostd ↔ rootd).
- `hostd.token` is written to `~/.studiobox/token` on the **host** (mode 0600) —
  this is what the SDK reads (or `STUDIOBOX_TOKEN`).
- Both tokens are installed into the guest under `/etc/studiobox/` via
  `limactl cp` (macOS) or `install -m` (`--no-lima`). `hostd.token` is
  `root:studiobox` 0640 so the unprivileged hostd can read it; `rootd.token` is
  root-only 0600.

Token install is idempotent — a re-provision reuses the existing token (so live
SDK sessions keep working) unless you pass `--rotate-token`.

> Transport security is **staged** (DESIGN.md §8, §13): early milestones run
> token-over-loopback (the Lima forwards bind 127.0.0.1). Pinned TLS on the
> control + tunnel listeners lands as an M11 hardening item.

## `host doctor`

`doctor` is an end-to-end health probe. It opens a HostControl client to hostd
over the forwarded control port and runs four checks, reporting exactly which
stage is wedged if one is:

1. **negotiate** — protocol negotiation + token authentication (a refused
   connection, rejected handshake, or stall surfaces here — "detect a wedged
   daemon").
2. **capacity** — read the capacity ledger.
3. **canary** — create a short-lived throwaway sandbox and kill it, exercising
   the whole hostd → rootd launch path.
4. **quarantine** — list quarantined records (a reclaim that failed parks in
   `quarantined` rather than being dropped; DESIGN.md §6).

`doctor` exits `0` when every check passes, `1` otherwise. `--json` emits the
full report.

## Cold-start walkthrough (macOS)

Run from a checkout so the daemons and images exist locally (see
[From JSR vs. a local checkout](#from-jsr-vs-a-local-checkout)); `deno task cli`
is the checkout's alias for the CLI.

```sh
# 1. Compile the daemons + agent and build the golden images (once per arch).
deno task daemons:compile   # .build/studiobox-{hostd,rootd}-<arch>-unknown-linux-gnu
deno task agent:compile     # .build/studioboxd
deno task images:build      # golden kernel + rootfs

# 2. Bring the host up (first run downloads Ubuntu; a few minutes).
deno task cli host up

# 3. Verify.
deno task cli host status
deno task cli host doctor

# 4. Your app now finds the token at ~/.studiobox/token.
#    await using sandbox = await Sandbox.create();

# 5. Tear down when done.
deno task cli host down
```

> **Deferred to manual validation.** A full cold `host up` boots a real second
> Lima VM, which collides with the in-use `fc-smoke` instance the M4/M5 tracks
> drive; it is validated manually rather than in the unit batch. The lifecycle
> module, provisioning sequence, template, and doctor logic are all exercised in
> `tests/unit/cli/` against a fake `limactl`/command runner with no VM. Run the
> walkthrough above on an idle Mac (or `--name` a distinct instance) to validate
> the real path end to end.

## Linux / CI walkthrough

```sh
# On a KVM-capable Linux box (root), from a checkout with the daemons + images
# built into .build/ (deno task daemons:compile / agent:compile / images:build):
deno task cli host up --no-lima
deno task cli host doctor --no-lima
```
