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
