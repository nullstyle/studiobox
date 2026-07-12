/**
 * LeakAudit catch-tests (PLAN.md §M11, deliverable 3b): for EVERY leak class,
 * seed a fake enumerator that models a leak of that class and assert the audit
 * flags exactly it; and a clean run reports zero. This proves the audit +
 * assertion logic without any real VM — the assertions themselves are what is
 * under test here.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  LEAK_CLASSES,
  LeakAudit,
  type LeakClass,
  LeakDetectedError,
  type LeakEnumerator,
} from "../../tools/soak/leak_audit.ts";

/** A fake enumerator that returns a fixed, modelled resource set. */
function fakeEnumerator(
  leakClass: LeakClass,
  resources: readonly string[],
): LeakEnumerator {
  return {
    leakClass,
    enumerate: () => Promise.resolve([...resources]),
  };
}

/** All classes clean except `leaked`, which returns `resources`. */
function auditWithOneLeak(
  leaked: LeakClass,
  resources: readonly string[],
): LeakAudit {
  return new LeakAudit(
    LEAK_CLASSES.map((leakClass) =>
      fakeEnumerator(leakClass, leakClass === leaked ? resources : [])
    ),
  );
}

/** A seeded resource per class, so a report shows a class-appropriate leak. */
const SEED: Record<LeakClass, string[]> = {
  process: ["pid=4242"],
  tap: ["sbx-tap0"],
  netns: ["sbx-ns-9"],
  nftables: ["sbx_eg_deadbeef"],
  mount: ["/srv/jail/j/firecracker/x/root/overlay"],
  overlay: ["ov-e7.ext4"],
  jailRoot: ["firecracker-fake-ready/e7"],
  portReservation: ["sbx-3:port=40123"],
  journalPhase: ["sbx-3:booting"],
  artifactRefcount: ["a".repeat(64) + "@1"],
};

for (const leakClass of LEAK_CLASSES) {
  Deno.test(`LeakAudit catches a seeded ${leakClass} leak, flagging exactly it`, async () => {
    const seeded = SEED[leakClass];
    const audit = auditWithOneLeak(leakClass, seeded);

    const report = await audit.audit();
    assertEquals(report.clean, false, "the seeded class must not be clean");
    assertEquals(report.findings.length, 1, "exactly one class leaked");
    assertEquals(report.findings[0]!.leakClass, leakClass);
    assertEquals(report.findings[0]!.resources, seeded);
    assertEquals(report.checked, LEAK_CLASSES, "all classes were checked");
    assertEquals(report.skipped, [], "nothing skipped");

    const error = await assertRejects(
      () => audit.assertClean({}, `unit ${leakClass}`),
      LeakDetectedError,
    );
    assert(
      error.message.includes(leakClass),
      "the error names the leaked class",
    );
    assert(
      error.message.includes(seeded[0]!),
      "the error names the leaked resource",
    );
    assertEquals(error.report.findings[0]!.leakClass, leakClass);
  });
}

Deno.test("LeakAudit: a fully clean run reports zero findings", async () => {
  const audit = new LeakAudit(
    LEAK_CLASSES.map((leakClass) => fakeEnumerator(leakClass, [])),
  );
  const report = await audit.audit();
  assertEquals(report.clean, true);
  assertEquals(report.findings, []);
  assertEquals(report.checked, LEAK_CLASSES);
  assertEquals(report.skipped, []);
  // assertClean returns the (clean) report rather than throwing.
  const same = await audit.assertClean();
  assertEquals(same.clean, true);
});

Deno.test("LeakAudit: allowance excludes a legitimately-live resource", async () => {
  const audit = auditWithOneLeak("overlay", ["ov-live.ext4", "ov-leak.ext4"]);
  // Allow the live overlay; only the leaked one should be flagged.
  const report = await audit.audit({ overlay: ["ov-live.ext4"] });
  assertEquals(report.clean, false);
  assertEquals(report.findings.length, 1);
  assertEquals(report.findings[0]!.resources, ["ov-leak.ext4"]);

  // Allowing BOTH makes the class clean.
  const clean = await audit.audit({
    overlay: ["ov-live.ext4", "ov-leak.ext4"],
  });
  assertEquals(clean.clean, true);
});

Deno.test("LeakAudit: multiple classes leaking are all reported, in order", async () => {
  const audit = new LeakAudit([
    fakeEnumerator("process", ["pid=9"]),
    fakeEnumerator("overlay", ["ov-a.ext4"]),
    fakeEnumerator("journalPhase", ["sbx-1:ready"]),
  ]);
  const report = await audit.audit();
  assertEquals(report.clean, false);
  assertEquals(
    report.findings.map((f) => f.leakClass),
    ["process", "overlay", "journalPhase"],
    "findings follow taxonomy order",
  );
});

Deno.test("LeakAudit: unwired classes are reported as skipped (bounded coverage)", async () => {
  const audit = new LeakAudit([
    fakeEnumerator("process", []),
    fakeEnumerator("journalPhase", []),
  ]);
  assertEquals(audit.checked, ["process", "journalPhase"]);
  assertEquals(audit.skipped, [
    "tap",
    "netns",
    "nftables",
    "mount",
    "overlay",
    "jailRoot",
    "portReservation",
    "artifactRefcount",
  ]);
  const report = await audit.audit();
  assertEquals(report.clean, true);
  assertEquals(report.skipped.length, 8);
});

Deno.test("LeakAudit: with() replaces an enumerator for its class", async () => {
  const audit = new LeakAudit([fakeEnumerator("process", ["pid=1"])]);
  assertEquals((await audit.audit()).clean, false);
  audit.with(fakeEnumerator("process", []));
  assertEquals((await audit.audit()).clean, true);
});
