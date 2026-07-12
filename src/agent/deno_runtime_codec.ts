/**
 * The structured-clone-ish value codec shared by the repl driver
 * (`src/agent/deno_runtime.ts`) and the repl SERVER process it spawns.
 *
 * The wire form is JSON-safe: scalars pass through, and everything else
 * is a tagged array `[tag, ...payload]` — user arrays are themselves
 * tagged (`["arr", ...]`), so no user value can collide with a tag.
 *
 * Fidelity (upstream `@deno/sandbox@0.13.2` eval marshalling):
 * `Map`/`Set`/`Date` are preserved; class instances arrive as plain
 * objects (own enumerable string-keyed props; prototypes do not cross);
 * `undefined`, `bigint`, non-finite numbers, `-0`, `Uint8Array`, and
 * `Error` (name + message) survive; functions and symbols do not — they
 * throw, which the driver surfaces as `AgentError` `SBX_AGENT_EVAL`.
 * True cycles throw (shared acyclic references are duplicated, not
 * preserved — recorded as an M3 parity gap).
 *
 * **Embedding contract:** both functions are fully self-contained
 * (no imports, no captured module state, recursion by their own names)
 * because the repl server source embeds them via `Function.toString()`
 * — Deno's type-stripping leaves valid JS in the reflected source. Do
 * not add imports or module-level references inside these bodies.
 *
 * @module
 */

/**
 * Encode `value` into the JSON-safe tagged form. Throws `TypeError` for
 * values that cannot cross (functions, symbols, non-Uint8Array binary
 * views, circular structures).
 */
export function encodeReplValue(value: unknown, seen?: Set<object>): unknown {
  const path = seen ?? new Set<object>();
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Number.isNaN(value)) return ["num", "NaN"];
      if (value === Infinity) return ["num", "Infinity"];
      if (value === -Infinity) return ["num", "-Infinity"];
      if (Object.is(value, -0)) return ["num", "-0"];
      return value;
    case "undefined":
      return ["undef"];
    case "bigint":
      return ["bigint", value.toString()];
    case "function":
      throw new TypeError("cannot serialize a function");
    case "symbol":
      throw new TypeError("cannot serialize a symbol");
  }
  if (value === null) return null;
  const obj = value as object;
  if (obj instanceof Date) return ["date", obj.getTime()];
  if (obj instanceof Uint8Array) {
    let bin = "";
    for (let i = 0; i < obj.length; i++) bin += String.fromCharCode(obj[i]);
    return ["u8", btoa(bin)];
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    throw new TypeError("cannot serialize binary data other than Uint8Array");
  }
  if (obj instanceof Error) {
    return ["err", String(obj.name), String(obj.message)];
  }
  if (path.has(obj)) {
    throw new TypeError("cannot serialize a circular structure");
  }
  path.add(obj);
  try {
    if (Array.isArray(obj)) {
      return ["arr", obj.map((item) => encodeReplValue(item, path))];
    }
    if (obj instanceof Map) {
      return [
        "map",
        [...obj.entries()].map((
          entry,
        ) => [
          encodeReplValue(entry[0], path),
          encodeReplValue(entry[1], path),
        ]),
      ];
    }
    if (obj instanceof Set) {
      return [
        "set",
        [...obj.values()].map((item) => encodeReplValue(item, path)),
      ];
    }
    const entries: unknown[] = [];
    for (const key of Object.keys(obj)) {
      entries.push([
        key,
        encodeReplValue((obj as Record<string, unknown>)[key], path),
      ]);
    }
    return ["obj", entries];
  } finally {
    path.delete(obj);
  }
}

/**
 * Decode the tagged form produced by {@linkcode encodeReplValue}. Throws
 * `TypeError` on a malformed payload.
 */
export function decodeReplValue(encoded: unknown): unknown {
  if (encoded === null || typeof encoded !== "object") return encoded;
  if (!Array.isArray(encoded)) {
    throw new TypeError("malformed repl payload: expected a tagged array");
  }
  const tag = encoded[0];
  switch (tag) {
    case "undef":
      return undefined;
    case "num": {
      const v = encoded[1];
      if (v === "NaN") return NaN;
      if (v === "Infinity") return Infinity;
      if (v === "-Infinity") return -Infinity;
      return -0;
    }
    case "bigint":
      return BigInt(encoded[1] as string);
    case "date":
      return new Date(encoded[1] as number);
    case "u8": {
      const bin = atob(encoded[1] as string);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    case "err": {
      const error = new Error(encoded[2] as string);
      error.name = encoded[1] as string;
      return error;
    }
    case "arr":
      return (encoded[1] as unknown[]).map((item) => decodeReplValue(item));
    case "map":
      return new Map(
        (encoded[1] as [unknown, unknown][]).map((
          entry,
        ) => [decodeReplValue(entry[0]), decodeReplValue(entry[1])]),
      );
    case "set":
      return new Set(
        (encoded[1] as unknown[]).map((item) => decodeReplValue(item)),
      );
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const entry of encoded[1] as [string, unknown][]) {
        out[entry[0]] = decodeReplValue(entry[1]);
      }
      return out;
    }
    default:
      throw new TypeError(
        "malformed repl payload: unknown tag " + String(tag),
      );
  }
}
