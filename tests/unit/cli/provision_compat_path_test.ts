import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  defaultCompatPath,
  materializeCompatPin,
} from "../../../src/cli/provision.ts";

/**
 * The canonical five-schema bundle hash carried in `compat/wire.json`. The
 * `wire:check` gate pins this exact value; the CLI must surface it whether the
 * package runs from a local checkout (a `file:` module URL) or straight from
 * JSR (an `https:` module URL, where the old `fromFileUrl(import.meta.resolve)`
 * threw in the `HostLifecycle` constructor — the shipped P0).
 */
const EXPECTED_SCHEMA_SHA256 =
  "e57b47d01998020890563649768ee387ae11ec6c076b9001848b4cfbb9b33144";

Deno.test("defaultCompatPath: returns a readable pin carrying the expected schemaSha256", async () => {
  const path = defaultCompatPath();
  const parsed = JSON.parse(await Deno.readTextFile(path)) as {
    schemaSha256: string;
    protocol: { major: number; minor: number };
    codegen: { version: string };
  };
  assertEquals(parsed.schemaSha256, EXPECTED_SCHEMA_SHA256);
  // The identity-bearing fields the daemons/host consume must all survive.
  assert(typeof parsed.protocol.major === "number");
  assert(typeof parsed.protocol.minor === "number");
  assert(parsed.codegen.version.length > 0);
});

Deno.test("materializeCompatPin: writes a valid, re-parseable pin to a fresh temp file", async () => {
  const path = materializeCompatPin();
  // Materialized under a studiobox-prefixed temp dir (the remote-load fallback).
  assertMatch(path, /studiobox-compat-[^/]*[/\\]wire\.json$/u);

  const parsed = JSON.parse(await Deno.readTextFile(path)) as {
    schemaSha256: string;
    protocol: { major: number; minor: number };
    codegen: { version: string };
  };
  assertEquals(parsed.schemaSha256, EXPECTED_SCHEMA_SHA256);
  assert(typeof parsed.protocol.major === "number");
  assert(parsed.codegen.version.length > 0);

  // Each call materializes an independent copy (no shared mutable temp path).
  const second = materializeCompatPin();
  assert(second !== path, "each materialize gets its own temp file");
});
