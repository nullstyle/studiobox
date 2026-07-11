#!/bin/sh
# overlay-init stub (M4; hardened for real boots in M5).
#
# Boot flow (DESIGN.md §7): the guest kernel mounts the golden rootfs
# copy read-only as /, with a fresh *sparse, unformatted* overlay file
# attached as /dev/vdb (staging cannot mkfs portably from the macOS
# host). This init formats the overlay on first boot, mounts a writable
# overlayfs over the read-only root, and execs the agent.
set -eu

OVERLAY_DEV="${OVERLAY_DEV:-/dev/vdb}"
AGENT="${STUDIOBOXD_BIN:-/usr/local/bin/studioboxd}"

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

# M5 will pivot_root into /mnt/root and re-bind the API mounts; the stub
# stops at proving the overlay is writable, then hands off to the agent.
echo "overlay-init: overlay mounted at /mnt/root, starting agent"
exec "$AGENT"
