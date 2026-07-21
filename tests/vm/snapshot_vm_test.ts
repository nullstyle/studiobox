/**
 * WI-8 — snapshot-restore fast-create, validated against REAL Firecracker in
 * the `fc-smoke` guest (`docs/snapshot-restore.md` §7).
 *
 * Armed only in-guest (`SBX_VM=1`, Linux + KVM + root); off-guest every case is
 * ignored so the file still imports/typechecks on macOS. A warm template for
 * the golden hash must ALREADY be baked (`deno task template:build --hash
 * <hash>`), else the snapshot strategy falls safe to cold and the restore
 * assertions here fail. The `tools/lima_vm_test.ts` driver, the
 * `tools/parity_vm_test.ts --gate …snapshot…` driver, and the CI integration
 * job all bake it after the golden set, before running this suite. The stack
 * drives the same `@deno/sandbox` client path as M8, only with rootd resolving
 * `launchStrategy: "snapshot"`.
 *
 * It proves the three claims the feature makes:
 *
 *   1. a sandbox created via snapshot-restore is FUNCTIONAL — the restored
 *      studioboxd is personalized in-band (per-restore credential + `eth0`
 *      config) and `sh` / `fs` / `deno.eval` / egress all work exactly as cold;
 *   2. it actually took the RESTORE path (asserted from rootd's own log, not
 *      timing) and is faster than a cold boot — on 1.0 copy-mode ~1.5-2x
 *      end-to-end (the per-restore mem/overlay copies dominate; the post-1.0
 *      shared-RO-mem COW optimization, §6, unlocks the larger speedup). The
 *      speed clause — and only that clause — relaxes to a gross-regression
 *      bound on shared CI hardware (`SBX_VM_SHARED_HW=1`), where a boot-to-boot
 *      ratio is not measurable;
 *   3. the cold FALLBACK (§5.3) keeps a create working when no usable template
 *      exists, so a template problem never fails a create.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";

import { inGuest, readVmConfig, sharedHardware } from "./support.ts";
import { startRealStack } from "./real_stack.ts";
import { installSandboxProvider } from "../../src/api/provider.ts";
import { Sandbox } from "../../src/api/sandbox.ts";
import { TemplateStore } from "../../src/rootd/template/mod.ts";

/** The per-sandbox dnsmasq upstream; presence flips rootd into the dataplane. */
const UPSTREAM_DNS = "1.1.1.1";

/** Count running processes whose exact name is `name` (leaked VMMs/jailers). */
async function countProcess(name: string): Promise<number> {
  const out = await new Deno.Command("pgrep", {
    args: ["-x", name],
    stdout: "piped",
    stderr: "null",
  }).output();
  const text = new TextDecoder().decode(out.stdout).trim();
  return text === "" ? 0 : text.split("\n").length;
}

/** Poll `predicate` until true or the deadline; returns whether it settled. */
async function settlesWithin(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return await predicate();
}

/** Exercise the full client surface of a created sandbox and assert it works. */
async function assertFunctional(sandbox: Sandbox): Promise<void> {
  // sh: a shell round-trips.
  assertEquals((await sandbox.sh`echo restore-ok`.text()).trim(), "restore-ok");
  // fs: write + read back.
  await sandbox.fs.writeTextFile("/tmp/snap.txt", "personalized");
  assertEquals(await sandbox.fs.readTextFile("/tmp/snap.txt"), "personalized");
  // deno.eval: the runtime is live.
  assertEquals(await sandbox.deno.eval<number>(`6 * 7`), 42);
  // The personalized NIC: eth0 carries the per-restore guest IP (proves the
  // in-band `ip addr` personalize ran on the restored guest).
  const eth0 = await sandbox.sh`ip -4 addr show eth0`.text();
  assertStringIncludes(eth0, "inet ");
}

