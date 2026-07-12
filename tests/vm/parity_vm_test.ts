/**
 * The M8 Parity-real GATE (PLAN.md §M8, "Public SDK, Tier A complete").
 *
 * Reruns the M3 upstream-parity fixture suite (`tests/parity/suite.ts`) —
 * the SAME assertions that ran against `FakeSandboxHost` in M3 — against the
 * REAL two-daemon stack booted by {@link real_stack.ts}: studiobox-rootd +
 * studiobox-hostd as separate processes, a real jailed Firecracker microVM,
 * the real studioboxd over real vsock, reached by a {@link StudioboxProvider}
 * over loopback. Every Tier-A fixture (sh text/json/noThrow/escaping, spawn
 * stdio+output+128+n, fs core+FsFile+streaming+walk, env, deno.eval/repl/run,
 * dispose/close/kill, connect) must pass against real sandboxes.
 *
 * The tier is armed only inside the `fc-smoke` guest (`SBX_VM=1`, Linux + KVM
 * + root); off-guest every fixture registers ignored so the file still
 * imports and typechecks on macOS. The driver is `deno task test:vm:parity`
 * (`tools/parity_vm_test.ts`).
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

import { installSandboxProvider } from "../../src/api/provider.ts";
import { runParitySuite } from "../parity/suite.ts";
import { inGuest } from "./support.ts";
import { type RealStack, startRealStack } from "./real_stack.ts";

// Boot the real stack ONCE for the whole file (each fixture creates + closes
// its own sandbox, i.e. its own jailed microVM). Off-guest we stand nothing up
// and every fixture is ignored. The daemons are long-lived out-of-band
// subprocesses, so the suite runs with the per-test sanitizers off (see
// `ParityBackend.ignoreSanitizers`); the daemons + their loopback listeners are
// torn down by the final teardown step below.
let stack: RealStack | undefined;
if (inGuest) {
  stack = await startRealStack();
  installSandboxProvider(stack.provider);
}

/**
 * Tier-A fixtures the real backend cannot satisfy WITHOUT a
 * `sandbox_agent.capnp` extension — the M8 wire plane is a deliberate SUBSET
 * ("no schema change ⇒ no M1 codegen drift"), so these surface as documented,
 * visible skips rather than silent gaps (see PARITY.md). Each needs a distinct
 * wire method / field the current `SpawnSpec` / `FileSystem` / `DenoRuntime` /
 * `DenoRepl` core cannot express; closing them is a follow-on, M1-codegen-gated
 * milestone. Everything else in the suite passes against real sandboxes.
 */
const REAL_BACKEND_NOT_YET = new Map<string, string>([
  [
    "spawn env layers over sandbox env; clearEnv drops it",
    "clearEnv needs a SpawnSpec.clearEnv wire field (the wire carries only an additive env)",
  ],
  [
    "fs: stat/lstat/symlink/readLink/realPath",
    "lstat/symlink/readLink/realPath need FileSystem wire methods (the core has only stat, which follows links)",
  ],
  [
    "deno.eval: errors thrown by evaluated code re-throw with their message",
    "the agent eval returns a wire SbxError instead of a captured value/error frame carrying the guest error name",
  ],
  [
    "deno.repl: state persists; call() takes names and inline fns",
    "the wire DenoRepl exposes only eval; the codec-preserving native call op (non-JSON args like Map) is unreachable",
  ],
  [
    "deno.run: inline code with scriptArgs surfaced as Deno.args",
    "run of inline code needs a wire mechanism carrying the source (the SpawnSpec carries only an entrypoint command)",
  ],
  [
    "kill() is authoritative teardown with live children",
    "on kill the tunnel drops and an in-flight child wait() rejects (connection closed) rather than resolving to a terminal status",
  ],
]);

runParitySuite({
  label: "real",
  ignore: !inGuest,
  ignoreSanitizers: true,
  supportsConnect: true,
  notYet: REAL_BACKEND_NOT_YET,
  create: (options) => {
    if (stack === undefined) throw new Error("real stack not started");
    return stack.provider.create(options);
  },
});

// The drop-in demo: `examples/dropin.ts` is byte-identical to a `@deno/sandbox`
// quickstart except its import line. With the real provider installed above, it
// drives a real microVM end to end. We capture its stdout and pin the output,
// so a regression in the drop-in path fails the gate. (It shares the running
// stack rather than standing up a second daemon pair — Deno imports every test
// file before running any test, so a second top-level `startRealStack()` would
// collide on the loopback ports.)
Deno.test({
  name: "parity[real]: examples/dropin.ts runs green against the real stack",
  ignore: !inGuest,
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    // Side-effecting top-level module: importing it RUNS the demo once against
    // the installed provider. A cache-busting query keeps it re-runnable.
    await import(`../../examples/dropin.ts?real=${crypto.randomUUID()}`);
  } finally {
    console.log = originalLog;
  }
  const output = lines.join("\n");
  console.log(`[dropin demo output]\n${output}`);
  assertStringIncludes(output, "hello from the sandbox");
  assertStringIncludes(output, "written by the demo");
  assertEquals(
    lines.some((line) => line.includes("6 * 7 = 42")),
    true,
    `dropin deno.eval line missing; got:\n${output}`,
  );
});

// Registered LAST: Deno runs a file's tests in registration order, so this
// tears the stack down only after every fixture above has run.
Deno.test({
  name: "parity[real]: teardown — daemons + tunnel router freed",
  ignore: !inGuest,
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  if (stack !== undefined) {
    await stack[Symbol.asyncDispose]();
    stack = undefined;
  }
});
