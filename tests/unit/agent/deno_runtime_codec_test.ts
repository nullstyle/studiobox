import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  decodeReplValue,
  encodeReplValue,
} from "../../../src/agent/deno_runtime_codec.ts";
import { replServerSource } from "../../../src/agent/deno_runtime.ts";

function roundtrip(value: unknown): unknown {
  // The frame channel is JSON lines: the encoded form must survive JSON.
  return decodeReplValue(JSON.parse(JSON.stringify(encodeReplValue(value))));
}

Deno.test("scalars round-trip", () => {
  assertEquals(roundtrip("text"), "text");
  assertEquals(roundtrip(42), 42);
  assertEquals(roundtrip(true), true);
  assertEquals(roundtrip(null), null);
  assertStrictEquals(roundtrip(undefined), undefined);
});

Deno.test("special numbers and bigint round-trip", () => {
  assert(Number.isNaN(roundtrip(NaN)));
  assertEquals(roundtrip(Infinity), Infinity);
  assertEquals(roundtrip(-Infinity), -Infinity);
  assert(Object.is(roundtrip(-0), -0));
  assertEquals(
    roundtrip(123456789012345678901234567890n),
    123456789012345678901234567890n,
  );
});

Deno.test("Map, Set, and Date are preserved", () => {
  const date = new Date("2026-07-11T12:00:00.000Z");
  const decodedDate = roundtrip(date);
  assertInstanceOf(decodedDate, Date);
  assertEquals(decodedDate.getTime(), date.getTime());

  const map = roundtrip(new Map<unknown, unknown>([["a", 1], [2, "b"]]));
  assertInstanceOf(map, Map);
  assertEquals(map.get("a"), 1);
  assertEquals(map.get(2), "b");

  const set = roundtrip(new Set([1, "two", 3]));
  assertInstanceOf(set, Set);
  assertEquals([...set], [1, "two", 3]);
});

Deno.test("nested containers round-trip", () => {
  const value = {
    list: [1, [2, 3], new Set(["x"])],
    lookup: new Map([["when", new Date(0)]]),
  };
  const decoded = roundtrip(value) as Record<string, unknown>;
  assertEquals(decoded.list, [1, [2, 3], new Set(["x"])]);
  const lookup = decoded.lookup as Map<string, Date>;
  assertEquals(lookup.get("when")?.getTime(), 0);
});

Deno.test("class instances become plain objects (prototypes do not cross)", () => {
  class Point {
    constructor(readonly x: number, readonly y: number) {}
    length(): number {
      return Math.hypot(this.x, this.y);
    }
  }
  const decoded = roundtrip(new Point(3, 4));
  assertEquals(decoded, { x: 3, y: 4 });
  assertStrictEquals(Object.getPrototypeOf(decoded), Object.prototype);
});

Deno.test("Uint8Array and Error survive", () => {
  const decoded = roundtrip(new Uint8Array([0, 1, 255]));
  assertInstanceOf(decoded, Uint8Array);
  assertEquals([...decoded], [0, 1, 255]);

  const error = roundtrip(new RangeError("out of range"));
  assertInstanceOf(error, Error);
  assertEquals(error.name, "RangeError");
  assertEquals(error.message, "out of range");
});

Deno.test("functions, symbols, and cycles cannot be serialized", () => {
  assertThrows(() => encodeReplValue(() => 1), TypeError, "function");
  assertThrows(() => encodeReplValue(Symbol("s")), TypeError, "symbol");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(() => encodeReplValue(cyclic), TypeError, "circular");
  assertThrows(
    () => encodeReplValue(new Float64Array(1)),
    TypeError,
    "binary",
  );
});

Deno.test("repeated (acyclic) references are allowed", () => {
  const shared = { tag: "shared" };
  const decoded = roundtrip({ a: shared, b: shared }) as Record<
    string,
    unknown
  >;
  assertEquals(decoded.a, { tag: "shared" });
  assertEquals(decoded.b, { tag: "shared" });
});

Deno.test("malformed payloads throw TypeError", () => {
  assertThrows(() => decodeReplValue({ not: "tagged" }), TypeError);
  assertThrows(() => decodeReplValue(["no-such-tag"]), TypeError);
});

Deno.test("the embedded server source carries the codec by name", () => {
  const source = replServerSource();
  assert(source.includes("function encodeReplValue("));
  assert(source.includes("function decodeReplValue("));
  assert(
    !source.includes("export function"),
    "toString must not reflect export keywords",
  );
  assert(source.includes("await __send({ ready: true });"));
});
