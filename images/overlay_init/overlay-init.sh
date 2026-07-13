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
#   studiobox.ip=<CIDR>           Static guest address for eth0 (e.g.
#                                 10.201.0.2/30; M10 networking). Absent for a
#                                 netless sandbox — then eth0 is left down.
#   studiobox.gw=<IP>             Default gateway (the host TAP address).
#   studiobox.dns=<IP>            Resolver written to /etc/resolv.conf (the
#                                 per-sandbox dnsmasq on the gateway).
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
GUEST_IP=""
GUEST_GW=""
GUEST_DNS=""
for tok in $(cat /proc/cmdline); do
  case "$tok" in
    studiobox.vsock_port=*) VSOCK_PORT="${tok#studiobox.vsock_port=}" ;;
    studiobox.token=*) TOKEN_HEX="${tok#studiobox.token=}" ;;
    studiobox.ip=*) GUEST_IP="${tok#studiobox.ip=}" ;;
    studiobox.gw=*) GUEST_GW="${tok#studiobox.gw=}" ;;
    studiobox.dns=*) GUEST_DNS="${tok#studiobox.dns=}" ;;
  esac
done
[ -n "$VSOCK_PORT" ] || VSOCK_PORT="$DEFAULT_VSOCK_PORT"

if [ -z "$TOKEN_HEX" ]; then
  echo "overlay-init: FATAL no studiobox.token= in kernel cmdline" >&2
  exit 1
fi

# Bring up the guest NIC from the studiobox.ip/gw tokens (M10 networking). This
# is namespace-wide, so it survives the chroot below and studioboxd inherits it.
# Best-effort: a netless sandbox has no studiobox.ip (eth0 stays down), the
# kernel `ip=` autoconfig may have already configured eth0, and a transient
# failure must NOT brick the boot — so every step is guarded (set -eu is on).
if [ -n "$GUEST_IP" ]; then
  ip link set eth0 up 2>/dev/null || true
  ip addr add "$GUEST_IP" dev eth0 2>/dev/null || true
  if [ -n "$GUEST_GW" ]; then
    ip route add default via "$GUEST_GW" 2>/dev/null || true
  fi
  echo "overlay-init: eth0 configured $GUEST_IP gw ${GUEST_GW:-none}"
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

# Point the guest resolver at the per-sandbox dnsmasq (studiobox.dns). Written
# into the writable overlay's /etc, never the read-only golden root.
if [ -n "$GUEST_DNS" ]; then
  mkdir -p /mnt/root/etc
  printf 'nameserver %s\n' "$GUEST_DNS" > /mnt/root/etc/resolv.conf
fi

echo "overlay-init: overlay mounted at /mnt/root, launching studioboxd on vsock port $VSOCK_PORT"
exec chroot /mnt/root "$AGENT" \
  --vsock-port "$VSOCK_PORT" \
  --token-file "$TOKEN_FILE" \
  --deno "$DENO_BIN" \
  --home "$SANDBOX_HOME"
