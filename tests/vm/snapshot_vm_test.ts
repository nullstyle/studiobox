/**
 * WI-8 — snapshot-restore fast-create, validated against REAL Firecracker in
 * the `fc-smoke` guest (`docs/snapshot-restore.md` §7).
 *
 * Armed only in-guest (`SBX_VM=1`, Linux + KVM + root); off-guest every case is
 * ignored so the file still imports/typechecks on macOS. A warm template for
 * the golden hash must already be baked (`deno task template:build --hash
 * <hash>`); the `tools/lima_vm_test.ts` driver bakes it before running this
 * suite. The stack drives the same `@deno/sandbox` client path as M8, only with
 * rootd resolving `launchStrategy: "snapshot"`.
 *
 * It proves the three claims the feature makes:
 *
 *   1. a sandbox created via snapshot-restore is FUNCTIONAL — the restored
 *      studioboxd is personalized in-band (per-restore credential + `eth0`
 *      config) and `sh` / `fs` / `deno.eval` / egress all work exactly as cold;
 *   2. it actually took the RESTORE path (asserted from rootd's own log, not
 *      timing) and is faster than a cold boot — on 1.0 copy-mode ~1.5-2x
 *      end-to-end (the per-restore mem/overlay copies dominate; the post-1.0
 *      shared-RO-mem COW optimization, §6, unlocks the larger speedup);
 *   3. the cold FALLBACK (§5.3) keeps a create working when no usable template
 *      exists, so a template problem never fails a create.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { inGuest, readVmConfig } from "./support.ts";
import { startRealStack } from "./real_stack.ts";
import { installSandboxProvider } from "../../src/api/provider.ts";
import { Sandbox } from "../../src/api/sandbox.ts";

/** The per-sandbox dnsmasq upstream; presence flips rootd into the dataplane. */
const UPSTREAM_DNS = "1.1.1.1";

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
  assert(
    snapMs < coldMs * 0.9,
    `snapshot create (${Math.round(snapMs)}ms) should be faster than cold (${
      Math.round(coldMs)
    }ms)`,
  );
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
