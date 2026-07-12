import { assertEquals, assertStrictEquals } from "@std/assert";
import type {
  AgentProcess,
  AgentProcessStatus,
} from "../../../src/agent/api.ts";
import { collectOutput } from "../../../src/agent/processes.ts";

const OK: AgentProcessStatus = {
  code: 0,
  signal: null,
  signaled: false,
  oom: false,
};

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function streamOf(
  ...chunks: Uint8Array<ArrayBuffer>[]
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return ReadableStream.from(chunks);
}

function fakeProcess(overrides: Partial<AgentProcess>): AgentProcess {
  return {
    pid: 1,
    stdout: null,
    stderr: null,
    status: Promise.resolve(OK),
    kill: () => Promise.resolve(),
    writeStdin: () => Promise.reject(new Error("unused")),
    closeStdin: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("buffers multi-chunk stdout and stderr to single arrays", async () => {
  const output = await collectOutput(fakeProcess({
    stdout: streamOf(bytes("hel"), bytes("lo\n")),
    stderr: streamOf(bytes("warn")),
  }));
  assertEquals(output.stdout, bytes("hello\n"));
  assertEquals(output.stderr, bytes("warn"));
  assertEquals(output.stdoutText, "hello\n");
  assertEquals(output.stderrText, "warn");
  assertEquals(output.status, OK);
});

Deno.test("text getters are lazy and cached", async () => {
  const output = await collectOutput(fakeProcess({
    stdout: streamOf(bytes("cached")),
  }));
  const first = output.stdoutText;
  const second = output.stdoutText;
  assertStrictEquals(first, second);
  assertEquals(first, "cached");
});

Deno.test('"null" stdio yields null buffers and null text', async () => {
  const output = await collectOutput(fakeProcess({}));
  assertEquals(output.stdout, null);
  assertEquals(output.stderr, null);
  assertEquals(output.stdoutText, null);
  assertEquals(output.stderrText, null);
});

Deno.test("a stream read failure yields null, never throws", async () => {
  const failing = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes("partial"));
      controller.error(new Error("pipe broke"));
    },
  });
  const output = await collectOutput(fakeProcess({
    stdout: failing,
    stderr: streamOf(bytes("intact")),
  }));
  assertEquals(output.stdout, null);
  assertEquals(output.stdoutText, null);
  assertEquals(output.stderrText, "intact");
  assertEquals(output.status, OK);
});
