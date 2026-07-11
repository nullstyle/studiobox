#!/bin/sh
# studioboxd placeholder (M4 seam).
#
# This tiny script stands in for the compiled `studioboxd` agent binary in
# golden rootfs builds until the real agent exists. THE SWAP POINT: when
# M3 delivers the compiled agent (proven bootable in M5), the builder's
# `--agent` argument switches from this script to the per-arch
# `deno compile` output, and the manifest's `agentBinary` entry flips
# `placeholder: false` with the real binary's sha256. Nothing else in the
# pipeline changes — the manifest hash changes automatically because the
# agent sha is an input pin.
#
# Behavior: announce ourselves on the console, then idle so a smoke-booted
# guest stays up for inspection instead of panicking init.
echo "studioboxd-placeholder: real agent not installed (M4 artifact seam)"
while :; do
  sleep 3600
done
