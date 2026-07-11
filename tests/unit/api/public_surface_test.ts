import * as api from "../../../src/mod.ts";
import inventory from "../../../parity/inventory.json" with { type: "json" };
import {
  Client,
  type DenoRunOptions,
  type Memory,
  type SandboxOptions,
  UnsupportedFeatureError,
} from "../../../src/mod.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("upstream inventory is complete, unique, and classified", () => {
  assert(
    inventory.generationStatus === "complete",
    "inventory generation failed",
  );
  assert(inventory.actualSymbolCount === 129, "unexpected 0.13.2 symbol count");
  assert(
    inventory.symbols.length === 129,
    "inventory count does not match entries",
  );

  const names = new Set(inventory.symbols.map((symbol) => symbol.name));
  assert(
    names.size === inventory.symbols.length,
    "inventory contains duplicate symbols",
  );
  for (const symbol of inventory.symbols) {
    assert(
      symbol.tier === "A" || symbol.tier === "B" || symbol.tier === "C",
      `${symbol.name} has no parity tier`,
    );
  }
});

Deno.test("every upstream runtime value has a Studiobox export", () => {
  const valueSymbols = inventory.symbols.filter((symbol) =>
    symbol.kind === "class" || symbol.kind === "enum"
  );
  for (const symbol of valueSymbols) {
    assert(symbol.name in api, `missing runtime export: ${symbol.name}`);
  }
});

Deno.test("Studiobox additions are explicitly inventoried", () => {
  for (const extension of inventory.studioboxExtensions) {
    assert(
      extension.name in api,
      `missing Studiobox extension: ${extension.name}`,
    );
  }
});

Deno.test("Tier C client namespaces fail explicitly", () => {
  const client = new Client();
  let thrown: unknown;
  try {
    void client.apps;
  } catch (error) {
    thrown = error;
  }
  assert(
    thrown instanceof UnsupportedFeatureError,
    "Client.apps must be an explicit stub",
  );
  assert(
    thrown.feature === "Client.apps",
    "stub must identify the unsupported feature",
  );
});

Deno.test("core option examples remain type-checkable", () => {
  const memory = "1280MiB" satisfies Memory;
  const options = {
    timeout: "15m",
    memory,
    labels: { suite: "api" },
    allowNet: ["example.com:443"],
    region: "ord",
  } satisfies SandboxOptions;
  const run = {
    code: "console.log('ready')",
    extension: "ts",
    stdout: "piped",
  } satisfies DenoRunOptions;
  assert(
    options.memory === memory && run.extension === "ts",
    "compile fixture changed",
  );
});
