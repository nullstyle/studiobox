/**
 * Host-safe coverage of the snapshot-restore strategy in
 * {@link GoldenArtifactLaunchPlanner} (snapshot-restore §4, §5.3, §5.4, WI-6):
 *
 *   - a `"snapshot"` strategy with a VALID template resolves a RESTORE plan
 *     (the `SnapshotLoadParams` + staging + personalize inputs + cold fallback),
 *     acquiring BOTH the golden-set AND the template refcount before it returns;
 *   - the template refcount is released on teardown by `templateReclaimHook`;
 *   - a MISSING / STALE-schema template, a NETLESS request, and the default
 *     `"cold"` strategy all FALL SAFE to a cold plan, pinning no template.
 *
 * No VM, no jailer: the dataplane is the REAL W1 controllers wired to fake
 * command runners (as in `launch_planner_network_test.ts`), and the template
 * store is a real on-disk store seeded with placeholder artifacts.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

import { ArtifactCache } from "../../../images/cache.ts";
import { GoldenArtifactLaunchPlanner } from "../../../src/rootd/launch_planner.ts";
import {
  type ResolvedTemplate,
  type TemplateExpectation,
  TemplateStore,
  TemplateStoreError,
} from "../../../src/rootd/template/mod.ts";
import type { SupervisorLaunchRequest } from "../../../src/rootd/supervisor_core_api.ts";
import type { SandboxRecord } from "../../../src/state/model.ts";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../src/rootd/network/apply.ts";
import { EgressController } from "../../../src/rootd/network/apply.ts";
import { BitmapSubnetAllocator } from "../../../src/rootd/network/allocator.ts";
import { NetworkController } from "../../../src/rootd/network/dataplane.ts";
import { DnsmasqController } from "../../../src/rootd/network/dnsmasq.ts";
import type { HostResolver } from "../../../src/rootd/network/resolver.ts";

const HASH = "c".repeat(64);
const SCHEMA =
  "e57b47d01998020890563649768ee387ae11ec6c076b9001848b4cfbb9b33144";

class FakeRunner implements CommandRunner {
  run(): Promise<EgressCommandResult> {
    return Promise.resolve({ success: true, code: 0, stderr: "" });
  }
}

const NO_RESOLVE: HostResolver = {
  resolve: () => Promise.resolve({ v4: [], v6: [] }),
};

function dataplane(): {
  allocator: BitmapSubnetAllocator;
  network: NetworkController;
  dnsmasq: DnsmasqController;
  egress: EgressController;
  upstreamDns: string;
} {
  return {
    allocator: new BitmapSubnetAllocator(),
    network: new NetworkController({ runner: new FakeRunner() }),
    dnsmasq: new DnsmasqController({ runner: new FakeRunner() }),
    egress: new EgressController({
      runner: new FakeRunner(),
      resolver: NO_RESOLVE,
    }),
    upstreamDns: "1.1.1.1",
  };
}

function request(
  overrides: Partial<SupervisorLaunchRequest> = {},
): SupervisorLaunchRequest {
  return {
    sandboxId: "sbx-snap",
    executionId: "e-snap-1",
    artifactId: "artifact-golden",
    allocationId: "alloc-1",
    bootNonce: new Uint8Array(32).fill(0x0b),
    idempotencyKey: new Uint8Array(16),
    ...overrides,
  };
}

async function seedCache(root: string): Promise<void> {
  const dir = join(root, HASH);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "refcount.json"),
    JSON.stringify({ schemaVersion: 1, count: 0 }) + "\n",
  );
}

/** Publish a placeholder template for HASH under `templateRoot`, at `schema`. */
async function seedTemplate(
  templateRoot: string,
  srcDir: string,
  schema = SCHEMA,
  firecrackerVersion = "1.16.1",
): Promise<TemplateStore> {
  const store = new TemplateStore({ root: templateRoot });
  await Deno.mkdir(srcDir, { recursive: true });
  const snap = join(srcDir, "snapshot");
  const mem = join(srcDir, "mem");
  const overlay = join(srcDir, "overlay");
  await Deno.writeTextFile(snap, "SNAPSHOT-STATE");
  await Deno.writeTextFile(mem, "GUEST-MEMORY-IMAGE");
  await Deno.writeTextFile(overlay, "OVERLAY-EXT4");
  await store.publish({
    metadata: {
      manifestHash: HASH,
      schemaSha256: schema,
      firecrackerVersion,
      arch: "aarch64",
      vcpuCount: 1,
      memSizeMib: 512,
      vsockPort: 1024,
    },
    files: { snapshot: snap, mem, overlay },
  });
  return store;
}

