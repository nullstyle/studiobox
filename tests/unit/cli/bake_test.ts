/**
 * Unit coverage for the in-guest golden bake (`src/cli/bake.ts`), driven against
 * the recording {@link FakeHostRunner} with NO VM: the exact host/guest argv
 * sequence, cache-hit skipping, `--rebuild`, no-lima, failure surfacing, and the
 * pure `parseBakeHash` contract + the "bake writes where rootd reads" invariant.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  BakeError,
  bakeGoldenSet,
  parseBakeHash,
} from "../../../src/cli/bake.ts";
import { GUEST_CACHE_DIR } from "../../../src/cli/guest_layout.ts";
import { buildLaunchConfig } from "../../../src/cli/provision.ts";
import { HostEnv } from "../../../src/cli/host_env.ts";
import { HostCommandError } from "../../../src/cli/exec.ts";
import { FakeHostRunner, FakeLocalFs } from "./cli_test_helpers.ts";

function makeEnv(
  runner: FakeHostRunner,
  mode: "lima" | "no-lima" = "lima",
): HostEnv {
  return new HostEnv({ runner, mode, name: "studiobox-host-aarch64" });
}

/** First index in the flattened command log whose line contains `needle`. */
function idxOf(lines: string[], needle: string): number {
  return lines.findIndex((l) => l.includes(needle));
}

Deno.test("bakeGoldenSet: lima cold bake syncs, builds, records the hash in order", async () => {
  const runner = new FakeHostRunner();
  runner.bakeHash = "c".repeat(64);
  const result = await bakeGoldenSet({
    env: makeEnv(runner),
    fs: new FakeLocalFs(),
    arch: "aarch64",
    sourceRoot: "/repo",
  });

  assertEquals(result.created, true);
  assertEquals(result.hash, "c".repeat(64));
  assertEquals(result.cacheRoot, GUEST_CACHE_DIR);

  const lines = runner.commandLines();
  const git = idxOf(lines, "git -C /repo ls-files -co --exclude-standard");
  const tar = idxOf(lines, "tar --no-xattrs -czf");
  const cp = idxOf(
    lines,
    "studiobox-host-aarch64:/tmp/studiobox-bake/repo.tgz",
  );
  const extract = idxOf(lines, "rm -rf /tmp/studiobox-bake/repo &&");
  const build = idxOf(
    lines,
    "build_golden_set.ts --arch aarch64 --cache-root /var/lib/studiobox/cache",
  );
  const marker = idxOf(lines, "tee /var/lib/studiobox/golden.hash");

  for (
    const [name, i] of Object.entries({ git, tar, cp, extract, build, marker })
  ) {
    assert(i >= 0, `expected a ${name} command`);
  }
  // Host tarball build → cp in → extract → bake → record pointer (AFTER bake).
  assert(git < tar && tar < cp && cp < extract, "sync order");
  assert(extract < build, "extract precedes the bake");
  assert(build < marker, "pointer is recorded only after the bake succeeds");
  // Capture defenses (guard against reorder/pipefail-drop regressions): the
  // build runs under `pipefail` (so deno's exit propagates past `tail`), and
  // stderr is redirected to the logfile BEFORE the `| tail -n1` that bounds
  // stdout to the one JSON line under the runner's 64 KiB cap.
  assert(
    lines[build].includes("set -euo pipefail"),
    "bake runs under pipefail",
  );
  assert(
    /2>\S*build\.log \| tail -n1/.test(lines[build]),
    "stderr → build.log precedes the tail pipe",
  );
});

Deno.test("bakeGoldenSet: a warm cache pointer skips the whole bake", async () => {
  const runner = new FakeHostRunner();
  runner.cachedGoldenHash = "d".repeat(64);
  const result = await bakeGoldenSet({
    env: makeEnv(runner),
    fs: new FakeLocalFs(),
    arch: "aarch64",
    sourceRoot: "/repo",
  });

  assertEquals(result.created, false);
  assertEquals(result.hash, "d".repeat(64));
  const lines = runner.commandLines();
  assert(idxOf(lines, "git -C /repo ls-files") < 0, "no source sync on a hit");
  assert(idxOf(lines, "tar --no-xattrs") < 0, "no tarball on a hit");
  assert(idxOf(lines, "build_golden_set.ts") < 0, "no bake on a hit");
});

