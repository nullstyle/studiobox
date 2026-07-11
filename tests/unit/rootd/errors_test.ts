import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  FirecrackerAdapterError,
  normalizeFirecrackerError,
} from "../../../src/rootd/firecracker/mod.ts";

Deno.test("dependency errors map to stable bounded details", () => {
  const error = normalizeFirecrackerError({
    code: "FC_CLEANUP",
    failures: [{ step: "remove", path: "/secret/path" }],
    leaked: ["/secret/path"],
    message: "host details /secret/path",
  }, { operation: "dispose test VM" });

  assert(error instanceof FirecrackerAdapterError);
  assertEquals(error.code, "SBX_FC_CLEANUP");
  assertEquals(error.details, {
    dependencyCode: "FC_CLEANUP",
    failureCount: 1,
    leakedPathCount: 1,
  });
  assertNotEquals(error.message.includes("/secret/path"), true);
});

Deno.test("native failures are normalized without copying their message", () => {
  const error = normalizeFirecrackerError(
    new Error("spawn failed at /private/tenant-path"),
    { operation: "launch test VM" },
  );

  assertEquals(error.code, "SBX_FC_HOST");
  assert(!error.message.includes("tenant-path"));
});
