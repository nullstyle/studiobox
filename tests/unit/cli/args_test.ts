import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CliUsageError,
  HOST_SUBCOMMANDS,
  parseCliArgs,
} from "../../../src/cli/args.ts";

Deno.test("parseCliArgs: --help / -h / help resolve to help", () => {
  for (const arg of ["--help", "-h", "help"]) {
    assertEquals(parseCliArgs([arg]), { kind: "help" });
  }
});

Deno.test("parseCliArgs: --version / -v / version resolve to version", () => {
  for (const arg of ["--version", "-v", "version"]) {
    assertEquals(parseCliArgs([arg]), { kind: "version" });
  }
});

Deno.test("parseCliArgs: host --help resolves to host help topic", () => {
  assertEquals(parseCliArgs(["host", "--help"]), {
    kind: "help",
    topic: "host",
  });
});

Deno.test("parseCliArgs: every host subcommand parses with default flags", () => {
  for (const sub of HOST_SUBCOMMANDS) {
    const parsed = parseCliArgs(["host", sub]);
    assert(parsed.kind === "host");
    assertEquals(parsed.sub, sub);
    assertEquals(parsed.flags, {
      recreate: false,
      noLima: false,
      json: false,
      rotateToken: false,
    });
  }
});

Deno.test("parseCliArgs: boolean flags set on any subcommand", () => {
  const parsed = parseCliArgs([
    "host",
    "up",
    "--recreate",
    "--no-lima",
    "--json",
    "--rotate-token",
  ]);
  assert(parsed.kind === "host");
  assertEquals(parsed.flags.recreate, true);
  assertEquals(parsed.flags.noLima, true);
  assertEquals(parsed.flags.json, true);
  assertEquals(parsed.flags.rotateToken, true);
});

Deno.test("parseCliArgs: value flags (space form)", () => {
  const parsed = parseCliArgs([
    "host",
    "provision",
    "--name",
    "my-host",
    "--arch",
    "x86_64",
    "--control-port",
    "41000",
    "--build-dir",
    "out",
    "--hostd-bin",
    "/b/hostd",
    "--rootd-bin",
    "/b/rootd",
    "--manifest-hash",
    "a".repeat(64),
  ]);
  assert(parsed.kind === "host");
  assertEquals(parsed.flags.name, "my-host");
  assertEquals(parsed.flags.arch, "x86_64");
  assertEquals(parsed.flags.controlPort, 41000);
  assertEquals(parsed.flags.buildDir, "out");
  assertEquals(parsed.flags.hostdBin, "/b/hostd");
  assertEquals(parsed.flags.rootdBin, "/b/rootd");
  assertEquals(parsed.flags.manifestHash, "a".repeat(64));
});

Deno.test("parseCliArgs: --manifest-hash rejects a non-sha256 value", () => {
  assertThrows(
    () => parseCliArgs(["host", "up", "--manifest-hash", "not-a-hash"]),
    CliUsageError,
    "64-char lowercase sha256",
  );
});

Deno.test("parseCliArgs: value flags (inline = form)", () => {
  const parsed = parseCliArgs([
    "host",
    "status",
    "--name=inline",
    "--arch=aarch64",
    "--control-port=40000",
  ]);
  assert(parsed.kind === "host");
  assertEquals(parsed.flags.name, "inline");
  assertEquals(parsed.flags.arch, "aarch64");
  assertEquals(parsed.flags.controlPort, 40000);
});

Deno.test("parseCliArgs: empty argv errors", () => {
  assertThrows(() => parseCliArgs([]), CliUsageError, "no command");
});

Deno.test("parseCliArgs: unknown top-level command errors", () => {
  assertThrows(() => parseCliArgs(["nope"]), CliUsageError, "unknown command");
});

Deno.test("parseCliArgs: host without a subcommand errors", () => {
  assertThrows(
    () => parseCliArgs(["host"]),
    CliUsageError,
    "requires a subcommand",
  );
});

Deno.test("parseCliArgs: unknown host subcommand errors", () => {
  assertThrows(
    () => parseCliArgs(["host", "boot"]),
    CliUsageError,
    "unknown host subcommand",
  );
});

Deno.test("parseCliArgs: unknown flag errors", () => {
  assertThrows(
    () => parseCliArgs(["host", "up", "--wat"]),
    CliUsageError,
    "unknown flag",
  );
});

Deno.test("parseCliArgs: a value flag with no value errors", () => {
  assertThrows(
    () => parseCliArgs(["host", "up", "--name"]),
    CliUsageError,
    "needs a value",
  );
});

Deno.test("parseCliArgs: bad arch errors", () => {
  assertThrows(
    () => parseCliArgs(["host", "up", "--arch", "riscv"]),
    CliUsageError,
    "--arch must be one of",
  );
});

Deno.test("parseCliArgs: out-of-range control port errors", () => {
  assertThrows(
    () => parseCliArgs(["host", "up", "--control-port", "70000"]),
    CliUsageError,
    "1..65535",
  );
  assertThrows(
    () => parseCliArgs(["host", "up", "--control-port", "0"]),
    CliUsageError,
    "1..65535",
  );
});
