import { SandboxCommandBuilder } from "../../../src/api/command.ts";
import { InvalidMemoryError } from "../../../src/api/errors.ts";
import { parseMemory } from "../../../src/api/memory.ts";
import { KillController } from "../../../src/api/process.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("memory parser enforces the upstream grammar and range", () => {
  assert(parseMemory("1GiB") === 1024, "1GiB should be 1024 MiB");
  assert(parseMemory("1280MiB") === 1280, "MiB parsing changed");

  for (const value of ["512MiB", "5GiB"] as const) {
    let thrown: unknown;
    try {
      parseMemory(value);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof InvalidMemoryError, `${value} should be rejected`);
  }
});

Deno.test("kill signals preserve process signals and abort exit codes", () => {
  const controller = new KillController();
  const received: string[] = [];
  controller.signal.addListener((signal) => received.push(signal));
  controller.kill("SIGUSR1");
  assert(
    !controller.signal.aborted,
    "SIGUSR1 should not mark the signal aborted",
  );
  controller.kill("SIGKILL");
  assert(controller.signal.aborted, "SIGKILL should mark the signal aborted");
  assert(
    controller.signal.abortedExitCode === 137,
    "SIGKILL exit code changed",
  );
  assert(received.join(",") === "SIGUSR1,SIGKILL", "listeners missed a signal");
});

Deno.test("command builder is immutable, escaped, and honors noThrow", async () => {
  let command = "";
  const host = {
    spawn(_binary: string, options: { args?: string[] }) {
      command = options.args?.[1] ?? "";
      return Promise.resolve({
        kill: () => Promise.resolve(),
        output: () =>
          Promise.resolve({
            status: { success: false, code: 7, oom: false },
            stdoutText: "",
            stderrText: "expected",
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          }),
      });
    },
  };

  const sh = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new SandboxCommandBuilder(host, strings, values);
  const base = sh`printf %s ${"it's safe"}`;
  const result = await base.noThrow().result();
  assert(result.status.code === 7, "noThrow lost the exit status");
  assert(
    command === "printf %s 'it'\\''s safe'",
    "substitution was not shell escaped",
  );

  let thrown = false;
  try {
    await base.result();
  } catch {
    thrown = true;
  }
  assert(thrown, "deriving noThrow should not mutate the original builder");
});
