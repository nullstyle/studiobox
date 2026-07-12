/**
 * The upstream-parity fixture suite (v1, started in M3).
 *
 * Every assertion here states a `@deno/sandbox@0.13.2` OBSERVABLE
 * semantic, phrased only against the public `Sandbox` surface — the
 * suite is parameterized by a {@linkcode ParityBackend} factory so the
 * SAME file runs against `FakeSandboxHost` (M3, in-process), the in-VM
 * real agent (M5), and the full macOS-tunnel SDK (M8). Nothing in this
 * module may reach into `src/agent/` or any backend internals.
 *
 * Surface deliberately absent from v1 (arrives with its milestone):
 * `Sandbox.fetch`, `fs.upload`/`download`, `DenoProcess.httpReady`/
 * `fetch`, `extendTimeout`, `exposeHttp`, timeout/memory grammars.
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

import { SandboxCommandError, SandboxSdkError } from "../../src/api/errors.ts";
import { KillController } from "../../src/api/process.ts";
import type { Sandbox, SandboxOptions } from "../../src/api/sandbox.ts";
import { Sandbox as SandboxStatic } from "../../src/api/sandbox.ts";

/** A sandbox backend under parity test. */
export interface ParityBackend {
  /** Suite label, prefixed onto every test name. */
  readonly label: string;
  /** Create a fresh sandbox (the caller closes it). */
  create(options?: SandboxOptions): Promise<Sandbox>;
  /**
   * Whether `Sandbox.connect(id)` works against this backend (requires
   * an installed provider reaching the same host).
   */
  readonly supportsConnect?: boolean;
}