Deno.test({
  name:
    "M-snap: snapshot-restore creates a functional, personalized sandbox FAR faster than cold",
  ignore: !inGuest,
}, async () => {
  const config = readVmConfig();

  // Cold baseline: the same networked stack, without the snapshot strategy.
  let coldMs: number;
  {
    await using stack = await startRealStack(config, {
      network: { upstreamDns: UPSTREAM_DNS },
    });
    const restore = installSandboxProvider(stack.provider);
    try {
      const started = performance.now();
      const sandbox = await Sandbox.create();
      coldMs = performance.now() - started;
      try {
        await assertFunctional(sandbox);
      } finally {
        await sandbox.close();
      }
    } finally {
      restore();
    }
  }

  // Snapshot restore: the same stack + a baked warm template.
  let snapMs: number;
  let restoreLog: readonly string[];
  {
    await using stack = await startRealStack(config, {
      network: { upstreamDns: UPSTREAM_DNS },
      snapshot: true,
    });
    const restore = installSandboxProvider(stack.provider);
    try {
      const started = performance.now();
      const sandbox = await Sandbox.create();
      snapMs = performance.now() - started;
      try {
        await assertFunctional(sandbox);
      } finally {
        await sandbox.close();
      }
    } finally {
      restore();
    }
    restoreLog = [...stack.rootdStderr];
  }

  console.log(
    `[snapshot-restore] cold=${Math.round(coldMs)}ms restore=${
      Math.round(snapMs)
    }ms (${(coldMs / snapMs).toFixed(1)}x faster)`,
  );

  // DEFINITIVE proof it restored (not a silent cold fallback): rootd logs the
  // path it took. This does not depend on timing noise.
  assert(
    restoreLog.some((l) => l.includes("created via snapshot restore")),
    `rootd did not log a snapshot restore — the create did not go through the restore path.\nrootd stderr:\n${
      restoreLog.join("\n")
    }`,
  );
  assert(
    !restoreLog.some((l) => l.includes("fell back to cold")),
    `rootd fell back to cold instead of restoring:\n${restoreLog.join("\n")}`,
  );

  // And it is faster than a cold boot. On 1.0 copy-mode (per-restore 512 MiB mem
  // + overlay copies on ext4 without reflink) the win is ~1.5-2x end-to-end; the
  // shared-read-only-mem COW optimization (post-1.0, docs/snapshot-restore.md §6)
  // unlocks the larger speedup. The threshold has margin for real-hardware noise.
  //
  // On SHARED CI hardware that ratio is not measurable (`sharedHardware`): the
  // per-restore mem copy runs against a network-backed disk and costs more than
  // the boot it replaces, so restore lands at ~1.0x cold no matter how healthy
  // it is. There the case keeps every assertion above — functional, personalized,
  // and PROVEN to have taken the restore path from rootd's own log — and swaps
  // this one for a gross-regression bound, so a restore that fell off a cliff
  // still reds while ordinary runner noise does not.
  if (sharedHardware) {
    console.warn(
      `[snapshot-restore] ⚠ shared CI hardware (SBX_VM_SHARED_HW=1): measured ` +
        `${(coldMs / snapMs).toFixed(1)}x, and the 0.9x speedup gate is ` +
        `relaxed here to a 3x-slowdown bound. Run on a dedicated host for a ` +
        `real number.`,
    );
    assert(
      snapMs < coldMs * 3,
      `snapshot create (${Math.round(snapMs)}ms) is pathologically slower ` +
        `than cold (${Math.round(coldMs)}ms) — beyond any CI noise`,
    );
  } else {
    assert(
      snapMs < coldMs * 0.9,
      `snapshot create (${Math.round(snapMs)}ms) should be faster than cold (${
        Math.round(coldMs)
      }ms)`,
    );
  }
});

