import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatDoctorReport,
  type HostCapacitySnapshot,
  type HostProbe,
  type QuarantinedRecord,
  runDoctor,
} from "../../../src/cli/doctor.ts";

const CAPACITY: HostCapacitySnapshot = {
  memoryTotalMiB: 6144,
  memoryCommittedMiB: 0,
  vcpusTotal: 4,
  vcpusCommitted: 0,
  sandboxLimit: 8,
  sandboxCount: 0,
};

interface FakeBehaviour {
  negotiateError?: string;
  capacityError?: string;
  createError?: string;
  killError?: string;
  listError?: string;
  quarantined?: readonly QuarantinedRecord[];
}

class FakeProbe implements HostProbe {
  closed = false;
  killedId: string | undefined;
  constructor(private readonly behaviour: FakeBehaviour = {}) {}

  negotiate(): Promise<void> {
    if (this.behaviour.negotiateError !== undefined) {
      return Promise.reject(new Error(this.behaviour.negotiateError));
    }
    return Promise.resolve();
  }
  capacity(): Promise<HostCapacitySnapshot> {
    if (this.behaviour.capacityError !== undefined) {
      return Promise.reject(new Error(this.behaviour.capacityError));
    }
    return Promise.resolve(CAPACITY);
  }
  createCanary(): Promise<string> {
    if (this.behaviour.createError !== undefined) {
      return Promise.reject(new Error(this.behaviour.createError));
    }
    return Promise.resolve("sbx_loc_canary0000000000000000");
  }
  killCanary(id: string): Promise<void> {
    this.killedId = id;
    if (this.behaviour.killError !== undefined) {
      return Promise.reject(new Error(this.behaviour.killError));
    }
    return Promise.resolve();
  }
  listQuarantined(): Promise<readonly QuarantinedRecord[]> {
    if (this.behaviour.listError !== undefined) {
      return Promise.reject(new Error(this.behaviour.listError));
    }
    return Promise.resolve(this.behaviour.quarantined ?? []);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

Deno.test("runDoctor: a healthy host passes every check", async () => {
  const probe = new FakeProbe();
  const report = await runDoctor(probe);

  assertEquals(report.healthy, true);
  assertEquals(report.checks.map((c) => c.name), [
    "negotiate",
    "capacity",
    "canary",
    "quarantine",
  ]);
  assert(report.checks.every((c) => c.ok));
  assertEquals(report.capacity, CAPACITY);
  assertEquals(report.quarantined, []);
  assertEquals(probe.killedId, "sbx_loc_canary0000000000000000");
  assert(probe.closed, "the probe is always closed");
});

Deno.test("runDoctor: a wedged daemon fails negotiate and skips the rest", async () => {
  const probe = new FakeProbe({ negotiateError: "connection refused" });
  const report = await runDoctor(probe);

  assertEquals(report.healthy, false);
  const negotiate = report.checks.find((c) => c.name === "negotiate");
  assertEquals(negotiate?.ok, false);
  assertStringIncludes(negotiate?.detail ?? "", "connection refused");
  for (const name of ["capacity", "canary", "quarantine"] as const) {
    const check = report.checks.find((c) => c.name === name);
    assertEquals(check?.ok, false);
    assertStringIncludes(check?.detail ?? "", "no hostd session");
  }
  assert(probe.closed);
});

Deno.test("runDoctor: capacity failure is isolated; later checks still run", async () => {
  const probe = new FakeProbe({ capacityError: "capacity boom" });
  const report = await runDoctor(probe);

  assertEquals(report.healthy, false);
  assertEquals(report.checks.find((c) => c.name === "capacity")?.ok, false);
  // Canary + quarantine still attempted and pass.
  assertEquals(report.checks.find((c) => c.name === "canary")?.ok, true);
  assertEquals(report.checks.find((c) => c.name === "quarantine")?.ok, true);
});

Deno.test("runDoctor: a canary create failure is reported", async () => {
  const probe = new FakeProbe({ createError: "over capacity" });
  const report = await runDoctor(probe);
  const canary = report.checks.find((c) => c.name === "canary");
  assertEquals(canary?.ok, false);
  assertStringIncludes(canary?.detail ?? "", "over capacity");
  assertEquals(report.healthy, false);
});

Deno.test("runDoctor: a canary created but not killed is reported distinctly", async () => {
  const probe = new FakeProbe({ killError: "kill refused" });
  const report = await runDoctor(probe);
  const canary = report.checks.find((c) => c.name === "canary");
  assertEquals(canary?.ok, false);
  assertStringIncludes(canary?.detail ?? "", "created but kill failed");
});

Deno.test("runDoctor: quarantined records are surfaced (listing itself passes)", async () => {
  const quarantined: QuarantinedRecord[] = [
    { id: "sbx_loc_wedged00000000000000", reason: "reclaim failed: EBUSY" },
  ];
  const probe = new FakeProbe({ quarantined });
  const report = await runDoctor(probe);

  // The host is still "healthy" (every check passed); quarantine is surfaced.
  assertEquals(report.healthy, true);
  assertEquals(report.quarantined, quarantined);
  const check = report.checks.find((c) => c.name === "quarantine");
  assertStringIncludes(check?.detail ?? "", "1 quarantined");
});

Deno.test("runDoctor: a failed quarantine listing is a health failure", async () => {
  const probe = new FakeProbe({ listError: "list boom" });
  const report = await runDoctor(probe);
  assertEquals(report.healthy, false);
  assertEquals(report.checks.find((c) => c.name === "quarantine")?.ok, false);
});

Deno.test("formatDoctorReport: renders verdict, checks, and quarantine", () => {
  const healthy = formatDoctorReport({
    healthy: true,
    checks: [{ name: "negotiate", ok: true, detail: "ok" }],
    quarantined: [],
  });
  assertStringIncludes(healthy, "HEALTHY");
  assertStringIncludes(healthy, "[ok] negotiate");

  const unhealthy = formatDoctorReport({
    healthy: false,
    checks: [{ name: "negotiate", ok: false, detail: "refused" }],
    quarantined: [{ id: "sbx_loc_x", reason: "stuck" }],
  });
  assertStringIncludes(unhealthy, "UNHEALTHY");
  assertStringIncludes(unhealthy, "[FAIL] negotiate");
  assertStringIncludes(unhealthy, "sbx_loc_x: stuck");
});
