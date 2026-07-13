import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CLI_VERSION, runCli } from "../../../src/cli/run.ts";
import { HostLifecycle } from "../../../src/cli/host_lifecycle.ts";
import type { HostFlags } from "../../../src/cli/args.ts";
import type { HostProbe } from "../../../src/cli/doctor.ts";
import {
  FakeHostRunner,
  FakeLocalFs,
  sequentialTokenFactory,
} from "./cli_test_helpers.ts";

interface Sink {
  readonly out: string[];
  readonly err: string[];
}

function sink(): Sink {
  return { out: [], err: [] };
}

function lifecycleFactory(
  runner: FakeHostRunner,
  fs: FakeLocalFs,
  probe?: HostProbe,
): (flags: HostFlags) => HostLifecycle {
  fs.files.add("/host/.build/studiobox-hostd");
  fs.files.add("/host/.build/studiobox-rootd");
  return (flags) =>
    new HostLifecycle({
      runner,
      fs,
      mode: flags.noLima ? "no-lima" : "lima",
      arch: "aarch64",
      homeDir: "/home/tester",
      hostdBinarySource: "/host/.build/studiobox-hostd",
      rootdBinarySource: "/host/.build/studiobox-rootd",
      compatSource: "/host/compat/wire.json",
      tokenFactory: sequentialTokenFactory(),
      writeTemplate: () => Promise.resolve("/tmp/fake-template.yaml"),
      ...(probe === undefined ? {} : { probeFactory: () => probe }),
    });
}

Deno.test("runCli: --help prints usage and exits 0", async () => {
  const s = sink();
  const code = await runCli(["--help"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
  });
  assertEquals(code, 0);
  assertStringIncludes(s.out.join("\n"), "studiobox host <command>");
});

Deno.test("runCli: --version prints the package version and exits 0", async () => {
  const s = sink();
  const code = await runCli(["--version"], { stdout: (l) => s.out.push(l) });
  assertEquals(code, 0);
  assertEquals(s.out.length, 1);
  // Must be the real package version (from deno.json), never a stale "0.0.0".
  assertEquals(s.out[0], CLI_VERSION);
  assert(
    /^\d+\.\d+\.\d+/.test(CLI_VERSION) && CLI_VERSION !== "0.0.0",
    `CLI_VERSION should be a real semver, got "${CLI_VERSION}"`,
  );
});

Deno.test("runCli: a usage error exits 2 and prints usage to stderr", async () => {
  const s = sink();
  const code = await runCli(["frobnicate"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
  });
  assertEquals(code, 2);
  assertStringIncludes(s.err.join("\n"), "unknown command");
  assertStringIncludes(s.err.join("\n"), "usage:");
});

Deno.test("runCli: host up dispatches through the lifecycle (exit 0)", async () => {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  const s = sink();
  const code = await runCli(["host", "up"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
    lifecycleFactory: lifecycleFactory(runner, fs),
  });
  assertEquals(code, 0);
  assert(runner.instances.has("studiobox-host-aarch64"));
  assertStringIncludes(s.out.join("\n"), "host provision:");
});

Deno.test("runCli: host status --json emits a JSON object", async () => {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  const s = sink();
  const code = await runCli(["host", "status", "--json"], {
    stdout: (l) => s.out.push(l),
    lifecycleFactory: lifecycleFactory(runner, fs),
  });
  assertEquals(code, 0);
  const parsed = JSON.parse(s.out[0]);
  assertEquals(parsed.name, "studiobox-host-aarch64");
  assertEquals(parsed.mode, "lima");
});