/** Register the parity fixtures as `Deno.test`s against `backend`. */
export function runParitySuite(backend: ParityBackend): void {
  const test = (name: string, fn: (sandbox: Sandbox) => Promise<void>) => {
    Deno.test(`parity[${backend.label}]: ${name}`, async () => {
      await using sandbox = await backend.create();
      await fn(sandbox);
    });
  };

  // -------------------------------------------------------------------
  // identity
  // -------------------------------------------------------------------

  test("sandbox id matches the upstream grammar (loc region slot)", (sandbox) => {
    assertMatch(sandbox.id, /^sbx_loc_[0-9a-hjkmnp-z]{20}$/);
    return Promise.resolve();
  });

  // -------------------------------------------------------------------
  // sh builder
  // -------------------------------------------------------------------

  test("sh.text() pipes stdout and returns it", async (sandbox) => {
    assertEquals(await sandbox.sh`echo hello`.text(), "hello\n");
  });

  test("sh.json() parses piped stdout", async (sandbox) => {
    assertEquals(
      await sandbox.sh`echo '{"a": 1, "b": [true]}'`.json(),
      { a: 1, b: [true] },
    );
  });

  test("sh is thenable and resolves a success result", async (sandbox) => {
    const result = await sandbox.sh`exit 0`;
    assertEquals(result.status.success, true);
    assertEquals(result.status.code, 0);
    assertEquals(result.status.oom, false);
  });

  test("sh nonzero exit throws SandboxCommandError without command text", async (sandbox) => {
    const error = await assertRejects(
      () => sandbox.sh`printf oops >&2; exit 3`.stderr("piped").result(),
      SandboxCommandError,
    );
    assertEquals(error.code, 3);
    // Upstream quirk: extends Error, NOT the SDK error base.
    assertFalse(error instanceof SandboxSdkError);
    // Error messages never echo the command text back.
    assertFalse(error.message.includes("printf"));
    assertStringIncludes(error.message, "Command failed with exit code 3");
    assertStringIncludes(error.message, "oops");
  });

  test("sh.noThrow() reports nonzero exit as data", async (sandbox) => {
    const result = await sandbox.sh`exit 7`.noThrow();
    assertEquals(result.status.success, false);
    assertEquals(result.status.code, 7);
  });

  test("sh escaping: substitutions are single-quoted, never expanded", async (sandbox) => {
    const tricky = `a b'c "$HOME" \`id\` $(id); rm -rf /`;
    assertEquals(
      await sandbox.sh`printf '%s' ${tricky}`.text(),
      tricky,
    );
  });

  test("sh escaping: arrays expand to multiple arguments", async (sandbox) => {
    const args = ["one", "two words", "three"];
    assertEquals(
      await sandbox.sh`printf '[%s]' ${args}`.text(),
      "[one][two words][three]",
    );
  });

  test("sh escaping: object substitutions throw TypeError", async (sandbox) => {
    // The template assembles lazily (at spawn time), so the TypeError
    // surfaces through the async result path — before anything runs.
    await assertRejects(
      () => sandbox.sh`echo ${{ evil: true }}`.text(),
      TypeError,
      "Cannot use objects as shell arguments",
    );
  });

  test("sh env()/cwd() chain onto the spawn", async (sandbox) => {
    await sandbox.fs.mkdir("/home/app/inner");
    const out = await sandbox
      .sh`printf '%s %s' "$PARITY_VAR" "$(basename "$PWD")"`
      .env("PARITY_VAR", "chained")
      .cwd("/home/app/inner")
      .text();
    assertEquals(out, "chained inner");
  });

  test("sh runs bash with BASH_ENV=$HOME/.bashrc sourced at startup", async (sandbox) => {
    await sandbox.fs.writeTextFile(
      "/home/app/.bashrc",
      "export FROM_BASHRC=sourced\n",
    );
    assertEquals(
      await sandbox.sh`printf '%s' "$FROM_BASHRC"`.text(),
      "sourced",
    );
    // BASH_ENV sits UNDER user env in the builder's map: a user entry
    // for BASH_ENV itself replaces the default sourcing hook.
    assertEquals(
      await sandbox.sh`printf '%s' "\${FROM_BASHRC:-unsourced}"`
        .env("BASH_ENV", "/dev/null")
        .text(),
      "unsourced",
    );
  });

  test("sh signal(KillController): SIGTERM abort exits 128+15", async (sandbox) => {
    const controller = new KillController();
    const child = await sandbox.sh`sleep 5`
      .noThrow()
      .signal(controller.signal)
      .spawn();
    controller.kill("SIGTERM");
    const result = await child.output();
    assertEquals(result.status.code, 143);
    assertEquals(result.status.success, false);
  });

  test("sh signal(KillController): pre-aborted signal short-circuits with 128+n", async (sandbox) => {
    const controller = new KillController();
    controller.kill("SIGINT");
    assertEquals(controller.signal.abortedExitCode, 130);
    const result = await sandbox.sh`echo never-runs`
      .noThrow()
      .signal(controller.signal);
    assertEquals(result.status.code, 130);
    assertEquals(result.status.success, false);
  });

  // -------------------------------------------------------------------
  // spawn / ChildProcess
  // -------------------------------------------------------------------

  test("spawn defaults: stdin null, stdout/stderr inherit (client-side)", async (sandbox) => {
    const child = await sandbox.spawn("true");
    assertEquals(child.stdin, null);
    // "inherit" streams flow to the host's stdout/stderr — the handle
    // exposes no readable side and output() cannot buffer them.
    assertEquals(child.stdout, null);
    assertEquals(child.stderr, null);
    const output = await child.output();
    assertEquals(output.stdout, null);
    assertEquals(output.stderr, null);
    assertEquals(output.stdoutText, null);
    assertEquals(output.stderrText, null);
    assertEquals(output.status.success, true);
  });

  test("spawn piped: output() buffers with lazy text getters", async (sandbox) => {
    const child = await sandbox.spawn("bash", {
      args: ["-c", "printf out; printf err >&2"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await child.output();
    assertEquals(output.stdoutText, "out");
    assertEquals(output.stderrText, "err");
    assertEquals(output.stdout, new TextEncoder().encode("out"));
    assertEquals(output.stderr, new TextEncoder().encode("err"));
    assertEquals(output.status, {
      success: true,
      code: 0,
      signal: null,
      oom: false,
    });
  });

  test("spawn: nonzero exit resolves status (never rejects)", async (sandbox) => {
    const child = await sandbox.spawn("bash", { args: ["-c", "exit 9"] });
    const status = await child.status;
    assertEquals(status.success, false);
    assertEquals(status.code, 9);
    assertEquals(status.signal, null);
    assertEquals(status.oom, false);
  });

  test("spawn: kill() SIGTERM default reports 143/SIGTERM", async (sandbox) => {
    const child = await sandbox.spawn("sleep", { args: ["5"] });
    await child.kill();
    const status = await child.status;
    assertEquals(status.code, 143);
    assertEquals(status.signal, "SIGTERM");
    assertEquals(status.success, false);
  });

  test("spawn: kill(SIGKILL) reports 137/SIGKILL, oom false without cgroup evidence", async (sandbox) => {
    const child = await sandbox.spawn("sleep", { args: ["5"] });
    await child.kill("SIGKILL");
    const status = await child.status;
    assertEquals(status.code, 137);
    assertEquals(status.signal, "SIGKILL");
    assertEquals(status.oom, false);
  });

  test("spawn: piped stdin streams into the child", async (sandbox) => {
    const child = await sandbox.spawn("cat", {
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    });
    assert(child.stdin !== null);
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("line one\n"));
    await writer.write(new TextEncoder().encode("line two"));
    await writer.close();
    const output = await child.output();
    assertEquals(output.stdoutText, "line one\nline two");
  });

  test("spawn env layers over sandbox env; clearEnv drops it", async (sandbox) => {
    await sandbox.env.set("PARITY_BASE", "base");
    const layered = await sandbox.spawn("/bin/sh", {
      args: ["-c", 'printf "%s %s" "$PARITY_BASE" "$PARITY_SPAWN"'],
      env: { PARITY_SPAWN: "spawn" },
      stdout: "piped",
      stderr: "null",
    });
    assertEquals((await layered.output()).stdoutText, "base spawn");

    const cleared = await sandbox.spawn("/bin/sh", {
      args: ["-c", 'printf "%s" "${PARITY_BASE:-cleared}"'],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "null",
    });
    assertEquals((await cleared.output()).stdoutText, "cleared");
  });

  test("spawn: AbortSignal option kills the child", async (sandbox) => {
    const abort = new AbortController();
    const child = await sandbox.spawn("sleep", {
      args: ["5"],
      signal: abort.signal,
    });
    abort.abort();
    const status = await child.status;
    assertEquals(status.code, 143);
    assertEquals(status.signal, "SIGTERM");
  });

  // -------------------------------------------------------------------
  // fs
  // -------------------------------------------------------------------

  test("fs: text and byte round-trips; relative paths resolve under home", async (sandbox) => {
    await sandbox.fs.writeTextFile("note.txt", "from the sandbox\n");
    assertEquals(
      await sandbox.fs.readTextFile("/home/app/note.txt"),
      "from the sandbox\n",
    );
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await sandbox.fs.writeFile("/home/app/blob.bin", bytes);
    assertEquals(await sandbox.fs.readFile("blob.bin"), bytes);
  });

  test("fs: writeFile/writeTextFile accept streamed bodies", async (sandbox) => {
    const byteBody = ReadableStream.from([
      new TextEncoder().encode("chunk one, "),
      new TextEncoder().encode("chunk two"),
    ]);
    await sandbox.fs.writeFile("streamed.bin", byteBody);
    assertEquals(
      await sandbox.fs.readTextFile("streamed.bin"),
      "chunk one, chunk two",
    );
    const textBody = ReadableStream.from(["alpha ", "beta"]);
    await sandbox.fs.writeTextFile("streamed.txt", textBody);
    assertEquals(await sandbox.fs.readTextFile("streamed.txt"), "alpha beta");
  });

  test("fs: mkdir/readDir/rename/copyFile/remove", async (sandbox) => {
    await sandbox.fs.mkdir("/home/app/dir/sub", { recursive: true });
    await sandbox.fs.writeTextFile("/home/app/dir/a.txt", "A");
    await sandbox.fs.copyFile("/home/app/dir/a.txt", "/home/app/dir/b.txt");
    await sandbox.fs.rename("/home/app/dir/b.txt", "/home/app/dir/c.txt");
    const names: string[] = [];
    for await (const entry of sandbox.fs.readDir("/home/app/dir")) {
      names.push(entry.name + (entry.isDirectory ? "/" : ""));
    }
    assertEquals(names.toSorted(), ["a.txt", "c.txt", "sub/"]);
    await sandbox.fs.remove("/home/app/dir", { recursive: true });
    await assertRejects(
      () => sandbox.fs.stat("/home/app/dir"),
      Deno.errors.NotFound,
    );
  });

  test("fs: stat/lstat/symlink/readLink/realPath", async (sandbox) => {
    await sandbox.fs.writeTextFile("/home/app/real.txt", "real");
    await sandbox.fs.symlink("real.txt", "/home/app/link.txt");
    const followed = await sandbox.fs.stat("/home/app/link.txt");
    assert(followed.isFile);
    assertFalse(followed.isSymlink);
    assertEquals(followed.size, 4);
    const link = await sandbox.fs.lstat("/home/app/link.txt");
    assert(link.isSymlink);
    // The stored target is verbatim.
    assertEquals(await sandbox.fs.readLink("/home/app/link.txt"), "real.txt");
    // realPath returns an in-sandbox path — the host prefix never leaks.
    assertEquals(
      await sandbox.fs.realPath("/home/app/link.txt"),
      "/home/app/real.txt",
    );
  });

  test("fs: missing files surface NotFound", async (sandbox) => {
    await assertRejects(
      () => sandbox.fs.readFile("/home/app/absent.txt"),
      Deno.errors.NotFound,
    );
  });

  test("fs: FsFile read/write/seek/truncate/stat; close is idempotent", async (sandbox) => {
    const file = await sandbox.fs.create("/home/app/handle.bin");
    assertEquals(await file.write(new TextEncoder().encode("0123456789")), 10);
    // SeekMode values mirror Deno: 0 = Start.
    assertEquals(await file.seek(2, 0), 2);
    const buffer = new Uint8Array(3);
    assertEquals(await file.read(buffer), 3);
    assertEquals(new TextDecoder().decode(buffer), "234");
    await file.truncate(4);
    assertEquals((await file.stat()).size, 4);
    await file.close();
    await file.close(); // idempotent — never throws
    await assertRejects(() => file.stat());
  });

  test("fs: FsFile readable/writable streams; asyncDispose closes", async (sandbox) => {
    {
      await using file = await sandbox.fs.create("/home/app/stream.txt");
      const writer = file.writable.getWriter();
      await writer.write(new TextEncoder().encode("streamed bytes"));
      writer.releaseLock();
    }
    const reader = await sandbox.fs.open("/home/app/stream.txt");
    let text = "";
    for await (const chunk of reader.readable) {
      text += new TextDecoder().decode(chunk);
    }
    assertEquals(text, "streamed bytes");
    await reader.close();
  });

  test("fs: walk and expandGlob yield in-sandbox paths", async (sandbox) => {
    await sandbox.fs.mkdir("/home/app/tree/deep", { recursive: true });
    await sandbox.fs.writeTextFile("/home/app/tree/one.ts", "");
    await sandbox.fs.writeTextFile("/home/app/tree/deep/two.ts", "");
    await sandbox.fs.writeTextFile("/home/app/tree/skip.md", "");

    const walked: string[] = [];
    for await (
      const entry of sandbox.fs.walk("/home/app/tree", {
        includeDirs: false,
        exts: [".ts"],
      })
    ) {
      walked.push(entry.path);
    }
    assertEquals(walked.toSorted(), [
      "/home/app/tree/deep/two.ts",
      "/home/app/tree/one.ts",
    ]);

    const globbed: string[] = [];
    for await (
      const entry of sandbox.fs.expandGlob("tree/**/*.ts", { globstar: true })
    ) {
      globbed.push(entry.path);
    }
    assertEquals(globbed.toSorted(), [
      "/home/app/tree/deep/two.ts",
      "/home/app/tree/one.ts",
    ]);
  });

  test("fs: makeTempDir/makeTempFile return usable in-sandbox paths", async (sandbox) => {
    const dir = await sandbox.fs.makeTempDir({ prefix: "parity-" });
    assertMatch(dir, /^\/tmp\/parity-/);
    const file = await sandbox.fs.makeTempFile({ suffix: ".txt" });
    assertMatch(file, /\.txt$/);
    await sandbox.fs.writeTextFile(`${dir}/inside.txt`, "in temp");
    assertEquals(await sandbox.fs.readTextFile(`${dir}/inside.txt`), "in temp");
    await sandbox.fs.writeTextFile(file, "tmpfile");
    assertEquals(await sandbox.fs.readTextFile(file), "tmpfile");
  });

  // -------------------------------------------------------------------
  // env
  // -------------------------------------------------------------------

  test("env: get/set/toObject/delete; missing keys read undefined", async (sandbox) => {
    assertEquals(await sandbox.env.get("PARITY_MISSING"), undefined);
    await sandbox.env.set("PARITY_ONE", "1");
    await sandbox.env.set("PARITY_TWO", "2");
    assertEquals(await sandbox.env.get("PARITY_ONE"), "1");
    const all = await sandbox.env.toObject();
    assertEquals(all.PARITY_ONE, "1");
    assertEquals(all.PARITY_TWO, "2");
    await sandbox.env.delete("PARITY_ONE");
    await sandbox.env.delete("PARITY_ONE"); // no-op when unset
    assertEquals(await sandbox.env.get("PARITY_ONE"), undefined);
    assertEquals(await sandbox.env.get("PARITY_TWO"), "2");
  });

  Deno.test(`parity[${backend.label}]: SandboxOptions.env lands in env.* and in spawns`, async () => {
    await using sandbox = await backend.create({
      env: { PARITY_SEED: "seeded" },
    });
    assertEquals(await sandbox.env.get("PARITY_SEED"), "seeded");
    assertEquals(await sandbox.sh`printf '%s' "$PARITY_SEED"`.text(), "seeded");
  });

  test("env set after create is visible to later spawns", async (sandbox) => {
    await sandbox.env.set("PARITY_LATER", "later");
    assertEquals(await sandbox.sh`printf '%s' "$PARITY_LATER"`.text(), "later");
  });

  // -------------------------------------------------------------------
  // deno runtime
  // -------------------------------------------------------------------

  test("deno.eval: primitives and plain objects round-trip", async (sandbox) => {
    assertEquals(await sandbox.deno.eval<number>("6 * 7"), 42);
    assertEquals(await sandbox.deno.eval<string>('"str" + "ing"'), "string");
    assertEquals(await sandbox.deno.eval("undefined"), undefined);
    assertEquals(await sandbox.deno.eval("null"), null);
    assertEquals(await sandbox.deno.eval("({ a: [1, 2], b: { c: true } })"), {
      a: [1, 2],
      b: { c: true },
    });
  });

  test("deno.eval: Map/Set/Date preserved; class instances arrive plain", async (sandbox) => {
    const map = await sandbox.deno.eval<Map<string, number>>(
      'new Map([["a", 1], ["b", 2]])',
    );
    assertInstanceOf(map, Map);
    assertEquals(map.get("b"), 2);
    const set = await sandbox.deno.eval<Set<number>>("new Set([1, 2, 3])");
    assertInstanceOf(set, Set);
    assertEquals([...set], [1, 2, 3]);
    const date = await sandbox.deno.eval<Date>(
      'new Date("2026-07-11T00:00:00Z")',
    );
    assertInstanceOf(date, Date);
    assertEquals(date.toISOString(), "2026-07-11T00:00:00.000Z");
    const plain = await sandbox.deno.eval(
      "class Point { constructor(x, y) { this.x = x; this.y = y } }\n" +
        "new Point(3, 4)",
    );
    assertEquals(plain, { x: 3, y: 4 });
  });

  test("deno.eval is ephemeral: no state survives between calls", async (sandbox) => {
    assertEquals(await sandbox.deno.eval("globalThis.leak = 5"), 5);
    assertEquals(
      await sandbox.deno.eval<string>("typeof globalThis.leak"),
      "undefined",
    );
  });

  test("deno.eval: errors thrown by evaluated code re-throw with their message", async (sandbox) => {
    const error = await assertRejects(
      () => sandbox.deno.eval('throw new RangeError("out of cheese")'),
      Error,
      "out of cheese",
    );
    assertEquals(error.name, "RangeError");
  });

  test("deno.repl: state persists; call() takes names and inline fns", async (sandbox) => {
    const repl = await sandbox.deno.repl();
    try {
      assertEquals(await repl.eval("let x = 2"), undefined);
      assertEquals(await repl.eval("x + 3"), 5);
      await repl.eval("function scale(n, by) { return n * by }");
      assertEquals(await repl.call<number>("scale", 5, 4), 20);
      assertEquals(
        await repl.call<number>("(m) => m.get('k') + x", new Map([["k", 10]])),
        12,
      );
    } finally {
      await repl.close();
    }
  });

  test("deno.repl: close() tears the session down; later evals reject", async (sandbox) => {
    const repl = await sandbox.deno.repl();
    assertEquals(await repl.eval("1 + 1"), 2);
    await repl.close();
    await repl.close(); // idempotent
    await assertRejects(() => repl.eval("2 + 2"));
  });

  test("deno.run: inline code with scriptArgs surfaced as Deno.args", async (sandbox) => {
    const process = await sandbox.deno.run({
      code: "console.log(JSON.stringify(Deno.args));",
      scriptArgs: ["alpha", "beta"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await process.output();
    assertEquals(output.status.success, true, output.stderrText ?? "");
    assertEquals(output.stdoutText, '["alpha","beta"]\n');
  });

  test("deno.run: entrypoint file from the sandbox fs", async (sandbox) => {
    await sandbox.fs.writeTextFile(
      "/home/app/hello.ts",
      'console.log("hello from", ...Deno.args);',
    );
    const process = await sandbox.deno.run({
      entrypoint: "/home/app/hello.ts",
      scriptArgs: ["entrypoint"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await process.output();
    assertEquals(output.status.success, true, output.stderrText ?? "");
    assertEquals(output.stdoutText, "hello from entrypoint\n");
  });

  // -------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------

  Deno.test(`parity[${backend.label}]: dispose === close; closed resolves; later use throws`, async () => {
    const sandbox = await backend.create();
    let closedSettled = false;
    const closedWatcher = sandbox.closed.then(() => {
      closedSettled = true;
    });
    await sandbox[Symbol.asyncDispose]();
    await closedWatcher;
    assert(closedSettled, "closed must resolve once the sandbox closes");
    await assertRejects(() => sandbox.sh`echo nope`.text());
    await sandbox.close(); // idempotent
  });

  Deno.test(`parity[${backend.label}]: kill() is authoritative teardown with live children`, async () => {
    const sandbox = await backend.create();
    const child = await sandbox.spawn("sleep", { args: ["30"] });
    await sandbox.kill();
    await sandbox.closed;
    // The sandbox's children die with it.
    const status = await child.status;
    assertEquals(status.success, false);
    assert(status.code !== 0);
    await assertRejects(() => sandbox.env.get("ANY"));
  });

  if (backend.supportsConnect) {
    Deno.test(`parity[${backend.label}]: connect(id) reaches the live sandbox; unknown ids fail`, async () => {
      await using sandbox = await backend.create();
      await sandbox.env.set("PARITY_CONNECT", "shared");
      const connected = await SandboxStatic.connect(sandbox.id);
      assertEquals(connected.id, sandbox.id);
      assertEquals(await connected.env.get("PARITY_CONNECT"), "shared");
      await assertRejects(() =>
        SandboxStatic.connect("sbx_loc_00000000000000000000")
      );
    });
  }
}
