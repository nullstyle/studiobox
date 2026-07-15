# images/ — the artifact pipeline

Everything a sandbox boots from (DESIGN.md §7, PLAN.md M4/M5): pinned kernel,
golden rootfs, manifest, the per-boot overlay, and the artifact cache.

## Pieces

| file                       | role                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pins.json` / `pins.ts`    | every build input pin: Firecracker-CI `vmlinux` per arch (url + sha256), rootfs recipe (suite, `snapshot.debian.org` epoch, packages, sandbox user, image size), guest Deno per arch |
| `kernel.ts`                | sha256 verification + idempotent fetch of the pinned kernel; network only via `tools/images_fetch_kernel.ts` or `SBX_QUALIFY=1`                                                      |
| `manifest.ts`              | `manifest.json` schema (strict, unknown-key-rejecting) + the deterministic manifest hash over input pins                                                                             |
| `content_manifest.ts`      | canonical sorted content manifest (path, type, mode, uid/gid, size, sha256) — the rootfs identity                                                                                    |
| `emit_content_manifest.ts` | dependency-free CLI the builder runs in-guest with the pinned Deno                                                                                                                   |
| `overlay.ts`               | host half of the overlay contract: the fresh sparse, unformatted per-boot overlay (`overlay_init/` is the guest half)                                                                |
| `cache.ts`                 | `~/.studiobox/artifacts/<manifest-hash>/` cache, refcounts, journal-guarded GC                                                                                                       |
| `build_rootfs.sh`          | debootstrap golden-rootfs builder (runs as root on Linux, e.g. the `fc-smoke` Lima VM)                                                                                               |
| `overlay_init/`            | init stub baked into the rootfs: formats/mounts the overlay, execs `tini` (guest pid 1) which runs the agent                                                                         |

## Identity model

The **manifest hash** (cache key, and the `ContractIdentity.artifactHash` all
three planes must agree on) covers _input pins only_: the kernel sha, the rootfs
recipe (package pins, snapshot epoch), the guest Deno version/sha, the agent
binary sha, and the shas of the `build_rootfs.sh` and `overlay-init.sh` scripts
themselves — so editing either script rolls the identity on its own. Build
outputs (`rootfs.identity`, `rootfs.sizeBytes`, `createdAt`) are excluded, so
rebuilding from identical pins lands in the same cache slot.

The **rootfs identity** inside the manifest is the content-manifest hash
(`identity.kind: "contentManifest"`): raw ext4 images from `mke2fs -d` are not
byte-identical across builds even with a fixed UUID, `hash_seed`, and
`SOURCE_DATE_EPOCH` (block-allocation and inode-table layout drift), so the
documented fallback from PLAN.md M4 is the primary identity. Two builds from the
same pins must produce the same content-manifest hash; that is what the fc-smoke
validation checks.

## The one-command real bake (`images:build`)

`deno task images:build` (`tools/build_golden_set.ts`) does the whole bake in
one step on a Linux+root host: `deno compile`s the real `studioboxd`, fetches
the pinned kernel, runs `build_rootfs.sh` with the compiled agent, assembles the
manifest, and `store()`s the set into the artifact cache — printing the manifest
hash as a final JSON line. The `test:vm` driver invokes it inside the `fc-smoke`
Lima VM; it also runs directly on a KVM CI runner.

The compiled agent's sha256 is an input pin, so rebuilding the agent rolls the
manifest hash on its own — there is nothing to keep in sync by hand.

## Building a golden rootfs by hand

`images:build` above is the supported path; this is the layer underneath it, for
when you want to drive the rootfs build on its own. Linux + root required (the
Lima VM works; no loop devices needed — `mke2fs -d` packs the tree directly).
`--agent` takes the compiled `studioboxd` for the **target** arch and is
mandatory — there is no default:

```sh
deno task agent:compile   # → .build/studioboxd-<target>

sudo images/build_rootfs.sh \
  --out /tmp/sbx-build \
  --arch aarch64 --suite bookworm --epoch 20260630T210956Z \
  --packages ca-certificates,e2fsprogs,iproute2,tini --image-size-mib 1024 \
  --deno-url https://dl.deno.land/release/v2.9.1/deno-aarch64-unknown-linux-gnu.zip \
  --deno-sha256 0a60d079fa79635a59803074dbbfe86ccc35746dc2c4f8d73f2e50338b3283a9 \
  --agent .build/studioboxd-aarch64-unknown-linux-gnu \
  --overlay-init images/overlay_init/overlay-init.sh
```

Outputs: `rootfs.ext4` (fixed UUID), `rootfs.manifest.txt` (canonical content
manifest; its sha256 is the rootfs identity), plus the tree it was packed from.
Flag values must mirror `pins.json` — the driver passes them explicitly so the
script sha (itself an input pin) stays free of pin drift.

## Overlays

The overlay is one contract with two halves, both kept here.

On the host, `overlay.ts` creates each sandbox's overlay as a _sparse,
unformatted_ file (`mkfs` is not portable to the macOS host). In the guest, the
`overlay-init` stub formats `/dev/vdb` as ext4 on first boot, mounts a writable
overlayfs over the read-only golden root, and execs `tini` (guest pid 1) which
runs the agent. Both launch paths — the cold planner and the warm-template baker
— go through `createSparseOverlay` so there is exactly one definition of what a
fresh overlay is.

Staging the overlay (and the kernel and rootfs) into the jail is _not_ done
here: `rootd` emits a declarative stage list and the firecracker jailer performs
the copy, because it — and only it — chowns the staged files into the jail's
uid/gid. Copy mode is pinned by the adapter, never hardlink: a hardlink would
share the golden inode, so an in-jail `chmod` would reach back and mutate it.

Because the kernel mounts the golden root **read-only** (`root=/dev/vda ro`),
`overlay-init` (pid 1) cannot create its own mount points — so `build_rootfs.sh`
bakes `/overlay` (where the overlay device mounts) and `/mnt/root` (where the
overlayfs is assembled) into the image.