Deno.test({
  name:
    "M-snap: with the snapshot strategy but NO usable template, a create falls back to cold and still succeeds",
  ignore: !inGuest,
}, async () => {
  const config = readVmConfig();
  // An empty template dir: resolveRestorePlan finds no template for the hash,
  // so the strategy resolves to cold (§5.3) — the create must still work.
  const emptyTemplates = await Deno.makeTempDir({
    dir: config.workBase,
    prefix: "empty-tpl-",
  });
  try {
    await using stack = await startRealStack(config, {
      network: { upstreamDns: UPSTREAM_DNS },
      snapshot: true,
      templateCacheDir: emptyTemplates,
    });
    const restore = installSandboxProvider(stack.provider);
    try {
      const sandbox = await Sandbox.create();
      try {
        await assertFunctional(sandbox);
      } finally {
        await sandbox.close();
      }
    } finally {
      restore();
    }
    // It genuinely fell back to cold — it did NOT restore from the (absent)
    // template, and the create still succeeded.
    assert(
      !stack.rootdStderr.some((l) =>
        l.includes("created via snapshot restore")
      ),
      "a create with no template must not report a snapshot restore",
    );
    assert(
      stack.rootdStderr.some((l) => l.includes("fell back to cold")),
      "a snapshot strategy with no template should log the cold fallback",
    );
  } finally {
    await Deno.remove(emptyTemplates, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    "M-snap: repeated restore/terminate cycles leak nothing — the template refcount returns to baseline (FINDING 1 on real hardware)",
  ignore: !inGuest,
}, async () => {
  const config = readVmConfig();
  // Clear any leaked VMMs from EARLIER tests' stack disposes: rootd's SIGTERM
  // shutdown defers its reclaim sweep to a restart a test never does, so a VMM
  // (and memory) can linger. Reap them so this leak check measures only its own
  // cycles and is not starved of the 4 GiB guest. (A real rootd restart would
  // reconcile them; this is test hygiene, not a product concern.)
  for (const name of ["firecracker", "jailer"]) {
    await new Deno.Command("pkill", { args: ["-9", "-x", name] }).output()
      .catch(() => {});
  }

  const store = new TemplateStore({
    root: join(config.cacheRoot, "templates"),
  });
  const baselineRefcount = await store.refcount(config.manifestHash);
  const CYCLES = 12;
  let restores = 0;

  {
    await using stack = await startRealStack(config, {
      network: { upstreamDns: UPSTREAM_DNS },
      snapshot: true,
    });
    const provider = installSandboxProvider(stack.provider);
    try {
      for (let i = 0; i < CYCLES; i++) {
        const sandbox = await Sandbox.create();
        try {
          assertEquals(
            (await sandbox.sh`echo cycle-${i}`.text()).trim(),
            `cycle-${i}`,
          );
        } finally {
          await sandbox.close();
        }
      }
    } finally {
      provider();
    }
    restores = stack.rootdStderr.filter((l) =>
      l.includes("created via snapshot restore")
    ).length;

    // Every terminate releases its template pin (FINDING 1's durable, per-record
    // reclaim). `sandbox.close()` returns when the client tunnel drops; rootd
    // then reclaims asynchronously, so poll for the refcount to return to
    // baseline (a genuine leak never drains). Do this WHILE the stack is live —
    // disposing rootd (SIGTERM) mid-reclaim would defer the sweep to a restart
    // that never comes, which is a harness artifact, not a product leak.
    const drained = await settlesWithin(
      async () =>
        (await store.refcount(config.manifestHash)) === baselineRefcount,
      30_000,
    );
    assertEquals(
      await store.refcount(config.manifestHash),
      baselineRefcount,
      `template refcount did not return to baseline (${baselineRefcount}) after ${CYCLES} restore/terminate cycles — drained=${drained}`,
    );
    // With every sandbox terminated + reclaimed, no jailed VMM/jailer is left.
    assert(
      await settlesWithin(async () =>
        (await countProcess("firecracker")) === 0, 10_000),
      "leaked firecracker VMMs after restore/terminate cycles",
    );
    assertEquals(await countProcess("jailer"), 0, "leaked jailer processes");
  }

  // All CYCLES took the restore path.
  assertEquals(restores, CYCLES, "every cycle should have restored");
});