Deno.test("runCli: host doctor exits 0 when healthy", async () => {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  const probe: HostProbe = {
    negotiate: () => Promise.resolve(),
    capacity: () =>
      Promise.resolve({
        memoryTotalMiB: 6144,
        memoryCommittedMiB: 0,
        vcpusTotal: 4,
        vcpusCommitted: 0,
        sandboxLimit: 8,
        sandboxCount: 0,
      }),
    createCanary: () => Promise.resolve("sbx_loc_c"),
    killCanary: () => Promise.resolve(),
    listQuarantined: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
  const s = sink();
  const code = await runCli(["host", "doctor"], {
    stdout: (l) => s.out.push(l),
    lifecycleFactory: lifecycleFactory(runner, fs, probe),
  });
  assertEquals(code, 0);
  assertStringIncludes(s.out.join("\n"), "HEALTHY");
});

Deno.test("runCli: host doctor exits 1 when unhealthy", async () => {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  const probe: HostProbe = {
    negotiate: () => Promise.reject(new Error("refused")),
    capacity: () => Promise.reject(new Error("unreachable")),
    createCanary: () => Promise.reject(new Error("unreachable")),
    killCanary: () => Promise.resolve(),
    listQuarantined: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
  const s = sink();
  const code = await runCli(["host", "doctor"], {
    stdout: (l) => s.out.push(l),
    lifecycleFactory: lifecycleFactory(runner, fs, probe),
  });
  assertEquals(code, 1);
  assertStringIncludes(s.out.join("\n"), "UNHEALTHY");
});

/** A factory that maps `--bake` onto the lifecycle (like the real one) with a
 *  fixed source root, so `runCli` exercises the bake dispatch + exit code. */
function bakeLifecycleFactory(
  runner: FakeHostRunner,
  fs: FakeLocalFs,
  // `null` = a from-JSR load (no source root). A plain `undefined` can't be the
  // sentinel here: an explicitly-passed `undefined` triggers the `= "/repo"`
  // default, which would defeat the from-JSR test.
  sourceRoot: string | null = "/repo",
): (flags: HostFlags) => HostLifecycle {
  fs.files.add("/host/.build/studiobox-hostd");
  fs.files.add("/host/.build/studiobox-rootd");
  return (flags) =>
    new HostLifecycle({
      runner,
      fs,
      mode: flags.noLima ? "no-lima" : "lima",
      arch: "aarch64",
      homeDir: "/home/tester",
      hostdBinarySource: "/host/.build/studiobox-hostd",
      rootdBinarySource: "/host/.build/studiobox-rootd",
      compatSource: "/host/compat/wire.json",
      tokenFactory: sequentialTokenFactory(),
      writeTemplate: () => Promise.resolve("/tmp/fake-template.yaml"),
      resolveSourceRoot: () => sourceRoot ?? undefined,
      ...(flags.bake ? { bake: flags.rebuild ? { rebuild: true } : {} } : {}),
    });
}

Deno.test("runCli: host up --bake succeeds and exits 0", async () => {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  const s = sink();
  const code = await runCli(["host", "up", "--bake"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
    lifecycleFactory: bakeLifecycleFactory(runner, fs),
  });
  assertEquals(code, 0);
  assertStringIncludes(s.out.join("\n"), "[ran] bake");
});

Deno.test("runCli: host up --bake exits 1 when the bake fails", async () => {
  const runner = new FakeHostRunner();
  runner.bakeFails = true;
  const fs = new FakeLocalFs();
  const s = sink();
  const code = await runCli(["host", "up", "--bake"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
    lifecycleFactory: bakeLifecycleFactory(runner, fs),
  });
  assertEquals(code, 1);
  assertStringIncludes(s.out.join("\n"), "bake FAILED");
});

Deno.test("runCli: host provision --bake exits 1 when the bake fails", async () => {
  const runner = new FakeHostRunner();
  runner.bakeFails = true;
  const fs = new FakeLocalFs();
  const s = sink();
  const code = await runCli(["host", "provision", "--bake"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
    lifecycleFactory: bakeLifecycleFactory(runner, fs),
  });
  assertEquals(code, 1);
  assertStringIncludes(s.out.join("\n"), "bake FAILED");
});

Deno.test("runCli: host up --bake from JSR (no source) exits 1 with a clear message", async () => {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  const s = sink();
  const code = await runCli(["host", "up", "--bake"], {
    stdout: (l) => s.out.push(l),
    stderr: (l) => s.err.push(l),
    // null → resolveSourceRoot() returns undefined: a jsr:/https: load, no checkout.
    lifecycleFactory: bakeLifecycleFactory(runner, fs, null),
  });
  assertEquals(code, 1);
  assertStringIncludes(s.err.join("\n"), "needs a local checkout");
  assert(
    !runner.commandLines().some((l) => l.includes("start --name=")),
    "no VM is created for a from-JSR --bake",
  );
});