async function withDirs(
  fn: (dirs: {
    cacheRoot: string;
    workDir: string;
    templateRoot: string;
    srcDir: string;
  }) => Promise<void>,
): Promise<void> {
  const cacheRoot = await Deno.makeTempDir({ prefix: "sbx-snap-cache-" });
  const workDir = await Deno.makeTempDir({ prefix: "sbx-snap-work-" });
  const templateRoot = await Deno.makeTempDir({ prefix: "sbx-snap-tpl-" });
  const srcDir = await Deno.makeTempDir({ prefix: "sbx-snap-src-" });
  try {
    await fn({ cacheRoot, workDir, templateRoot, srcDir });
  } finally {
    for (const dir of [cacheRoot, workDir, templateRoot, srcDir]) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  }
}

function plannerFor(
  cacheRoot: string,
  workDir: string,
  extra: {
    launchStrategy?: "cold" | "snapshot";
    templateStore?: TemplateStore;
    schemaSha256?: string;
    firecrackerVersion?: string;
  } = {},
): GoldenArtifactLaunchPlanner {
  return new GoldenArtifactLaunchPlanner({
    cache: new ArtifactCache({ root: cacheRoot }),
    manifestHash: HASH,
    arch: "aarch64",
    jailerBin: "/usr/local/bin/jailer",
    firecrackerBin: "/usr/local/bin/firecracker",
    uid: 10_001,
    gid: 10_002,
    chrootBaseDir: join(workDir, "jail"),
    overlayDir: join(workDir, "ov"),
    dataplane: dataplane(),
    // Ground-truth host fc version (§5.5). A capable host by default; the
    // version-gate tests override it. Snapshot resolution now REQUIRES it.
    firecrackerVersion: "1.16.1",
    ...extra,
  });
}

Deno.test("snapshot strategy + valid template: resolves a restore plan and pins both refcounts", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    const store = await seedTemplate(templateRoot, srcDir);
    const cache = new ArtifactCache({ root: cacheRoot });
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
    });

    const plan = await planner.resolve(request());
    assert(plan.kind === "restore", "a valid template resolves a restore plan");

    // BOTH belts are held before the plan is journaled: the golden set AND the
    // template (§1.2) — a live restore pins its template.
    assertEquals(await cache.refcount(HASH), 1, "golden-set refcount acquired");
    assertEquals(await store.refcount(HASH), 1, "template refcount acquired");

    // SnapshotLoadParams: File mem backend, resume+realtime, eth0 re-point, and
    // the in-jail vsock rebind (§4).
    assertEquals(plan.snapshot.snapshot_path, "/snapshot");
    assertEquals(plan.snapshot.mem_backend, {
      backend_type: "File",
      backend_path: "/mem",
    });
    assertEquals(plan.snapshot.resume_vm, true);
    // `clock_realtime` is x86_64-only — Firecracker's aarch64 VMM REJECTS a
    // snapshot load that sets it ("clock_realtime is not supported on
    // aarch64"), so an aarch64 restore plan omits it (proven on fc-smoke, WI-8).
    assertEquals(plan.snapshot.clock_realtime, undefined);
    assertEquals(plan.snapshot.network_overrides, [
      { iface_id: "eth0", host_dev_name: "sbxtap0" },
    ]);
    assertEquals(plan.snapshot.vsock_override, { uds_path: "v.sock" });

    // Staging: snapshot/mem/rootfs(ro)/overlay-COPY. The overlay is staged from
    // the template's EXACT captured overlay (§3), read-write.
    assertEquals(plan.stage.map((s) => s.jailPath), [
      "/snapshot",
      "/mem",
      "/rootfs.ext4",
      "/overlay.ext4",
    ]);
    assertEquals(
      plan.stage[0].hostPath,
      join(templateRoot, HASH, "snapshot"),
    );
    assertEquals(
      plan.stage[3].hostPath,
      join(templateRoot, HASH, "overlay.ext4"),
    );
    assertEquals(plan.stage[3].readWrite, true);

    // Personalize inputs: the guest network derived from the alloc, the request
    // bootNonce (what the tunnel client presents), the rootd sandbox id.
    assertEquals(plan.personalize.network, {
      guestCidr: "10.201.0.2/30",
      gateway: "10.201.0.1",
      dns: "10.201.0.1",
      iface: "eth0",
    });
    assertEquals(plan.personalize.bootNonce, new Uint8Array(32).fill(0x0b));
    assertEquals(plan.personalize.sandboxId, "sbx-snap");
    assertEquals(plan.agentCredential?.byteLength, 32);
    assertEquals(plan.artifact, { manifestHash: HASH, arch: "aarch64" });
    assertEquals(plan.resources?.tapName, "sbxtap0");

    // The fallback is a COLD recipe (a VmConfig) baking the SAME credential and
    // reusing the same NIC (§5.3) — a template problem never fails a create.
    const bootArgs = plan.fallback.config.boot_source?.boot_args ?? "";
    assert(/studiobox\.token=[0-9a-f]{64}/.test(bootArgs), bootArgs);
    assert(bootArgs.includes("studiobox.ip=10.201.0.2/30"), bootArgs);
    const tpl = /studiobox\.token=([0-9a-f]{64})/.exec(bootArgs)![1];
    let credHex = "";
    for (const b of plan.agentCredential!) {
      credHex += b.toString(16).padStart(2, "0");
    }
    assertEquals(credHex, tpl, "fallback bakes the SAME injected credential");

    // Teardown releases the template pin exactly once from the DURABLE record
    // fields the core journals before spawn (templatePinned + the artifact hash;
    // FINDING 1), NOT the in-process map. A cold record — no templatePinned —
    // would be a no-op.
    const hook = planner.templateReclaimHook!;
    await hook.reclaim(
      {
        machine: { executionId: "e-snap-1" },
        artifact: { manifestHash: HASH, arch: "aarch64" },
        templatePinned: true,
      } as unknown as SandboxRecord,
    );
    assertEquals(
      await store.refcount(HASH),
      0,
      "template released on teardown",
    );
  });
});

