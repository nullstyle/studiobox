/**
 * `fs.upload` / `fs.download` — the SDK-side recursion
 * (`src/api/fs_transfer.ts`) exercised end-to-end through the in-process
 * {@linkcode FakeSandboxHost}. Each test builds a real host temp tree, drives a
 * transfer across the (fake) sandbox boundary, and asserts the bytes and
 * directory shape landed. Symlink fidelity — the literal target preserved
 * verbatim, not followed or canonicalised — is covered alongside the plain
 * file/dir round-trip.
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

import { FakeSandboxHost } from "@nullstyle/studiobox/testing";
import { Sandbox } from "@nullstyle/studiobox";

/** Recursively collect `relativePath -> textContents` for every file in `dir`. */
async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (current: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(current)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(current, entry.name);
      if (entry.isDirectory) {
        await walk(abs, rel);
      } else if (entry.isFile) {
        out.set(rel, await Deno.readTextFile(abs));
      }
    }
  };
  await walk(dir, "");
  return out;
}

Deno.test("fs.upload/download: nested directory tree round-trips both ways", async () => {
  await using _host = FakeSandboxHost.install();
  await using sandbox = await Sandbox.create();

  // Build a nested host source tree, including an empty directory.
  const local = await Deno.makeTempDir({ prefix: "sbx-xfer-src-" });
  try {
    await Deno.mkdir(join(local, "src", "nested"), { recursive: true });
    await Deno.mkdir(join(local, "src", "empty"), { recursive: true });
    await Deno.writeTextFile(join(local, "src", "a.txt"), "alpha");
    await Deno.writeTextFile(join(local, "src", "nested", "b.txt"), "bravo");
    await Deno.writeTextFile(join(local, "src", "nested", "c.txt"), "charlie");

    // Upload the directory: upstream nests the source basename under the
    // destination, so `src` lands at `/home/app/dst/src/...`.
    await sandbox.fs.mkdir("/home/app/dst", { recursive: true });
    await sandbox.fs.upload(join(local, "src"), "/home/app/dst");

    assertEquals(
      await sandbox.fs.readTextFile("/home/app/dst/src/a.txt"),
      "alpha",
    );
    assertEquals(
      await sandbox.fs.readTextFile("/home/app/dst/src/nested/b.txt"),
      "bravo",
    );
    assertEquals(
      await sandbox.fs.readTextFile("/home/app/dst/src/nested/c.txt"),
      "charlie",
    );
    // The empty directory survived the upload.
    assertEquals(
      (await sandbox.fs.stat("/home/app/dst/src/empty")).isDirectory,
      true,
    );

    // Download the uploaded tree back out; `src` nests again under `out`.
    const out = await Deno.makeTempDir({ prefix: "sbx-xfer-out-" });
    try {
      await sandbox.fs.download("/home/app/dst/src", out);
      const files = await readTree(out);
      assertEquals(
        files,
        new Map([
          ["src/a.txt", "alpha"],
          ["src/nested/b.txt", "bravo"],
          ["src/nested/c.txt", "charlie"],
        ]),
      );
      // The empty directory round-tripped to the host too.
      assertEquals(
        (await Deno.stat(join(out, "src", "empty"))).isDirectory,
        true,
      );
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test("fs.upload/download: a single file copies file -> file both ways", async () => {
  await using _host = FakeSandboxHost.install();
  await using sandbox = await Sandbox.create();

  const local = await Deno.makeTempDir({ prefix: "sbx-xfer-file-" });
  try {
    const srcFile = join(local, "one.txt");
    await Deno.writeTextFile(srcFile, "single file body");

    // Upload to an explicit destination path (file -> file, not nested).
    await sandbox.fs.upload(srcFile, "/home/app/copy.txt");
    assertEquals(
      await sandbox.fs.readTextFile("/home/app/copy.txt"),
      "single file body",
    );

    // Download it back to a fresh host path.
    const outFile = join(local, "back.txt");
    await sandbox.fs.download("/home/app/copy.txt", outFile);
    assertEquals(await Deno.readTextFile(outFile), "single file body");
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test("fs.upload/download: symlinks round-trip with their literal target", async () => {
  await using _host = FakeSandboxHost.install();
  await using sandbox = await Sandbox.create();

  const local = await Deno.makeTempDir({ prefix: "sbx-xfer-link-src-" });
  try {
    await Deno.mkdir(join(local, "tree"));
    await Deno.writeTextFile(join(local, "tree", "real.txt"), "payload");
    // A plain relative link to a sibling...
    await Deno.symlink("real.txt", join(local, "tree", "rel.link"));
    // ...and a DANGLING upward-relative link. `Deno.realPath` (the pre-fix
    // implementation) would follow this and throw `NotFound`, aborting the
    // whole upload; the literal-target copy must preserve it verbatim.
    await Deno.symlink(
      "../../nowhere/ghost.txt",
      join(local, "tree", "dead.link"),
    );

    await sandbox.fs.mkdir("/home/app/d", { recursive: true });
    await sandbox.fs.upload(join(local, "tree"), "/home/app/d");

    // Guest side: both links stored verbatim, neither followed nor rewritten.
    assertEquals(
      await sandbox.fs.readLink("/home/app/d/tree/rel.link"),
      "real.txt",
    );
    assertEquals(
      await sandbox.fs.readLink("/home/app/d/tree/dead.link"),
      "../../nowhere/ghost.txt",
    );

    // Download the tree back out; targets must be identical on the host.
    const out = await Deno.makeTempDir({ prefix: "sbx-xfer-link-out-" });
    try {
      await sandbox.fs.download("/home/app/d/tree", out);
      assertEquals(
        await Deno.readLink(join(out, "tree", "rel.link")),
        "real.txt",
      );
      assertEquals(
        await Deno.readLink(join(out, "tree", "dead.link")),
        "../../nowhere/ghost.txt",
      );
      // The plain file round-trips alongside the links.
      assertEquals(
        await Deno.readTextFile(join(out, "tree", "real.txt")),
        "payload",
      );
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});

Deno.test("fs.upload/download: an empty directory round-trips", async () => {
  await using _host = FakeSandboxHost.install();
  await using sandbox = await Sandbox.create();

  const local = await Deno.makeTempDir({ prefix: "sbx-xfer-empty-" });
  try {
    await Deno.mkdir(join(local, "hollow"));

    await sandbox.fs.mkdir("/home/app/e", { recursive: true });
    await sandbox.fs.upload(join(local, "hollow"), "/home/app/e");
    // The directory exists in the sandbox and is empty.
    assertEquals(
      (await sandbox.fs.stat("/home/app/e/hollow")).isDirectory,
      true,
    );
    let sandboxEntries = 0;
    for await (const _entry of sandbox.fs.readDir("/home/app/e/hollow")) {
      sandboxEntries++;
    }
    assertEquals(sandboxEntries, 0);

    // Download it back; the empty directory is recreated on the host.
    const out = await Deno.makeTempDir({ prefix: "sbx-xfer-empty-out-" });
    try {
      await sandbox.fs.download("/home/app/e/hollow", out);
      const info = await Deno.stat(join(out, "hollow"));
      assert(info.isDirectory, "empty dir recreated on the host");
      let hostEntries = 0;
      for await (const _entry of Deno.readDir(join(out, "hollow"))) {
        hostEntries++;
      }
      assertEquals(hostEntries, 0);
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  } finally {
    await Deno.remove(local, { recursive: true });
  }
});
