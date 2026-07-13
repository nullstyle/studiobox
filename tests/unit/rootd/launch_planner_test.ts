/**
 * Host-safe coverage of {@link GoldenArtifactLaunchPlanner} (PLAN.md §M5):
 * the plan shape (jailer/stage/config boot recipe), the credential mint, and
 * the M4 refcount discipline — acquire-before-journal on resolve, release on
 * the reclaim hook, and undo-on-failure. No VM, no jailer: `resolve()` only
 * touches the artifact cache + the overlay temp file.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

import { ArtifactCache } from "../../../images/cache.ts";
import {
  ArtifactReclaimHook,
  GoldenArtifactLaunchPlanner,
} from "../../../src/rootd/launch_planner.ts";
import { SupervisorError } from "../../../src/rootd/supervisor_core_api.ts";
import type { SupervisorLaunchRequest } from "../../../src/rootd/supervisor_core_api.ts";
import type { SandboxRecord } from "../../../src/state/model.ts";

const HASH = "a".repeat(64);

/** Materialize a bare cached set (dir + refcount.json) — enough for resolve. */
async function seedCache(root: string, hash = HASH): Promise<void> {
  const dir = join(root, hash);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "refcount.json"),
    JSON.stringify({ schemaVersion: 1, count: 0 }) + "\n",
  );
}

function request(
  overrides: Partial<SupervisorLaunchRequest> = {},
): SupervisorLaunchRequest {
  return {
    sandboxId: "sbx-plan",
    executionId: "e-plan-1",
    artifactId: "artifact-golden",
    allocationId: "alloc-1",
    bootNonce: new Uint8Array(32),
    idempotencyKey: new Uint8Array(16),
    ...overrides,
  };
}

async function withDirs(
  fn: (cacheRoot: string, workDir: string) => Promise<void>,
): Promise<void> {
  const cacheRoot = await Deno.makeTempDir({ prefix: "sbx-plan-cache-" });
  const workDir = await Deno.makeTempDir({ prefix: "sbx-plan-work-" });
  try {
    await fn(cacheRoot, workDir);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true }).catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

function plannerFor(
  cacheRoot: string,
  workDir: string,
): GoldenArtifactLaunchPlanner {
  return new GoldenArtifactLaunchPlanner({
    cache: new ArtifactCache({ root: cacheRoot }),
    manifestHash: HASH,
    arch: "aarch64",
    jailerBin: "/usr/local/bin/jailer",
    firecrackerBin: "/usr/local/bin/firecracker",
    uid: 0,
    gid: 0,
    chrootBaseDir: join(workDir, "jail"),
    overlayDir: join(workDir, "ov"),
  });
}

Deno.test("planner: resolve emits the boot recipe and acquires the refcount", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const cache = new ArtifactCache({ root: cacheRoot });
    const planner = plannerFor(cacheRoot, workDir);

    const plan = await planner.resolve(request());

    // The artifact belt is held before the plan is ever journaled.
    assertEquals(await cache.refcount(HASH), 1, "acquire-before-journal");
    assertEquals(plan.artifact, { manifestHash: HASH, arch: "aarch64" });
    assertEquals(plan.agentVsockPort, 1024);

    // Jailer: copy staging (the adapter enforces copy mode), no id/stage.
    assertEquals(plan.jailer.jailerBin, "/usr/local/bin/jailer");
    assertEquals(plan.jailer.uid, 0);
    assertEquals(plan.stage.map((s) => s.jailPath), [
      "/vmlinux",
      "/rootfs.ext4",
      "/overlay.ext4",
    ]);
    assertEquals(plan.stage[0].hostPath, join(cacheRoot, HASH, "vmlinux"));
    assertEquals(plan.stage[2].readWrite, true, "overlay is read-write");

    // Boot recipe: root device, overlay-init, and the vsock/token cmdline.
    const bootArgs = plan.config.boot_source?.boot_args ?? "";
    assert(bootArgs.includes("root=/dev/vda"), bootArgs);
    assert(bootArgs.includes("init=/sbin/overlay-init"), bootArgs);
    assert(bootArgs.includes("studiobox.vsock_port=1024"), bootArgs);
    assert(/studiobox\.token=[0-9a-f]{64}/.test(bootArgs), bootArgs);
    assertEquals(plan.config.vsock?.guest_cid, 3);
    assertEquals(plan.config.drives?.[0].is_read_only, true);
    assertEquals(plan.config.drives?.[1].is_read_only, false);

    // The credential the host will present to studioboxd matches the cmdline.
    const coordinates = planner.coordinatesFor("e-plan-1")!;
    assertEquals(coordinates.credential.byteLength, 32);
    assertEquals(coordinates.vsockPort, 1024);
    const tokenHex = /studiobox\.token=([0-9a-f]{64})/.exec(bootArgs)![1];
    let hostHex = "";
    for (const b of coordinates.credential) {
      hostHex += b.toString(16).padStart(2, "0");
    }
    assertEquals(hostHex, tokenHex, "cmdline token == host credential");

    // The fresh overlay exists (sparse) for the adapter to stage.
    const overlay = join(workDir, "ov", "ov-e-plan-1.ext4");
    assertEquals((await Deno.stat(overlay)).size, 256 * 1024 * 1024);
  });
});

