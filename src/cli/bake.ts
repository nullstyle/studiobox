/**
 * The in-guest golden-artifact bake, wired into `studiobox host up --bake`
 * (PLAN.md §M5/§M9). Turns a bare provisioned host into a `Sandbox.create()`-
 * capable one with zero manual steps, from a local checkout.
 *
 * It reproduces the sequence `tools/lima_vm_test.ts` proves on real fc-smoke
 * hardware, driven entirely through the {@linkcode HostEnv} seam so it is
 * unit-testable against a fake with no VM:
 *
 *   1. `probe`  — reuse a cached set: if the durable pointer + its cache dir
 *                 exist, return that hash (skipped under `rebuild`);
 *   2. `deno`   — install Deno in the guest (idempotent, unprivileged);
 *   3. `sync`   — ship the source tree in (git-tracked tarball → `limactl cp` →
 *                 extract; the host VM is mount-less). Skipped under `no-lima`,
 *                 where the host IS the guest and the checkout is already local;
 *   4. `build`  — `sudo -E deno run tools/build_golden_set.ts` into the cache
 *                 rootd reads, capturing the final JSON line for the hash;
 *   5. record the durable pointer AFTER a fully successful bake.
 *
 * The build's stderr is redirected to a user-writable logfile and its stdout is
 * piped through `tail -n1`, so the one ~120-byte result line is captured intact
 * regardless of debootstrap's (large, package-count-dependent) log volume — the
 * runner otherwise truncates captured output at 64 KiB.
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";
import type { ArtifactArch } from "../../images/pins.ts";
import { GUEST_CACHE_DIR, GUEST_STATE_DIR } from "./guest_layout.ts";
import { type HostEnv, shellQuote } from "./host_env.ts";
import type { LocalFs } from "./local_fs.ts";

// Transient work lives in USER-WRITABLE /tmp (matches lima_vm_test.ts): the
// non-root shell owns the stderr redirect + `tail` pipe, and the tarball lands
// somewhere `limactl cp` (the unprivileged lima user) can write. Only the cache
// and the pointer are durable + root-owned.
const BAKE_DIR = "/tmp/studiobox-bake";
const BAKE_REPO = `${BAKE_DIR}/repo`;
const BAKE_BUILD = `${BAKE_DIR}/build`;
const BAKE_TGZ = `${BAKE_DIR}/repo.tgz`;
/** Uncapped build log (stderr): the failure path tails it for diagnostics. */
export const BAKE_LOG = `${BAKE_DIR}/build.log`;
/** Durable, root-owned pointer to the last successfully-baked manifest hash. */
const GOLDEN_HASH_FILE = `${GUEST_STATE_DIR}/golden.hash`;

const HASH_RE = /^[0-9a-f]{64}$/;

/** Which phase of the bake failed (carried by {@linkcode BakeError}). */
export type BakePhase = "probe" | "sync" | "deno" | "build" | "parse";

/** A bake-specific failure (command failures surface as `CommandError`). */
export class BakeError extends Error {
  readonly phase: BakePhase;
  constructor(phase: BakePhase, message: string) {
    super(message);
    this.name = "BakeError";
    this.phase = phase;
  }
}

/**
 * Raised when `--bake` is requested but there is no local source tree to bake
 * from (the CLI was loaded from a remote registry). Thrown before any VM/guest
 * operation so a from-JSR `--bake` never orphans a half-created host.
 */
export class BakeSourceUnavailableError extends Error {
  constructor() {
    super(
      "host --bake needs a local checkout: the golden bake compiles the agent " +
        "and builds the rootfs from source, but this CLI was loaded from a " +
        "remote registry with no source tree. Clone the repo and run from it, " +
        "or bake manually (tools/build_golden_set.ts) and pass --manifest-hash.",
    );
    this.name = "BakeSourceUnavailableError";
  }
}

/** Inputs to {@linkcode bakeGoldenSet}. */
export interface BakeGoldenSetOptions {
  readonly env: HostEnv;
  readonly fs: LocalFs;
  readonly arch: ArtifactArch;
  /** Host repo root (a git working tree) the source tarball is built from. */
  readonly sourceRoot: string;
  /** Ignore the cache and always re-bake. @default false */
  readonly rebuild?: boolean;
  /** Progress sink. @default no-op */
  readonly log?: (line: string) => void;
}

/** Result of a bake: the manifest hash, the cache it landed in, and freshness. */
export interface BakeGoldenSetResult {
  readonly hash: string;
  /** Always {@link GUEST_CACHE_DIR} — where rootd's launch planner reads. */
  readonly cacheRoot: string;
  /** True when freshly baked; false on a cache-pointer hit. */
  readonly created: boolean;
}

/**
 * Resolve the host repo root when running from a local checkout, else
 * `undefined` (a `jsr:`/`https:` invocation has no source tree). Mirrors
 * {@linkcode import("./provision.ts").defaultCompatPath}'s `file:`-URL probe and
 * additionally confirms the bake entrypoint is on disk.
 */
export function defaultSourceRoot(): string | undefined {
  const url = import.meta.resolve("../../");
  if (!url.startsWith("file:")) return undefined;
  const root = fromFileUrl(url).replace(/\/$/, "");
  try {
    Deno.statSync(join(root, "tools", "build_golden_set.ts"));
    return root;
  } catch {
    return undefined;
  }
}

/**
 * Extract the manifest hash from the bake's captured stdout: the LAST non-empty
 * line must be `build_golden_set.ts`'s `{ "hash", … }` JSON with a 64-hex
 * `hash`. Pure + exported so a unit test pins the contract. Throws
 * {@linkcode BakeError} on a missing/malformed result line.
 */
