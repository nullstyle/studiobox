/**
 * Firecracker version comparison + the snapshot-restore ≥ v1.16 gate
 * (`docs/snapshot-restore.md` §5.5).
 *
 * The snapshot strategy REQUIRES `vsock_override`, added in Firecracker v1.16;
 * the compat window's MIN is v1.15.0. So the gate must depend on GROUND TRUTH —
 * the ACTUAL installed binary version ({@linkcode probeFirecrackerVersion}),
 * NOT a config field that defaults to the pinned version — and fail SAFE to cold
 * on any uncertainty. This module holds the shared primitives so both the
 * entrypoint gate ({@linkcode import("./main.ts")}) and the planner's per-request
 * template check ({@linkcode import("./launch_planner.ts")}) compare versions the
 * same way, with no circular import.
 *
 * @module
 */

/**
 * Least Firecracker version whose `PUT /snapshot/load` supports `vsock_override`
 * (snapshot-restore §5.5). Below this, the snapshot strategy must fall safe to
 * cold.
 */
export const MIN_SNAPSHOT_FIRECRACKER_VERSION = "1.16.0";

/**
 * Compare two Firecracker version strings (`"v1.16.1"` / `"1.15.0"`) as
 * `[major, minor, patch]`; returns <0, 0, or >0. Leading `v` and any
 * pre-release suffix (`-rc1`) are ignored; missing/garbage components read as 0
 * (fail-closed: an unparseable version compares as `0.0.0`).
 */
export function compareFirecrackerVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.trim().replace(/^v/i, "").split("-")[0].split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Version gate (§5.5): the snapshot strategy REQUIRES `vsock_override`, added in
 * Firecracker v1.16. A host below that (down to the compat min v1.15) must fall
 * safe to cold. Fail-closed: an unparseable version reads as 0.0.0 ⇒ cold.
 */
export function firecrackerSupportsSnapshotRestore(version: string): boolean {
  return compareFirecrackerVersions(
    version,
    MIN_SNAPSHOT_FIRECRACKER_VERSION,
  ) >= 0;
}

/**
 * Parse a Firecracker version (e.g. `"1.16.1"`) out of `firecracker --version`
 * output (typically `"Firecracker v1.16.1\n"`). Throws when no `major.minor.patch`
 * triple is present so the caller fails SAFE to cold rather than trusting a
 * default. Split from {@linkcode probeFirecrackerVersion} so the parse is
 * host-safe testable with no `--allow-run`.
 */
export function parseFirecrackerVersionOutput(text: string): string {
  const match = text.match(/v?(\d+\.\d+\.\d+)/);
  if (match === null) {
    throw new Error(
      `could not parse a firecracker version from: ${text.slice(0, 80)}`,
    );
  }
  return match[1];
}

/**
 * Probe the ACTUAL installed Firecracker version by running
 * `<firecrackerBin> --version` (snapshot-restore §5.5, ground truth for the
 * gate). Throws on a non-zero exit or unparseable output; the caller
 * ({@linkcode import("./main.ts").loadLaunchPlanner}) swallows any throw to cold
 * (fail-safe). Requires `--allow-run`.
 */
export async function probeFirecrackerVersion(
  firecrackerBin: string,
): Promise<string> {
  const output = await new Deno.Command(firecrackerBin, {
    args: ["--version"],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) {
    throw new Error(
      `${firecrackerBin} --version exited with code ${output.code}`,
    );
  }
  return parseFirecrackerVersionOutput(new TextDecoder().decode(output.stdout));
}