Deno.test("planner: request.vcpus overrides the static default in machine_config", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const planner = plannerFor(cacheRoot, workDir);

    // The request's vcpus (validated 1..64 upstream) reaches the guest.
    const plan = await planner.resolve(request({ vcpus: 4 }));
    assertEquals(plan.config.machine_config?.vcpu_count, 4);

    // Absent vcpus falls back to the planner's static default (1).
    const dflt = await planner.resolve(request({ executionId: "e-plan-2" }));
    assertEquals(dflt.config.machine_config?.vcpu_count, 1);
  });
});

Deno.test("planner: reclaim hook releases the refcount and deletes the overlay", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const cache = new ArtifactCache({ root: cacheRoot });
    const planner = plannerFor(cacheRoot, workDir);
    await planner.resolve(request());
    assertEquals(await cache.refcount(HASH), 1);
    const overlay = join(workDir, "ov", "ov-e-plan-1.ext4");

    const record = {
      artifact: { manifestHash: HASH, arch: "aarch64" },
      machine: { executionId: "e-plan-1" },
    } as unknown as SandboxRecord;
    await planner.reclaimHook.reclaim(record);

    assertEquals(await cache.refcount(HASH), 0, "belt released on terminate");
    assertEquals(
      await Deno.stat(overlay).then(() => true, () => false),
      false,
      "overlay removed on terminate",
    );
  });
});

Deno.test("planner: an unknown artifact set fails closed and holds no refcount", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    // Cache empty: the golden set is not present.
    const planner = plannerFor(cacheRoot, workDir);
    const error = await assertRejects(
      () => planner.resolve(request()),
      SupervisorError,
    );
    assertEquals(error.code, "SBX_SUP_UNAVAILABLE");
    // No overlay leaked either.
    assertEquals(
      await Deno.stat(join(workDir, "ov", "ov-e-plan-1.ext4")).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

Deno.test("planner: a mid-resolve failure undoes the acquire (no leak)", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const cache = new ArtifactCache({ root: cacheRoot });
    const planner = new GoldenArtifactLaunchPlanner({
      cache,
      manifestHash: HASH,
      arch: "aarch64",
      jailerBin: "/usr/local/bin/jailer",
      firecrackerBin: "/usr/local/bin/firecracker",
      uid: 0,
      gid: 0,
      chrootBaseDir: join(workDir, "jail"),
      overlayDir: join(workDir, "ov"),
      // A credential of the wrong size makes resolve throw AFTER acquire.
      mintCredential: () => new Uint8Array(8),
    });
    await assertRejects(() => planner.resolve(request()), SupervisorError);
    assertEquals(
      await cache.refcount(HASH),
      0,
      "acquire is undone when the plan never reaches the journal",
    );
  });
});

Deno.test("reclaim hook: no artifact reference is a no-op", async () => {
  await withDirs(async (cacheRoot) => {
    const cache = new ArtifactCache({ root: cacheRoot });
    const hook = new ArtifactReclaimHook(cache, () => "/nonexistent/ov.ext4");
    // A record without an artifact ref (schema-v1) must not throw.
    await hook.reclaim({ machine: {} } as unknown as SandboxRecord);
  });
});
