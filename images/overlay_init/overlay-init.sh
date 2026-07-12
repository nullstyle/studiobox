#!/bin/sh
# overlay-init (M5: launches the real studioboxd agent over vsock).
#
# Boot flow (DESIGN.md §7/§10): the guest kernel mounts the golden rootfs
# copy read-only as /, with a fresh *sparse, unformatted* overlay file
# attached as /dev/vdb (staging cannot mkfs portably from the macOS host).
# This init runs as pid 1 (`init=/sbin/overlay-init` in the boot args),
# formats the overlay on first boot, mounts a writable overlayfs over the
# read-only root, then execs the compiled studioboxd agent listening on
# AF_VSOCK cid=3.
#
# Boot-config contract (set by the rootd launch planner in the kernel
# command line; DESIGN.md §7 boot_args):
#
#   studiobox.vsock_port=<PORT>   AF_VSOCK port studioboxd listens on; the
#                                 planner MUST configure the firecracker
#                                 vsock device (guest_cid=3) and dial this
#                                 same port host-side. Falls back to
#                                 DEFAULT_VSOCK_PORT for standalone smoke
#                                 boots.
#   studiobox.token=<HEX>         Shared credential (hex, decodes to
#                                 16..512 bytes) the host must present to
#                                 studioboxd's `authenticate`. Materialized
#                                 to a 0600 file on the writable overlay and
#                                 passed as --token-file. REQUIRED — no
#                                 fallback; a boot without it fails closed.
#
# The token rides the kernel cmdline (visible via /proc/cmdline to the
# in-guest workload). That is acceptable under the threat model (DESIGN.md
# §8): the credential only gates who may drive THIS guest's agent, and the
# hostile workload already *is* this sandbox — knowing it grants no escape.
#
# This script's sha256 is an input pin (manifest `overlayInitSha256`), so
# any change here rolls the artifact-set manifest hash automatically.
set -eu

OVERLAY_DEV="${OVERLAY_DEV:-/dev/vdb}"
AGENT="${STUDIOBOXD_BIN:-/usr/local/bin/studioboxd}"
DENO_BIN="${STUDIOBOXD_DENO:-/usr/local/bin/deno}"
SANDBOX_HOME="${STUDIOBOXD_HOME:-/home/app}"
DEFAULT_VSOCK_PORT="1024"

mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true

mkdir -p /overlay
if ! mount -t ext4 "$OVERLAY_DEV" /overlay 2>/dev/null; then
  # Fresh sparse overlay: format once, then mount.
  mkfs.ext4 -q "$OVERLAY_DEV"
  mount -t ext4 "$OVERLAY_DEV" /overlay
fi
mkdir -p /overlay/upper /overlay/work /mnt/root

mount -t overlay overlay \
  -o "lowerdir=/,upperdir=/overlay/upper,workdir=/overlay/work" \
  /mnt/root

# Parse the studiobox.* boot-config tokens out of the kernel cmdline.
VSOCK_PORT=""
TOKEN_HEX=""
for tok in $(cat /proc/cmdline); do
  case "$tok" in
    studiobox.vsock_port=*) VSOCK_PORT="${tok#studiobox.vsock_port=}" ;;
    studiobox.token=*) TOKEN_HEX="${tok#studiobox.token=}" ;;
  esac
done
[ -n "$VSOCK_PORT" ] || VSOCK_PORT="$DEFAULT_VSOCK_PORT"

if [ -z "$TOKEN_HEX" ]; then
  echo "overlay-init: FATAL no studiobox.token= in kernel cmdline" >&2
  exit 1
fi

# Re-home the API mounts inside the writable overlay, then chroot into it so
# studioboxd — and every process it spawns — sees the overlay as `/`: the
# sandbox home is a real writable `/home/app`, and the confinement root is
# `/` (DESIGN.md §7/§10). The read-only golden root is left behind.
mkdir -p /mnt/root/proc /mnt/root/sys /mnt/root/dev /mnt/root/run
mount -t proc proc /mnt/root/proc 2>/dev/null || true
mount -t sysfs sysfs /mnt/root/sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /mnt/root/dev 2>/dev/null ||
  mount --bind /dev /mnt/root/dev

# Materialize the credential (0600) inside the new root's /run — never on the
# read-only golden root. studioboxd reads it at the in-chroot path.
TOKEN_FILE="/run/studioboxd.token"
( umask 077; printf '%s' "$TOKEN_HEX" > "/mnt/root${TOKEN_FILE}" )

echo "overlay-init: overlay mounted at /mnt/root, launching studioboxd on vsock port $VSOCK_PORT"
exec chroot /mnt/root "$AGENT" \
  --vsock-port "$VSOCK_PORT" \
  --token-file "$TOKEN_FILE" \
  --deno "$DENO_BIN" \
  --home "$SANDBOX_HOME"
