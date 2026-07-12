import { assertEquals, assertThrows } from "@std/assert";
import {
  newSandboxRecord,
  SANDBOX_RECORD_VERSION,
  validateSandboxRecord,
} from "../../../src/state/model.ts";

const HASH = "ab".repeat(32);

function base() {
  return newSandboxRecord({
    id: "sbx-model",
    createdAt: "2026-07-11T00:00:00.000Z",
  });
}

Deno.test("new records carry the current schema version", () => {
  assertEquals(base().schemaVersion, SANDBOX_RECORD_VERSION);
  assertEquals(SANDBOX_RECORD_VERSION, 2);
});

Deno.test("a version-2 record round-trips its artifact reference", () => {
  const artifact = { manifestHash: HASH, arch: "aarch64" as const };
  const validated = validateSandboxRecord({ ...base(), artifact });
  assertEquals(validated.artifact, artifact);
});

Deno.test("records without an artifact are valid but unreferenced", () => {
  assertEquals(validateSandboxRecord(base()).artifact, undefined);
  // Version-1 records predate the field and stay valid without it.
  const v1 = { ...base(), schemaVersion: 1 as const };
  assertEquals(validateSandboxRecord(v1).artifact, undefined);
});

Deno.test("version-1 records may never carry an artifact", () => {
  const v1 = {
    ...base(),
    schemaVersion: 1 as const,
    artifact: { manifestHash: HASH, arch: "aarch64" as const },
  };
  assertThrows(
    () => validateSandboxRecord(v1),
    TypeError,
    "schema version 2",
  );
});

Deno.test("artifact references are bounded and unknown-key-rejecting", () => {
  const good = { manifestHash: HASH, arch: "aarch64" as const };
  const invalid: unknown[] = [
    { ...good, manifestHash: HASH.toUpperCase() }, // not lowercase hex
    { ...good, manifestHash: HASH.slice(0, 60) }, // not 64 chars
    { ...good, manifestHash: 7 },
    { ...good, arch: "riscv64" },
    { ...good, extra: true }, // unknown key
    "not-an-object",
  ];
  for (const artifact of invalid) {
    assertThrows(
      () => validateSandboxRecord({ ...base(), artifact }),
      TypeError,
    );
  }
});

Deno.test("M10 network resources round-trip on the record", () => {
  const resources = {
    uid: 1000,
    gid: 1000,
    tapName: "sbxtap42",
    hostIp: "10.201.0.169",
    guestIp: "10.201.0.170",
    subnet: "10.201.0.168/30",
    dnsmasqPidfile: "/run/studiobox/dns/42.pid",
    exposedPorts: [{ hostPort: 40100, guestPort: 8080 }],
  };
  const validated = validateSandboxRecord({ ...base(), resources });
  assertEquals(validated.resources, resources);
});

Deno.test("exposed ports are bounded {hostPort, guestPort} pairs", () => {
  const invalid: unknown[] = [
    [40099], // bare number, not a pair
    [{ hostPort: 40099, guestPort: 8080 }], // hostPort below the range
    [{ hostPort: 40200, guestPort: 8080 }], // hostPort above the range
    [{ hostPort: 40100, guestPort: 70000 }], // guestPort out of range
    [{ hostPort: 40100 }], // missing guestPort
    [{ hostPort: 40100, guestPort: 80, extra: 1 }], // unknown key
    [
      { hostPort: 40100, guestPort: 80 },
      { hostPort: 40100, guestPort: 81 }, // duplicate hostPort
    ],
  ];
  for (const exposedPorts of invalid) {
    assertThrows(
      () => validateSandboxRecord({ ...base(), resources: { exposedPorts } }),
      TypeError,
    );
  }
});

Deno.test("unknown resource keys are rejected", () => {
  assertThrows(
    () =>
      validateSandboxRecord({
        ...base(),
        resources: { exposedPorts: [], bogus: true },
      }),
    TypeError,
  );
});
