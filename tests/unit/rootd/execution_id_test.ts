import { assertMatch, assertThrows } from "@std/assert";
import {
  assertExecutionId,
  createExecutionId,
  FirecrackerAdapterError,
} from "../../../src/rootd/firecracker/mod.ts";

Deno.test("generated execution ids are fresh jailer-safe values", () => {
  const first = createExecutionId();
  const second = createExecutionId();
  assertMatch(first, /^sbx-[a-f0-9]{32}$/);
  assertMatch(second, /^sbx-[a-f0-9]{32}$/);
  if (first === second) throw new Error("execution ids must be fresh");
});

Deno.test("invalid execution ids fail before package launch", () => {
  assertThrows(
    () => assertExecutionId("../not-a-jailer-id"),
    FirecrackerAdapterError,
  );
});
