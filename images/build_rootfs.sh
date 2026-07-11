#!/usr/bin/env bash
# Golden rootfs builder (PLAN.md M4 item 5, DESIGN.md §7).
#
# Debootstraps a minbase Debian tree against a pinned snapshot.debian.org
# epoch, adds the sandbox user (uid 1000, home /home/app), installs the
# pinned linux Deno, the agent binary (M4: the committed placeholder —
# see images/agent/), and the overlay-init stub, normalizes everything
# reproducibility-relevant, emits the canonical content manifest via
# images/emit_content_manifest.ts, and packs a fixed-UUID ext4 image.
#
# Runs on Linux as root (loop-free: mke2fs -d needs no mounts). Defaults
# mirror images/pins.json; the driver passes pins explicitly so the
# script sha256 — an input pin in the manifest — never encodes drift.
#
# Reproducibility levers: SOURCE_DATE_EPOCH derived from the snapshot
# epoch, fixed filesystem UUID + directory hash_seed, tree-wide mtime
# clamp, shadow last-change normalization. If raw-image byte identity
# still drifts across builds, the content manifest hash (also printed) is
# the documented fallback identity (manifest.ts `rootfs.identity.kind`).
set -euo pipefail

ARCH="aarch64"
SUITE="bookworm"
EPOCH="20260630T210956Z"
MIRROR=""
PACKAGES="ca-certificates,e2fsprogs"
IMAGE_SIZE_MIB="1024"
SANDBOX_USER="sandbox"
SANDBOX_UID="1000"
SANDBOX_HOME="/home/app"
DENO_URL=""
DENO_SHA256=""
DENO_BIN=""
AGENT=""
OVERLAY_INIT=""
OUT=""

# Fixed identity for reproducible mke2fs runs (covered by this script's
# sha256, which is itself an input pin).
FS_UUID="b2fc2d29-4b69-4a35-9ef3-1a1b3fa2d0a1"
FS_LABEL="studiobox-rootfs"
SHADOW_LASTCHG="20000"

usage() {
  cat >&2 <<'EOF'
usage: build_rootfs.sh --out DIR --deno-url URL --deno-sha256 HEX \
         --agent FILE --overlay-init FILE \
         [--arch aarch64|x86_64] [--suite NAME] [--epoch YYYYMMDDTHHMMSSZ] \
         [--mirror URL] [--packages a,b] [--image-size-mib N] \
         [--sandbox-user NAME] [--sandbox-uid N] [--sandbox-home PATH] \
         [--deno-bin FILE]
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2" ;;
    --suite) SUITE="$2" ;;
    --epoch) EPOCH="$2" ;;
    --mirror) MIRROR="$2" ;;
    --packages) PACKAGES="$2" ;;
    --image-size-mib) IMAGE_SIZE_MIB="$2" ;;
    --sandbox-user) SANDBOX_USER="$2" ;;
    --sandbox-uid) SANDBOX_UID="$2" ;;
    --sandbox-home) SANDBOX_HOME="$2" ;;
    --deno-url) DENO_URL="$2" ;;
    --deno-sha256) DENO_SHA256="$2" ;;
    --deno-bin) DENO_BIN="$2" ;;
    --agent) AGENT="$2" ;;
    --overlay-init) OVERLAY_INIT="$2" ;;
    --out) OUT="$2" ;;
    *) usage ;;
  esac
  shift 2
done

[ -n "$OUT" ] && [ -n "$DENO_URL" ] && [ -n "$DENO_SHA256" ] &&
  [ -n "$AGENT" ] && [ -n "$OVERLAY_INIT" ] || usage
[ "$(id -u)" = "0" ] || { echo "must run as root (mke2fs -d ownership)" >&2; exit 1; }

case "$ARCH" in
  aarch64) DEB_ARCH="arm64" ;;
  x86_64) DEB_ARCH="amd64" ;;
  *) echo "unsupported arch $ARCH" >&2; exit 1 ;;
esac
[ -n "$MIRROR" ] || MIRROR="https://snapshot.debian.org/archive/debian/${EPOCH}/"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DATE_EPOCH="$(date -ud "${EPOCH:0:4}-${EPOCH:4:2}-${EPOCH:6:2} ${EPOCH:9:2}:${EPOCH:11:2}:${EPOCH:13:2}" +%s)"
export SOURCE_DATE_EPOCH

ROOT="$OUT/rootfs"
mkdir -p "$OUT"
rm -rf "$ROOT"

echo "== debootstrap $SUITE ($DEB_ARCH, variant=minbase) from $MIRROR"
debootstrap --variant=minbase --arch="$DEB_ARCH" --include="$PACKAGES" \
  "$SUITE" "$ROOT" "$MIRROR"

umount -lf "$ROOT/proc" 2>/dev/null || true
umount -lf "$ROOT/sys" 2>/dev/null || true

