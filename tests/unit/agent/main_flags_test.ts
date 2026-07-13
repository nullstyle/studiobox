// src/agent/main.ts flag parsing: the cold path (--token-file) is unchanged
// and template mode (--template, snapshot-restore §2.2) makes --token-file
// optional-and-forbidden. Host-safe (no listeners spawned).

import { assertEquals, assertThrows } from "@std/assert";

import { AgentError } from "../../../src/agent/api.ts";
import { parseAgentFlags } from "../../../src/agent/main.ts";

Deno.test("agent flags: cold path requires --token-file (unchanged)", () => {
  const flags = parseAgentFlags([
    "--vsock-port",
    "1024",
    "--token-file",
    "/run/studioboxd.token",
  ]);
  assertEquals(flags.template, false);
  assertEquals(flags.tokenFile, "/run/studioboxd.token");
  assertEquals(flags.vsockPort, 1024);
});

Deno.test("agent flags: cold path without --token-file fails closed", () => {
  const error = assertThrows(
    () => parseAgentFlags(["--vsock-port", "1024"]),
    AgentError,
  );
  assertEquals((error as AgentError).code, "SBX_AGENT_VALIDATION");
});

Deno.test("agent flags: --template boots without --token-file", () => {
  const flags = parseAgentFlags(["--vsock-port", "1024", "--template"]);
  assertEquals(flags.template, true);
  assertEquals(flags.tokenFile, undefined);
});

Deno.test("agent flags: --personalize-pending is an alias for --template", () => {
  const flags = parseAgentFlags([
    "--socket",
    "/tmp/s.sock",
    "--personalize-pending",
  ]);
  assertEquals(flags.template, true);
  assertEquals(flags.tokenFile, undefined);
});

Deno.test("agent flags: --template with --token-file is a contradiction", () => {
  const error = assertThrows(
    () =>
      parseAgentFlags([
        "--vsock-port",
        "1024",
        "--template",
        "--token-file",
        "/run/t",
      ]),
    AgentError,
  );
  assertEquals((error as AgentError).code, "SBX_AGENT_VALIDATION");
});

Deno.test("agent flags: still requires exactly one transport in template mode", () => {
  assertThrows(() => parseAgentFlags(["--template"]), AgentError);
});
