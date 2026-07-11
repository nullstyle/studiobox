# images/ — the M4 artifact pipeline

Everything a sandbox boots from (DESIGN.md §7, PLAN.md M4): pinned kernel,
golden rootfs, manifest, staging, and the artifact cache.

## Pieces

| file                       | role                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pins.json` / `pins.ts`    | every build input pin: Firecracker-CI `vmlinux` per arch (url + sha256), rootfs recipe (suite, `snapshot.debian.org` epoch, packages, sandbox user, image size), guest Deno per arch |
| `kernel.ts`                | sha256 verification + idempotent fetch of the pinned kernel; network only via `tools/images_fetch_kernel.ts` or `SBX_QUALIFY=1`                                                      |
| `manifest.ts`              | `manifest.json` schema (strict, unknown-key-rejecting) + the deterministic manifest hash over input pins                                                                             |
| `content_manifest.ts`      | canonical sorted content manifest (path, type, mode, uid/gid, size, sha256) — the rootfs identity                                                                                    |
| `emit_content_manifest.ts` | dependency-free CLI the builder runs in-guest with the pinned Deno                                                                                                                   |
| `staging.ts`               | copy-only staging into a jail root + fresh sparse overlay (never hardlinks; golden inode is never shared)                                                                            |
| `cache.ts`                 | `~/.studiobox/artifacts/<manifest-hash>/` cache, refcounts, journal-guarded GC                                                                                                       |
| `build_rootfs.sh`          | debootstrap golden-rootfs builder (runs as root on Linux, e.g. the `fc-smoke` Lima VM)                                                                                               |
| `agent/`                   | committed placeholder for the compiled `studioboxd` (see the swap point below)                                                                                                       |
| `overlay_init/`            | init stub baked into the rootfs: formats/mounts the overlay, execs the agent                                                                                                         |

## Identity model

The **manifest hash** (cache key, future `ContractIdentity` component) covers
_input pins only_: kernel sha, rootfs recipe + package pins + snapshot epoch,
guest Deno version/sha, agent binary sha, builder + overlay-init script shas.
Build outputs (`rootfs.identity`, `rootfs.sizeBytes`, `createdAt`) are excluded,
so rebuilding from identical pins lands in the same cache slot.

The **rootfs identity** inside the manifest is the content-manifest hash
(`identity.kind: "contentManifest"`): raw ext4 images from `mke2fs -d` are not
byte-identical across builds even with a fixed UUID, `hash_seed`, and
`SOURCE_DATE_EPOCH` (block-allocation and inode-table layout drift), so the
documented fallback from PLAN.md M4 is the primary identity. Two builds from the
same pins must produce the same content-manifest hash; that is what the fc-smoke
validation checks.

## The agent placeholder (swap point)

`agent/studioboxd-placeholder.sh` is baked into golden builds as
`/usr/local/bin/studioboxd` until the compiled agent exists. When M3/M5 deliver
the real per-arch `deno compile` binary, pass it to `build_rootfs.sh --agent`
and set `agentBinary: { placeholder: false }` with the binary's sha256 — the
manifest hash rolls automatically because the agent sha is an input pin. Nothing
else changes.

## Building a golden rootfs

Linux + root required (the Lima VM works; no loop devices needed — `mke2fs -d`
packs the tree directly):

```sh
sudo images/build_rootfs.sh \
  --out /tmp/sbx-build \
  --arch aarch64 --suite bookworm --epoch 20260630T210956Z \
  --packages ca-certificates,e2fsprogs --image-size-mib 1024 \
  --deno-url https://dl.deno.land/release/v2.9.1/deno-aarch64-unknown-linux-gnu.zip \
  --deno-sha256 0a60d079fa79635a59803074dbbfe86ccc35746dc2c4f8d73f2e50338b3283a9 \
  --agent images/agent/studioboxd-placeholder.sh \
  --overlay-init images/overlay_init/overlay-init.sh
```

Outputs: `rootfs.ext4` (fixed UUID), `rootfs.manifest.txt` (canonical content
manifest; its sha256 is the rootfs identity), plus the tree it was packed from.
Flag values must mirror `pins.json` — the driver passes them explicitly so the
script sha (itself an input pin) stays free of pin drift.

## Overlays

Staging creates each sandbox's overlay as a _sparse, unformatted_ file (mkfs is
not portable to the macOS host). The in-guest `overlay-init` stub formats
`/dev/vdb` as ext4 on first boot, mounts a writable overlayfs over the read-only
golden root, and execs the agent.