Deno.test("snapshot strategy but MISSING template falls safe to cold (no template pin)", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot }) => {
    await seedCache(cacheRoot);
    // A store with NO template published for HASH.
    const store = new TemplateStore({ root: templateRoot });
    const cache = new ArtifactCache({ root: cacheRoot });
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
    });

    const plan = await planner.resolve(request());
    assert(plan.kind !== "restore", "missing template ⇒ cold plan");
    assertEquals(
      await cache.refcount(HASH),
      1,
      "cold still pins the golden set",
    );
    assertEquals(await store.has(HASH), false, "no template pinned");
  });
});

Deno.test("snapshot strategy but STALE-schema template falls safe to cold", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    // A template captured under a DIFFERENT schema is stale (§1.2, §5.5).
    const store = await seedTemplate(templateRoot, srcDir, "a".repeat(64));
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
    });

    const plan = await planner.resolve(request());
    assert(plan.kind !== "restore", "stale template ⇒ cold plan");
    assertEquals(await store.refcount(HASH), 0, "stale template not pinned");
  });
});

Deno.test("snapshot strategy but NETLESS request is always cold (§5.4)", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    const store = await seedTemplate(templateRoot, srcDir);
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
    });

    const plan = await planner.resolve(request({ netless: true }));
    assert(
      plan.kind !== "restore",
      "netless ⇒ cold, even with a valid template",
    );
    assertEquals(
      await store.refcount(HASH),
      0,
      "no template pinned for netless",
    );
  });
});

Deno.test("TOCTOU: template validates then vanishes at resolve — falls safe to cold", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    await seedTemplate(templateRoot, srcDir);
    // isValid passes (in #shouldRestore) but resolve throws — the exact race
    // where a concurrent GC reaps the template between the check and the pin.
    class RacyStore extends TemplateStore {
      override isValid(): Promise<boolean> {
        return Promise.resolve(true);
      }
      override resolve(
        _hash: string,
        _expected: TemplateExpectation,
      ): Promise<ResolvedTemplate> {
        return Promise.reject(
          new TemplateStoreError("template GC'd mid-resolve"),
        );
      }
    }
    const store = new RacyStore({ root: templateRoot });
    const cache = new ArtifactCache({ root: cacheRoot });
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
    });

    const plan = await planner.resolve(request());
    // A template problem NEVER fails a create (§5.3): degrade to cold.
    assert(plan.kind !== "restore", "TOCTOU template loss ⇒ cold plan");
    assertEquals(
      await cache.refcount(HASH),
      1,
      "cold still pins the golden set",
    );
    assertEquals(await store.refcount(HASH), 0, "no template pin survives");
  });
});

