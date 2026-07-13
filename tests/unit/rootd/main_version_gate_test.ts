/**
 * Host-safe coverage of the snapshot-restore Firecracker version gate
 * (snapshot-restore §5.5, WI-7): the snapshot strategy REQUIRES `vsock_override`
 * (Firecracker v1.16); a host on the compat MIN (v1.15) must fall SAFE to cold.
 */

import { assert, assertEquals } from "@std/assert";

import { assertThrows } from "@std/assert";
import {
  compareFirecrackerVersions,
  firecrackerSupportsSnapshotRestore,
  MIN_SNAPSHOT_FIRECRACKER_VERSION,
  parseFirecrackerVersionOutput,
} from "../../../src/rootd/main.ts";

Deno.test("compareFirecrackerVersions orders major/minor/patch, ignoring v + suffix", () => {
  assert(compareFirecrackerVersions("v1.16.1", "1.16.0") > 0);
  assert(compareFirecrackerVersions("1.15.0", "v1.16.0") < 0);
  assertEquals(compareFirecrackerVersions("1.16.0", "v1.16.0"), 0);
  assertEquals(compareFirecrackerVersions("v1.16.1-rc2", "1.16.1"), 0);
  assert(compareFirecrackerVersions("2.0.0", "1.99.99") > 0);
});

Deno.test("snapshot version gate: >= v1.16 supports vsock_override, v1.15 does not", () => {
  assertEquals(MIN_SNAPSHOT_FIRECRACKER_VERSION, "1.16.0");
  // The pinned binary (v1.16.1) qualifies.
  assert(firecrackerSupportsSnapshotRestore("v1.16.1"));
  assert(firecrackerSupportsSnapshotRestore("1.16.0"));
  assert(firecrackerSupportsSnapshotRestore("v2.0.0"));
  // The compat MIN (v1.15) must NOT select snapshot — fail safe toward cold.
  assert(!firecrackerSupportsSnapshotRestore("v1.15.0"));
  assert(!firecrackerSupportsSnapshotRestore("1.15.9"));
  // An unparseable version reads as 0.0.0 ⇒ cold (fail-closed).
  assert(!firecrackerSupportsSnapshotRestore("garbage"));
});

Deno.test("parseFirecrackerVersionOutput extracts the version from `firecracker --version` (FINDING 3 ground truth)", () => {
  // The real binary prints e.g. "Firecracker v1.16.1\n" (sometimes with build
  // metadata on following lines); the gate must read GROUND TRUTH from it.
  assertEquals(
    parseFirecrackerVersionOutput("Firecracker v1.16.1\n"),
    "1.16.1",
  );
  assertEquals(
    parseFirecrackerVersionOutput("Firecracker v1.15.0\nsupported: ...\n"),
    "1.15.0",
  );
  assertEquals(parseFirecrackerVersionOutput("1.16.1"), "1.16.1");
  // A capable/incapable host composes with the gate off the PROBED version, so a
  // real v1.15 host never wrongly selects snapshot.
  assert(
    firecrackerSupportsSnapshotRestore(
      parseFirecrackerVersionOutput("Firecracker v1.16.1"),
    ),
  );
  assert(
    !firecrackerSupportsSnapshotRestore(
      parseFirecrackerVersionOutput("Firecracker v1.15.0"),
    ),
  );
  // Unparseable output THROWS so the caller falls SAFE to cold (never defaults).
  assertThrows(() => parseFirecrackerVersionOutput("no version here"));
});
