/**
 * Track B unit suite: {@linkcode AgentFs} against a per-test temp root.
 * Covers the full `AgentFileSystem` contract surface, the `AgentFsFile`
 * lifecycle, streaming bodies in both directions, symlink containment
 * (rule 4), `walk`/`expandGlob` parity with `jsr:@std/fs`, and
 * `Deno.errors.*` mapping fidelity.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, relative } from "@std/path";
import { walk as stdWalk } from "@std/fs/walk";
import { expandGlob as stdExpandGlob } from "@std/fs/expand-glob";

import { AgentFs } from "../../../src/agent/fs.ts";
import { AgentError, SeekMode } from "../../../src/agent/mod.ts";
import type { WalkEntry, WalkOptions } from "../../../src/agent/mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FsContext {
  fs: AgentFs;
  /** Realpath of the sandbox root on the host. */
  root: string;
}

/** Fresh sandbox root with the default home provisioned. */
async function withFs(
  fn: (ctx: FsContext) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "sbx-agent-fs-" });
  try {
    const fs = new AgentFs({ root });
    await fs.mkdir("/home/app", { recursive: true });
    await fn({ fs, root: await Deno.realPath(root) });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function sortEntries(entries: WalkEntry[]): WalkEntry[] {
  return entries
    .map((entry) => ({
      path: entry.path,
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Translate host entries from @std/fs into in-sandbox expectations. */
function translate(entries: WalkEntry[], root: string): WalkEntry[] {
  return sortEntries(entries.map((entry) => ({
    ...entry,
    path: entry.path === root ? "/" : entry.path.slice(root.length),
  })));
}

async function buildFixtureTree(fs: AgentFs): Promise<void> {
  await fs.mkdir("/fx/sub/deep", { recursive: true });
  await fs.writeTextFile("/fx/a.txt", "a");
  await fs.writeTextFile("/fx/b.md", "b");
  await fs.writeTextFile("/fx/sub/c.txt", "c");
  await fs.writeTextFile("/fx/sub/deep/d.txt", "d");
}

Deno.test("agent fs: constructor validates root/home/cwd", async () => {
  assertThrows(
    () => new AgentFs({ root: "not/absolute" }),
    AgentError,
    "absolute",
  );
  try {
    new AgentFs({ root: "relative" });
  } catch (error) {
    assert(error instanceof AgentError, "expected AgentError");
    assertEquals(error.code, "SBX_AGENT_VALIDATION");
  }
  await withFs(({ root }) => {
    assertThrows(() => new AgentFs({ root, home: "app" }), AgentError);
    assertThrows(() => new AgentFs({ root, cwd: "work" }), AgentError);
    const fs = new AgentFs({ root });
    assertEquals(fs.home, "/home/app");
    assertEquals(fs.cwd, "/home/app");
    return Promise.resolve();
  });
});

Deno.test("agent fs: readFile/writeFile round-trip with options", async () => {
  await withFs(async ({ fs, root }) => {
    const bytes = encoder.encode("hello bytes");
    await fs.writeFile("/data.bin", bytes);
    assertEquals(await fs.readFile("/data.bin"), bytes);
    // The write landed under the host root, not anywhere else.
    assertEquals(
      decoder.decode(await Deno.readFile(join(root, "data.bin"))),
      "hello bytes",
    );

    await fs.writeFile("/data.bin", encoder.encode("!"), { append: true });
    assertEquals(await fs.readTextFile("/data.bin"), "hello bytes!");

    await assertRejects(
      () => fs.writeFile("/data.bin", bytes, { createNew: true }),
      Deno.errors.AlreadyExists,
    );
    await assertRejects(
      () => fs.writeFile("/absent/data.bin", bytes),
      Deno.errors.NotFound,
    );

    // Aborted signals surface exactly as Deno.readFile surfaces them.
    const aborted = AbortSignal.abort(new Error("stop"));
    await assertRejects(
      () => fs.readFile("/data.bin", { signal: aborted }),
      Error,
      "stop",
    );
  });
});

Deno.test("agent fs: text helpers and streamed bodies", async () => {
  await withFs(async ({ fs }) => {
    await fs.writeTextFile("/t.txt", "plain");
    assertEquals(await fs.readTextFile("/t.txt"), "plain");

    await fs.writeTextFile(
      "/t.txt",
      ReadableStream.from(["streamed ", "text"]),
    );
    assertEquals(await fs.readTextFile("/t.txt"), "streamed text");

    await fs.writeFile(
      "/s.bin",
      ReadableStream.from([
        encoder.encode("chunk one|"),
        encoder.encode("chunk two"),
      ]),
    );
    assertEquals(await fs.readTextFile("/s.bin"), "chunk one|chunk two");

    await fs.writeFile(
      "/s.bin",
      ReadableStream.from([encoder.encode("|appended")]),
      { append: true },
    );
    assertEquals(
      await fs.readTextFile("/s.bin"),
      "chunk one|chunk two|appended",
    );
  });
});

Deno.test("agent fs: relative paths resolve against the configured cwd", async () => {
  await withFs(async ({ fs, root }) => {
    await fs.writeTextFile("note.txt", "in home");
    assertEquals(await fs.readTextFile("/home/app/note.txt"), "in home");

    const worker = new AgentFs({ root, cwd: "/work" });
    await worker.mkdir("/work");
    await worker.writeTextFile("w.txt", "in work");
    assertEquals(await fs.readTextFile("/work/w.txt"), "in work");
    assertEquals(worker.home, "/home/app");
    assertEquals(worker.cwd, "/work");
  });
});

Deno.test("agent fs: dot-dot clamps at the sandbox root", async () => {
  await withFs(async ({ fs, root }) => {
    await fs.writeTextFile("/../../up.txt", "clamped");
    assertEquals(await fs.readTextFile("/up.txt"), "clamped");
    assertEquals(
      decoder.decode(await Deno.readFile(join(root, "up.txt"))),
      "clamped",
    );
    // Nothing was written beside the root on the host.
    let escaped = true;
    try {
      await Deno.lstat(join(root, "..", "up.txt"));
    } catch {
      escaped = false;
    }
    assertEquals(escaped, false, "clamping must not touch the host parent");

    // Relative traversal from cwd clamps the same way.
    await fs.writeTextFile("../../../../esc.txt", "also clamped");
    assertEquals(await fs.readTextFile("/esc.txt"), "also clamped");
    assertEquals(await fs.realPath("/.."), "/");
  });
});

Deno.test("agent fs: readDir lists entries without order guarantees", async () => {
  await withFs(async ({ fs }) => {
    await buildFixtureTree(fs);
    await fs.symlink("a.txt", "/fx/lnk");
    const entries = await collect(fs.readDir("/fx"));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assertEquals(
      [...byName.keys()].sort(),
      ["a.txt", "b.md", "lnk", "sub"],
    );
    assert(byName.get("a.txt")?.isFile, "a.txt should be a file");
    assert(byName.get("sub")?.isDirectory, "sub should be a directory");
    assert(byName.get("lnk")?.isSymlink, "lnk should be a symlink");
    await assertRejects(
      () => collect(fs.readDir("/missing")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("agent fs: mkdir/remove/rename/copyFile/link/truncate", async () => {
  await withFs(async ({ fs }) => {
    await fs.mkdir("/a/b/c", { recursive: true });
    assert((await fs.stat("/a/b/c")).isDirectory, "recursive mkdir failed");
    await assertRejects(() => fs.mkdir("/a"), Deno.errors.AlreadyExists);

    await fs.writeTextFile("/a/b/c/f.txt", "payload");
    await assertRejects(() => fs.remove("/a"), Error); // non-empty, no recursive
    await fs.rename("/a/b/c/f.txt", "/a/moved.txt");
    assertEquals(await fs.readTextFile("/a/moved.txt"), "payload");
    await assertRejects(
      () => fs.stat("/a/b/c/f.txt"),
      Deno.errors.NotFound,
    );

    await fs.copyFile("/a/moved.txt", "/a/copy.txt");
    assertEquals(await fs.readTextFile("/a/copy.txt"), "payload");

    await fs.link("/a/moved.txt", "/a/hard.txt");
    assertEquals((await fs.stat("/a/hard.txt")).nlink, 2);
    assertEquals(
      (await fs.stat("/a/moved.txt")).ino,
      (await fs.stat("/a/hard.txt")).ino,
    );

    await fs.truncate("/a/copy.txt", 3);
    assertEquals(await fs.readTextFile("/a/copy.txt"), "pay");
    await fs.truncate("/a/copy.txt");
    assertEquals((await fs.stat("/a/copy.txt")).size, 0);

    await fs.remove("/a", { recursive: true });
    await assertRejects(() => fs.stat("/a"), Deno.errors.NotFound);
  });
});

Deno.test("agent fs: stat follows symlinks, lstat does not", async () => {
  await withFs(async ({ fs }) => {
    await fs.writeTextFile("/real.txt", "12345");
    await fs.symlink("real.txt", "/via");
    const followed = await fs.stat("/via");
    assert(followed.isFile, "stat should follow to the file");
    assertEquals(followed.size, 5);
    const link = await fs.lstat("/via");
    assert(link.isSymlink, "lstat should see the link itself");
    assertEquals(await fs.readLink("/via"), "real.txt");
    assertEquals(await fs.realPath("/via"), "/real.txt");
  });
});

Deno.test("agent fs: chmod/chown/utime/umask", async () => {
  await withFs(async ({ fs }) => {
    await fs.writeTextFile("/perm.txt", "x");
    await fs.chmod("/perm.txt", 0o600);
    assertEquals((await fs.stat("/perm.txt")).mode & 0o777, 0o600);

    // uid/gid null is the unprivileged no-op path.
    await fs.chown("/perm.txt", null, null);

    const atime = new Date("2024-01-02T03:04:05Z");
    const mtime = new Date("2024-06-07T08:09:10Z");
    await fs.utime("/perm.txt", atime, mtime);
    assertEquals(
      (await fs.stat("/perm.txt")).mtime.getTime(),
      mtime.getTime(),
    );

    // umask is process-global (documented caveat): set, verify, restore.
    const previous = await fs.umask(0o077);
    try {
      assertEquals(await fs.umask(), 0o077);
    } finally {
      assertEquals(await fs.umask(previous), 0o077);
    }
    assertEquals(await fs.umask(), previous);
  });
});

Deno.test("agent fs: makeTempDir/makeTempFile stay in-sandbox", async () => {
  await withFs(async ({ fs, root }) => {
    const dir = await fs.makeTempDir();
    assert(dir.startsWith("/tmp/"), `default parent should be /tmp: ${dir}`);
    assert((await fs.stat(dir)).isDirectory, "temp dir should exist");
    assert(!dir.includes(root), "host root must never leak");

    const file = await fs.makeTempFile({
      dir,
      prefix: "pre-",
      suffix: ".txt",
    });
    assert(file.startsWith(`${dir}/`), "explicit dir option ignored");
    const name = file.slice(dir.length + 1);
    assert(name.startsWith("pre-"), `prefix missing: ${name}`);
    assert(name.endsWith(".txt"), `suffix missing: ${name}`);
    assert((await fs.stat(file)).isFile, "temp file should exist");

    // Everything landed under the host root.
    await Deno.stat(join(root, file.slice(1)));

    // An explicit missing parent mirrors Deno and fails.
    await assertRejects(
      () => fs.makeTempDir({ dir: "/no/such/dir" }),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("agent fs: symlink containment (rule 4)", async () => {
  await withFs(async ({ fs, root }) => {
    const outside = await Deno.makeTempDir({ prefix: "sbx-outside-" });
    try {
      const outsideReal = await Deno.realPath(outside);
      await Deno.writeTextFile(join(outsideReal, "secret.txt"), "secret");

      // In-root relative link: follows fine.
      await fs.mkdir("/lib");
      await fs.writeTextFile("/lib/ok.txt", "fine");
      await fs.symlink("../lib/ok.txt", "/home/inlink");
      await fs.mkdir("/home", { recursive: true });
      assertEquals(await fs.readTextFile("/home/inlink"), "fine");

      // Relative escape: stored verbatim, unfollowable.
      const relTarget = join(relative(root, outsideReal), "secret.txt");
      await fs.symlink(relTarget, "/leak-rel");
      assertEquals(await fs.readLink("/leak-rel"), relTarget);
      assert((await fs.lstat("/leak-rel")).isSymlink, "link should exist");
      const relError = await assertRejects(
        () => fs.readFile("/leak-rel"),
        AgentError,
      );
      assertEquals(relError.code, "SBX_AGENT_PATH_ESCAPE");
      await assertRejects(() => fs.stat("/leak-rel"), AgentError);

      // Absolute target: verbatim, resolves against the HOST root in the
      // fake, so following it escapes and throws.
      await fs.symlink(outsideReal, "/leak-abs");
      const absError = await assertRejects(
        () => collect(fs.readDir("/leak-abs")),
        AgentError,
      );
      assertEquals(absError.code, "SBX_AGENT_PATH_ESCAPE");

      // Escaping links can still be inspected and removed.
      await fs.remove("/leak-rel");
      await fs.remove("/leak-abs");
      await assertRejects(() => fs.lstat("/leak-rel"), Deno.errors.NotFound);

      // Intermediate escaping component is caught too.
      await fs.symlink(outsideReal, "/outdir");
      const midError = await assertRejects(
        () => fs.readFile("/outdir/secret.txt"),
        AgentError,
      );
      assertEquals(midError.code, "SBX_AGENT_PATH_ESCAPE");
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("agent fs: dangling symlinks confine creation", async () => {
  await withFs(async ({ fs }) => {
    const outside = await Deno.makeTempDir({ prefix: "sbx-outside-" });
    try {
      // Dangling in-root link: confinement permits it, so the outcome is
      // whatever raw Deno does on this platform (macOS refuses with
      // NotFound; a platform that creates through must land in-root).
      await fs.symlink("missing.txt", "/dangle-in");
      let inRootError: unknown;
      try {
        await fs.writeFile("/dangle-in", encoder.encode("created"));
        assertEquals(await fs.readTextFile("/missing.txt"), "created");
      } catch (error) {
        inRootError = error;
      }
      assert(
        !(inRootError instanceof AgentError),
        "in-root dangling links are an OS concern, not a confinement one",
      );

      // Dangling out-of-root link: creation would escape - refused.
      const escapeTarget = join(
        await Deno.realPath(outside),
        "planted.txt",
      );
      await fs.symlink(escapeTarget, "/dangle-out");
      const error = await assertRejects(
        () => fs.writeFile("/dangle-out", encoder.encode("nope")),
        AgentError,
      );
      assertEquals(error.code, "SBX_AGENT_PATH_ESCAPE");
      await assertRejects(
        () => Deno.lstat(escapeTarget),
        Deno.errors.NotFound,
        undefined,
        "the escape target must not have been created",
      );
      await assertRejects(
        () => fs.open("/dangle-out", { write: true, create: true }),
        AgentError,
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test(
  "agent fs: deep directory trees don't exhaust the symlink budget",
  async () => {
    await withFs(async ({ fs }) => {
      // 40 nested plain (non-symlink) directory components — deeper than
      // MAX_SYMLINK_DEPTH (32). A `recursive` mkdir resolves through every
      // missing ancestor; the ancestor walk must NOT consume the ELOOP
      // budget, or this falsely throws FilesystemLoop.
      const names = Array.from({ length: 40 }, (_v, i) => `d${i}`);
      const deep = "/" + names.join("/");
      await fs.mkdir(deep, { recursive: true });
      await fs.writeTextFile(deep + "/leaf.txt", "deep");
      assertEquals(await fs.readTextFile(deep + "/leaf.txt"), "deep");

      // A modest symlink chain UNDER that deep prefix still resolves: the
      // 3 real symlink hops are the only charge against the budget, the
      // deep directory descent is not.
      await fs.writeTextFile(deep + "/real.txt", "real");
      await fs.symlink("real.txt", deep + "/l1");
      await fs.symlink("l1", deep + "/l2");
      await fs.symlink("l2", deep + "/deeplink");
      assertEquals(await fs.readTextFile(deep + "/deeplink"), "real");
    });
  },
);

Deno.test(
  "agent fs: genuine deep symlink chains still raise FilesystemLoop",
  async () => {
    await withFs(async ({ fs }) => {
      // 64 relative symlink hops terminating in a real file — a genuine
      // over-budget chain. Resolving it must still surface FilesystemLoop.
      await fs.writeTextFile("/target.txt", "x");
      const links = Array.from({ length: 64 }, (_v, i) => `chain${i}`);
      for (let i = 0; i < links.length; i++) {
        const target = i + 1 < links.length ? links[i + 1] : "target.txt";
        await fs.symlink(target, "/" + links[i]);
      }
      await assertRejects(
        () => fs.stat("/" + links[0]),
        Deno.errors.FilesystemLoop,
      );

      // A genuine cycle loops forever without our guard; must also throw.
      await fs.symlink("cyc-b", "/cyc-a");
      await fs.symlink("cyc-a", "/cyc-b");
      await assertRejects(
        () => fs.stat("/cyc-a"),
        Deno.errors.FilesystemLoop,
      );
    });
  },
);

Deno.test("agent fs: realPath returns in-sandbox paths only", async () => {
  await withFs(async ({ fs, root }) => {
    await fs.mkdir("/fx/sub", { recursive: true });
    await fs.writeTextFile("/fx/sub/f.txt", "x");
    assertEquals(await fs.realPath("/fx/./sub/../sub/f.txt"), "/fx/sub/f.txt");
    assertEquals(await fs.realPath("/"), "/");
    await fs.symlink("fx/sub", "/short");
    const resolved = await fs.realPath("/short/f.txt");
    assertEquals(resolved, "/fx/sub/f.txt");
    assert(!resolved.includes(root), "host prefix must never leak");
    await assertRejects(() => fs.realPath("/nope"), Deno.errors.NotFound);
  });
});

Deno.test("agent fs: FsFile lifecycle mirrors Deno.FsFile", async () => {
  await withFs(async ({ fs }) => {
    const file = await fs.create("/f.bin");
    assertEquals(await file.write(encoder.encode("0123456789")), 10);

    assertEquals(await file.seek(0, SeekMode.Start), 0);
    const head = new Uint8Array(4);
    assertEquals(await file.read(head), 4);
    assertEquals(decoder.decode(head), "0123");

    assertEquals(await file.seek(2, SeekMode.Current), 6);
    assertEquals(await file.seek(-4, SeekMode.End), 6);
    const tail = new Uint8Array(16);
    assertEquals(await file.read(tail), 4);
    assertEquals(decoder.decode(tail.subarray(0, 4)), "6789");

    // EOF reads resolve null, never 0, for a non-empty buffer.
    assertEquals(await file.read(new Uint8Array(8)), null);

    assertEquals((await file.stat()).size, 10);
    await file.truncate(4);
    assertEquals((await file.stat()).size, 4);
    await file.truncate();
    assertEquals((await file.stat()).size, 0);

    await file.sync();
    await file.syncData();
    const mtime = new Date("2025-05-05T05:05:05Z");
    await file.utime(mtime, mtime);
    assertEquals((await file.stat()).mtime.getTime(), mtime.getTime());

    await file.lock(true);
    await file.unlock();
    await file.lock(); // shared
    await file.unlock();

    await file.close();
    await file.close(); // idempotent

    for (
      const use of [
        () => file.read(new Uint8Array(1)),
        () => file.write(new Uint8Array(1)),
        () => file.seek(0, SeekMode.Start),
        () => file.truncate(),
        () => file.stat(),
        () => file.sync(),
        () => file.syncData(),
        () => file.utime(0, 0),
        () => file.lock(),
        () => file.unlock(),
      ]
    ) {
      const error = await assertRejects(use, AgentError);
      assertEquals(error.code, "SBX_AGENT_CLOSED");
    }
  });
});

Deno.test("agent fs: open defaults are read-only, create() truncates", async () => {
  await withFs(async ({ fs }) => {
    await assertRejects(() => fs.open("/absent.txt"), Deno.errors.NotFound);

    await fs.writeTextFile("/ro.txt", "read only");
    const ro = await fs.open("/ro.txt");
    const buf = new Uint8Array(9);
    assertEquals(await ro.read(buf), 9);
    await assertRejects(() => ro.write(encoder.encode("x")), Error);
    await ro.close();

    const truncated = await fs.create("/ro.txt");
    assertEquals((await truncated.stat()).size, 0);
    await truncated.close();

    const create = await fs.open("/new.txt", {
      read: true,
      write: true,
      create: true,
    });
    await create.write(encoder.encode("made"));
    await create.close();
    assertEquals(await fs.readTextFile("/new.txt"), "made");
  });
});

Deno.test("agent fs: FsFile.readable pulls 64KiB and leaves the handle open", async () => {
  await withFs(async ({ fs }) => {
    const size = 100_000;
    const payload = new Uint8Array(size).map((_, i) => i % 251);
    await fs.writeFile("/big.bin", payload);

    const file = await fs.open("/big.bin");
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.readable) chunks.push(chunk);
    assertEquals(
      chunks.map((chunk) => chunk.byteLength),
      [64 * 1024, size - 64 * 1024],
    );
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    assertEquals(joined, payload);

    // Draining the stream must NOT close the handle.
    assertEquals(await file.seek(0, SeekMode.Start), 0);
    const again = new Uint8Array(4);
    assertEquals(await file.read(again), 4);
    await file.close();
  });
});

Deno.test("agent fs: FsFile.writable writes at the cursor without closing", async () => {
  await withFs(async ({ fs }) => {
    const file = await fs.create("/w.bin");
    await file.write(encoder.encode(">>"));
    const writer = file.writable.getWriter();
    await writer.write(encoder.encode("stream "));
    await writer.write(encoder.encode("body"));
    await writer.close();

    // Handle survives the stream close.
    assertEquals(await file.write(encoder.encode("!")), 1);
    assertEquals((await file.stat()).size, ">>stream body!".length);
    await file.close();
    assertEquals(await fs.readTextFile("/w.bin"), ">>stream body!");
  });
});

Deno.test("agent fs: walk mirrors @std/fs walk", async () => {
  await withFs(async ({ fs, root }) => {
    await buildFixtureTree(fs);
    const hostFx = join(root, "fx");

    const optionSets: (WalkOptions | undefined)[] = [
      undefined,
      { maxDepth: 1 },
      { includeDirs: false },
      { exts: [".txt"] },
      { match: [/c\.txt$/] },
      { skip: [/deep/] },
    ];
    for (const options of optionSets) {
      const mine = sortEntries(await collect(fs.walk("/fx", options)));
      const reference = translate(
        await collect(stdWalk(hostFx, options)),
        root,
      );
      assertEquals(mine, reference, `walk parity for ${Deno.inspect(options)}`);
    }

    // Entry paths are in-sandbox, rooted, host-free.
    for (const entry of await collect(fs.walk("/fx"))) {
      assert(entry.path.startsWith("/"), "walk paths must be rooted");
      assert(!entry.path.includes(root), "host prefix must never leak");
    }
    assertEquals((await collect(fs.walk("/fx")))[0].path, "/fx");
  });
});

Deno.test("agent fs: walk followSymlinks honors confinement", async () => {
  await withFs(async ({ fs }) => {
    const outside = await Deno.makeTempDir({ prefix: "sbx-outside-" });
    try {
      await Deno.writeTextFile(join(outside, "evil.txt"), "evil");
      await fs.mkdir("/wfx/target", { recursive: true });
      await fs.writeTextFile("/wfx/target/in.txt", "in");
      await fs.symlink("target", "/wfx/goodlink");

      const followed = sortEntries(
        await collect(fs.walk("/wfx", { followSymlinks: true })),
      );
      assert(
        followed.some((entry) => entry.path === "/wfx/target/in.txt"),
        "in-root symlink should be followed",
      );

      await fs.symlink(await Deno.realPath(outside), "/wfx/badlink");
      const error = await assertRejects(
        () => collect(fs.walk("/wfx", { followSymlinks: true })),
        AgentError,
      );
      assertEquals(error.code, "SBX_AGENT_PATH_ESCAPE");

      // Without following, the escaping link is just an entry.
      const unfollowed = sortEntries(await collect(fs.walk("/wfx")));
      assert(
        unfollowed.some(
          (entry) => entry.path === "/wfx/badlink" && entry.isSymlink,
        ),
        "unfollowed walk should list the link itself",
      );
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("agent fs: expandGlob mirrors @std/fs expandGlob", async () => {
  await withFs(async ({ fs, root }) => {
    await buildFixtureTree(fs);
    const hostFx = join(root, "fx");

    const cases: [string, { root?: string; exclude?: string[] } | undefined][] =
      [
        ["**/*.txt", { root: "/fx" }],
        ["*.md", { root: "/fx" }],
        ["sub/**", { root: "/fx" }],
        ["**/*.txt", { root: "/fx", exclude: ["sub/deep"] }],
      ];
    for (const [pattern, options] of cases) {
      const mine = sortEntries(
        await collect(fs.expandGlob(pattern, options)),
      );
      const reference = translate(
        await collect(stdExpandGlob(pattern, { ...options, root: hostFx })),
        root,
      );
      assertEquals(
        mine,
        reference,
        `expandGlob parity for ${pattern} ${Deno.inspect(options)}`,
      );
    }

    // Absolute globs are in-sandbox absolute, not host absolute.
    const absolute = sortEntries(
      await collect(fs.expandGlob("/fx/*.txt")),
    );
    assertEquals(absolute.map((entry) => entry.path), ["/fx/a.txt"]);

    // Default root is the effective cwd.
    await fs.writeTextFile("/home/app/here.txt", "cwd");
    const fromCwd = await collect(fs.expandGlob("*.txt"));
    assertEquals(fromCwd.map((entry) => entry.path), ["/home/app/here.txt"]);

    for (const entry of [...absolute, ...fromCwd]) {
      assert(!entry.path.includes(root), "host prefix must never leak");
    }
  });
});

Deno.test("agent fs: error mapping fidelity to Deno.errors", async () => {
  await withFs(async ({ fs }) => {
    await assertRejects(() => fs.stat("/nope"), Deno.errors.NotFound);
    await assertRejects(() => fs.readFile("/nope"), Deno.errors.NotFound);
    await assertRejects(() => fs.readLink("/nope"), Deno.errors.NotFound);
    await assertRejects(
      () => fs.remove("/nope"),
      Deno.errors.NotFound,
    );
    await fs.mkdir("/dup");
    await assertRejects(() => fs.mkdir("/dup"), Deno.errors.AlreadyExists);
    await fs.writeTextFile("/dup/f.txt", "x");
    await assertRejects(
      () => fs.writeFile("/dup/f.txt", new Uint8Array(1), { createNew: true }),
      Deno.errors.AlreadyExists,
    );
    // AgentError is reserved for agent-plane failures; OS errors pass
    // through untouched (they are NOT AgentError).
    const notFound = await assertRejects(() => fs.stat("/nope"));
    assert(!(notFound instanceof AgentError), "OS errors must not be wrapped");
  });
});

Deno.test("agent fs: AgentError carries typed codes and name", async () => {
  await withFs(async ({ fs }) => {
    const outside = await Deno.makeTempDir({ prefix: "sbx-outside-" });
    try {
      await fs.symlink(await Deno.realPath(outside), "/esc");
      const error = await assertRejects(() => fs.stat("/esc"), AgentError);
      assertEquals(error.code, "SBX_AGENT_PATH_ESCAPE");
      assertEquals(error.name, "AgentError");
      assertStringIncludes(error.message, "/esc");
      assertNotEquals(error.message, "");
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});