Deno.test("default (cold) strategy ignores a valid template", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    const store = await seedTemplate(templateRoot, srcDir);
    // launchStrategy defaults to "cold"; a template store is present but unused.
    const planner = plannerFor(cacheRoot, workDir, {
      templateStore: store,
      schemaSha256: SCHEMA,
    });

    const plan = await planner.resolve(request());
    assert(plan.kind !== "restore", "cold strategy never restores");
    assertEquals(await store.refcount(HASH), 0, "no template pinned");
    // The template reclaim hook is still available (store configured) but a cold
    // record pinned nothing, so reclaim is a clean no-op.
    const hook = planner.templateReclaimHook!;
    await hook.reclaim(
      { machine: { executionId: "e-snap-1" } } as unknown as SandboxRecord,
    );
    assertEquals(await store.refcount(HASH), 0);
  });
});

Deno.test("FINDING 1: template refcount is crash-durable — a FRESH hook releases from the SURVIVING record", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    const store = await seedTemplate(templateRoot, srcDir);
    // A restore pins the template; the real core ALSO journals templatePinned +
    // the artifact hash into the record BEFORE spawn (the durable marker).
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
    });
    const plan = await planner.resolve(request());
    assert(plan.kind === "restore");
    assertEquals(await store.refcount(HASH), 1, "restore pinned the template");

    // The record the core durably journaled before spawn.
    const survivingRecord = {
      machine: { executionId: "e-snap-1" },
      artifact: { manifestHash: HASH, arch: "aarch64" },
      templatePinned: true,
    } as unknown as SandboxRecord;

    // A rootd crash + restart: a FRESH planner over the SAME on-disk store has an
    // EMPTY in-process pin map. Its reclaim hook must STILL release from the
    // durable record field (the source of truth) — not the (gone) map — so the
    // WI-8 §7 "refcounts return to zero after kill-9 + reconcile" contract holds.
    const afterCrash = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: new TemplateStore({ root: templateRoot }),
      schemaSha256: SCHEMA,
    });
    await afterCrash.templateReclaimHook!.reclaim(survivingRecord);
    assertEquals(
      await store.refcount(HASH),
      0,
      "refcount returns to ZERO after crash + destructive reconcile",
    );

    // A cold record (no templatePinned) is a no-op; a double / already-zero
    // reclaim is gone-tolerant — never throws, never drives below zero.
    await afterCrash.templateReclaimHook!.reclaim(survivingRecord);
    await afterCrash.templateReclaimHook!.reclaim(
      {
        machine: { executionId: "e-cold" },
        artifact: { manifestHash: HASH, arch: "aarch64" },
      } as unknown as SandboxRecord,
    );
    assertEquals(await store.refcount(HASH), 0, "gone-tolerant: stays at zero");
  });
});

Deno.test("FINDING 5: a template captured under fc < v1.16 is rejected (cold) even on a v1.16 host", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    // The template's captured firecrackerVersion predates vsock_override.
    const store = await seedTemplate(templateRoot, srcDir, SCHEMA, "1.15.0");
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
      firecrackerVersion: "1.16.1", // a capable host
    });

    const plan = await planner.resolve(request());
    assert(
      plan.kind !== "restore",
      "an fc-incompatible template ⇒ cold, never restore",
    );
    assertEquals(await store.refcount(HASH), 0, "no template pinned");
  });
});

Deno.test("FINDING 5: a v1.16 host + a v1.16 template selects snapshot (restore)", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    const store = await seedTemplate(templateRoot, srcDir, SCHEMA, "1.16.1");
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
      firecrackerVersion: "1.16.1",
    });

    const plan = await planner.resolve(request());
    assert(plan.kind === "restore", "compatible host + template ⇒ restore");
    assertEquals(await store.refcount(HASH), 1, "template pinned");
  });
});

Deno.test("FINDING 3: a v1.15 host resolves to cold and pins no template, even with a valid v1.16 template", async () => {
  await withDirs(async ({ cacheRoot, workDir, templateRoot, srcDir }) => {
    await seedCache(cacheRoot);
    const store = await seedTemplate(templateRoot, srcDir); // a valid 1.16 template
    // The planner is told the host's GROUND-TRUTH fc version is v1.15 — a real
    // v1.15 host has no vsock_override, so it must NEVER select snapshot even
    // when a valid 1.16 template is present (defense-in-depth for the caller's
    // ground-truth probe).
    const planner = plannerFor(cacheRoot, workDir, {
      launchStrategy: "snapshot",
      templateStore: store,
      schemaSha256: SCHEMA,
      firecrackerVersion: "1.15.0",
    });

    const plan = await planner.resolve(request());
    assert(plan.kind !== "restore", "v1.15 host ⇒ cold, never restore");
    assertEquals(await store.refcount(HASH), 0, "no template pinned");
  });
});