echo "== sandbox user ($SANDBOX_USER uid=$SANDBOX_UID home=$SANDBOX_HOME)"
# Direct passwd-file edits: deterministic, no in-chroot exec, cross-arch.
echo "${SANDBOX_USER}:x:${SANDBOX_UID}:${SANDBOX_UID}:studiobox sandbox:${SANDBOX_HOME}:/bin/sh" >> "$ROOT/etc/passwd"
echo "${SANDBOX_USER}:x:${SANDBOX_UID}:" >> "$ROOT/etc/group"
echo "${SANDBOX_USER}:!:${SHADOW_LASTCHG}:0:99999:7:::" >> "$ROOT/etc/shadow"
mkdir -p "$ROOT$SANDBOX_HOME"
chown "$SANDBOX_UID:$SANDBOX_UID" "$ROOT$SANDBOX_HOME"
chmod 0755 "$ROOT$SANDBOX_HOME"

echo "== pinned guest Deno"
curl -fsSL "$DENO_URL" -o "$OUT/deno.zip"
echo "$DENO_SHA256  $OUT/deno.zip" | sha256sum -c -
rm -rf "$OUT/deno-extract"
mkdir -p "$OUT/deno-extract"
unzip -oq "$OUT/deno.zip" -d "$OUT/deno-extract"
install -m 0755 -o root -g root "$OUT/deno-extract/deno" "$ROOT/usr/local/bin/deno"

echo "== agent + overlay-init"
install -m 0755 -o root -g root "$AGENT" "$ROOT/usr/local/bin/studioboxd"
install -m 0755 -o root -g root "$OVERLAY_INIT" "$ROOT/sbin/overlay-init"

echo "== normalize for reproducibility"
rm -rf "$ROOT"/var/cache/apt "$ROOT"/var/lib/apt/lists
mkdir -p "$ROOT/var/cache/apt" "$ROOT/var/lib/apt/lists/partial"
rm -rf "$ROOT"/var/log
mkdir -p "$ROOT/var/log"
rm -f "$ROOT"/var/cache/ldconfig/aux-cache
rm -f "$ROOT"/etc/resolv.conf
[ -f "$ROOT/etc/machine-id" ] && : > "$ROOT/etc/machine-id"
echo "studiobox" > "$ROOT/etc/hostname"
# Normalize shadow last-change days (set at build time by debootstrap).
awk -F: -v OFS=: -v d="$SHADOW_LASTCHG" '{ if ($3 ~ /^[0-9]+$/) $3 = d; print }' \
  "$ROOT/etc/shadow" > "$ROOT/etc/shadow.tmp"
chmod 0640 "$ROOT/etc/shadow.tmp"
chown 0:42 "$ROOT/etc/shadow.tmp" 2>/dev/null || chown 0:0 "$ROOT/etc/shadow.tmp"
mv "$ROOT/etc/shadow.tmp" "$ROOT/etc/shadow"
if [ -f "$ROOT/etc/shadow-" ]; then
  awk -F: -v OFS=: -v d="$SHADOW_LASTCHG" '{ if ($3 ~ /^[0-9]+$/) $3 = d; print }' \
    "$ROOT/etc/shadow-" > "$ROOT/etc/shadow-.tmp"
  chmod 0640 "$ROOT/etc/shadow-.tmp"
  chown 0:42 "$ROOT/etc/shadow-.tmp" 2>/dev/null || chown 0:0 "$ROOT/etc/shadow-.tmp"
  mv "$ROOT/etc/shadow-.tmp" "$ROOT/etc/shadow-"
fi
find "$ROOT" -depth -print0 | xargs -0r touch -h -d "@$SOURCE_DATE_EPOCH"

echo "== content manifest"
[ -n "$DENO_BIN" ] || DENO_BIN="$ROOT/usr/local/bin/deno"
DENO_DIR="$OUT/deno-cache" DENO_NO_UPDATE_CHECK=1 \
  "$DENO_BIN" run --allow-read="$ROOT" \
  "$SCRIPT_DIR/emit_content_manifest.ts" "$ROOT" > "$OUT/rootfs.manifest.txt"

echo "== ext4 image (${IMAGE_SIZE_MIB} MiB, uuid $FS_UUID)"
rm -f "$OUT/rootfs.ext4"
mke2fs -q -F -t ext4 -b 4096 -d "$ROOT" \
  -U "$FS_UUID" -E hash_seed="$FS_UUID" -L "$FS_LABEL" \
  "$OUT/rootfs.ext4" "${IMAGE_SIZE_MIB}M"

echo "== results"
du -sh "$ROOT" | awk '{print "rootfs tree: " $1}'
ls -l "$OUT/rootfs.ext4" | awk '{print "image bytes: " $5}'
sha256sum "$OUT/rootfs.ext4" "$OUT/rootfs.manifest.txt"