Deno.test("bakeGoldenSet: --rebuild forces a fresh bake past a warm pointer", async () => {
  const runner = new FakeHostRunner();
  runner.cachedGoldenHash = "d".repeat(64);
  runner.bakeHash = "c".repeat(64);
  const result = await bakeGoldenSet({
    env: makeEnv(runner),
    fs: new FakeLocalFs(),
    arch: "aarch64",
    sourceRoot: "/repo",
    rebuild: true,
  });

  assertEquals(result.created, true);
  assertEquals(
    result.hash,
    "c".repeat(64),
    "fresh bake hash, not the cached one",
  );
  assert(idxOf(runner.commandLines(), "build_golden_set.ts") >= 0);
});

Deno.test("bakeGoldenSet: no-lima bakes locally with no sync (no limactl/git/tar/cp)", async () => {
  const runner = new FakeHostRunner();
  const result = await bakeGoldenSet({
    env: makeEnv(runner, "no-lima"),
    fs: new FakeLocalFs(),
    arch: "aarch64",
    sourceRoot: "/repo",
  });

  assertEquals(result.created, true);
  const lines = runner.commandLines();
  assert(
    !lines.some((l) => l.startsWith("limactl")),
    "no limactl under no-lima",
  );
  assert(idxOf(lines, "git -C /repo ls-files") < 0, "no host git sync");
  assert(idxOf(lines, "tar --no-xattrs") < 0, "no tarball");
  const build = idxOf(lines, "build_golden_set.ts");
  assert(
    build >= 0 && lines[build].includes("cd '/repo'"),
    "bakes in the checkout",
  );
});

Deno.test("bakeGoldenSet: a failing bake command rejects with HostCommandError", async () => {
  const runner = new FakeHostRunner();
  runner.bakeFails = true;
  await assertRejects(
    () =>
      bakeGoldenSet({
        env: makeEnv(runner),
        fs: new FakeLocalFs(),
        arch: "aarch64",
        sourceRoot: "/repo",
      }),
    HostCommandError,
  );
  // A failed bake never records the pointer.
  assert(
    idxOf(runner.commandLines(), "tee /var/lib/studiobox/golden.hash") < 0,
    "no pointer written on failure",
  );
});

Deno.test("parseBakeHash: takes the last JSON line; rejects junk", () => {
  const good = "debootstrap: pulling base…\n[images:build] stored\n" +
    JSON.stringify({ hash: "a".repeat(64), cacheRoot: "/c", created: true });
  assertEquals(parseBakeHash(good), "a".repeat(64));

  assertThrowsBakeError(() => parseBakeHash("not json at all"));
  assertThrowsBakeError(() => parseBakeHash(JSON.stringify({ hash: "short" })));
  assertThrowsBakeError(() => parseBakeHash(""));
  // `JSON.parse("null")` is a valid parse → must still be a BakeError, not a
  // raw TypeError from property access on null.
  assertThrowsBakeError(() => parseBakeHash("null"));
  assertThrowsBakeError(() => parseBakeHash("42"));
});

Deno.test("invariant: the bake writes to the cache rootd reads (GUEST_CACHE_DIR == artifactCache)", () => {
  const launch = buildLaunchConfig("aarch64", { manifestHash: "a".repeat(64) });
  assertEquals(GUEST_CACHE_DIR, launch.artifactCache);
});

function assertThrowsBakeError(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    assert(error instanceof BakeError, `expected BakeError, got ${error}`);
    assertEquals((error as BakeError).phase, "parse");
  }
  assert(threw, "expected parseBakeHash to throw");
}
