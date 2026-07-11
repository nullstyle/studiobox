import { assertEquals } from "@std/assert";
import { FIRECRACKER_COMPAT, Machine, reconcile } from "@nullstyle/firecracker";
import {
  FakeFirecracker,
  makeFakeJailerBin,
  makeFakeVmmBin,
} from "@nullstyle/firecracker/testing";
import manifest from "../../../compat/dependencies.json" with { type: "json" };

Deno.test("exact Firecracker dependency exposes the qualified contract", () => {
  assertEquals(FIRECRACKER_COMPAT, {
    pinned: manifest.firecracker.firecrackerPinned,
    min: manifest.firecracker.firecrackerMinimum,
  });
  assertEquals(typeof Machine.launch, "function");
  assertEquals(typeof reconcile, "function");
  assertEquals(typeof FakeFirecracker.start, "function");
  assertEquals(typeof makeFakeVmmBin, "function");
  assertEquals(typeof makeFakeJailerBin, "function");
});