export function parseBakeHash(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines.at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new BakeError(
      "parse",
      `bake did not print a result JSON line (got: ${last || "<empty>"})`,
    );
  }
  // Guard the shape before property access — `JSON.parse("null")` is a valid
  // parse that yields null, and `null.hash` would throw a raw TypeError.
  if (parsed === null || typeof parsed !== "object") {
    throw new BakeError(
      "parse",
      `bake result line is not a JSON object (got: ${last})`,
    );
  }
  const hash = (parsed as { hash?: unknown }).hash;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) {
    throw new BakeError(
      "parse",
      `bake result JSON has no valid 64-hex manifest hash (got: ${last})`,
    );
  }
  return hash;
}

/**
 * Bake (or reuse) the golden artifact set in the guest and return its manifest
 * hash. Idempotent: a warm host with a valid pointer skips the whole
 * multi-minute path. See the module doc for the phase sequence.
 */
export async function bakeGoldenSet(
  options: BakeGoldenSetOptions,
): Promise<BakeGoldenSetResult> {
  const { env, fs, arch, sourceRoot } = options;
  const log = options.log ?? (() => {});
  const rebuild = options.rebuild ?? false;

  // 1. probe: reuse a cached set (pointer file AND its cache dir must exist).
  if (!rebuild) {
    const probe = await env.guestExec(
      `if [ -f ${GOLDEN_HASH_FILE} ]; then h="$(cat ${GOLDEN_HASH_FILE})"; ` +
        `[ -d "${GUEST_CACHE_DIR}/$h" ] && printf '%s' "$h" || true; fi`,
      { sudo: true },
    );
    const cached = probe.stdout.trim();
    if (HASH_RE.test(cached)) {
      log(`bake: reusing cached golden set ${cached.slice(0, 12)}…`);
      return { hash: cached, cacheRoot: GUEST_CACHE_DIR, created: false };
    }
  }

  // 2. prep the user-writable work tree (also creates the parent for BAKE_LOG).
  await env.guestExec(`mkdir -p ${BAKE_BUILD}`, { check: true });

  // 3. install Deno in the guest (idempotent, as the unprivileged user).
  await env.guestExec(
    `export PATH="$HOME/.deno/bin:$PATH"; command -v deno >/dev/null || ` +
      `(curl -fsSL https://deno.land/install.sh | sh -s -- -y)`,
    { check: true },
  );

  // 4. ship the source tree in (mount-less host VM). Skipped under no-lima,
  //    where the checkout is already local.
  if (env.mode !== "no-lima") {
    const listResult = await env.hostExec(
      "git",
      ["-C", sourceRoot, "ls-files", "-co", "--exclude-standard"],
      // uncapped: the file list grows with the repo and would otherwise be
      // silently truncated at the runner's 64 KiB cap, feeding tar a partial
      // (or mid-path-cut) list.
      { check: true, uncapped: true },
    );
    if (listResult.stdout.trim() === "") {
      throw new BakeError(
        "sync",
        `no git-tracked files under ${sourceRoot} — is it a studiobox checkout?`,
      );
    }
    const listPath = await fs.makeTempFile(listResult.stdout);
    const tgzPath = await fs.makeTempFile("");
    try {
      await env.hostExec(
        "tar",
        ["--no-xattrs", "-czf", tgzPath, "-C", sourceRoot, "-T", listPath],
        { check: true },
      );
      await env.copyFileIn(tgzPath, BAKE_TGZ);
      await env.guestExec(
        `rm -rf ${BAKE_REPO} && mkdir -p ${BAKE_REPO} && ` +
          `tar --warning=no-unknown-keyword -xzf ${BAKE_TGZ} -C ${BAKE_REPO} && ` +
          `rm -f ${BAKE_TGZ} && find ${BAKE_REPO} -name '._*' -delete`,
        { check: true },
      );
    } finally {
      await fs.remove(listPath);
      await fs.remove(tgzPath);
    }
  }

  // 5. build. Elevate ONLY the deno process (so the redirect + pipe stay owned
  //    by the user), send stderr to the uncapped log, and `tail -n1` so the one
  //    JSON result line survives the runner's 64 KiB stdout cap.
  const repoDir = env.mode === "no-lima" ? sourceRoot : BAKE_REPO;
  log(
    `bake: building the golden set (multi-minute; debootstrap downloads a base ` +
      `OS; \`tail -f ${BAKE_LOG}\` in the guest to watch)…`,
  );
  const built = await env.guestExec(
    `export PATH="$HOME/.deno/bin:$PATH"; cd ${shellQuote(repoDir)}; ` +
      `sudo -E "$(command -v deno)" run -A tools/build_golden_set.ts ` +
      `--arch ${arch} --cache-root ${GUEST_CACHE_DIR} --work ${BAKE_BUILD} ` +
      `2>${BAKE_LOG} | tail -n1`,
    { check: true },
  );
  const hash = parseBakeHash(built.stdout);

  // 6. record the durable pointer only AFTER a fully successful bake+store, so
  //    an interrupted bake never poisons the cache probe.
  await env.guestExec(
    `printf '%s' ${hash} | sudo tee ${GOLDEN_HASH_FILE} >/dev/null`,
    { check: true },
  );
  log(`bake: golden set ${hash.slice(0, 12)}… ready`);
  return { hash, cacheRoot: GUEST_CACHE_DIR, created: true };
}
