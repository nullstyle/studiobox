import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  collectContentManifest,
  type ContentEntry,
  contentManifestHash,
  formatContentManifest,
  parseContentManifest,
} from "../../../images/content_manifest.ts";
import { sha256Hex } from "../../../images/validate.ts";

function fileEntry(overrides: Partial<ContentEntry>): ContentEntry {
  return {
    path: "usr/bin/deno",
    type: "file",
    mode: 0o755,
    uid: 0,
    gid: 0,
    sizeBytes: 4,
    sha256: "a".repeat(64),
    target: null,
    ...overrides,
  };
}

Deno.test("content manifest format is canonical and parse round-trips", () => {
  const entries: ContentEntry[] = [
    fileEntry({}),
    {
      path: "etc",
      type: "dir",
      mode: 0o755,
      uid: 0,
      gid: 0,
      sizeBytes: 0,
      sha256: null,
      target: null,
    },
    {
      path: "usr/bin/sh",
      type: "symlink",
      mode: 0o777,
      uid: 0,
      gid: 0,
      sizeBytes: 0,
      sha256: null,
      target: "/bin/dash",
    },
    {
      path: "dev/null",
      type: "char",
      mode: 0o666,
      uid: 0,
      gid: 0,
      sizeBytes: 0,
      sha256: null,
      target: "259",
    },
  ];
  const text = formatContentManifest(entries);
  const reversedText = formatContentManifest([...entries].reverse());
  assertEquals(text, reversedText, "input order must not matter");
  assertEquals(
    text.split("\n").slice(0, -1).map((line) => line.split("\t")[7]),
    ["dev/null", "etc", "usr/bin/deno", "usr/bin/sh"],
    "lines are sorted by path",
  );
  assertEquals(
    parseContentManifest(text),
    [...entries].sort((a, b) => a.path < b.path ? -1 : 1),
  );
});

Deno.test("content manifest hash is stable and content-sensitive", async () => {
  const entries = [fileEntry({})];
  const base = await contentManifestHash(entries);
  assertEquals(base, await contentManifestHash([...entries]));
  assertNotEquals(
    base,
    await contentManifestHash([fileEntry({ mode: 0o700 })]),
    "mode changes the identity",
  );
  assertNotEquals(
    base,
    await contentManifestHash([fileEntry({ uid: 1000 })]),
    "ownership changes the identity",
  );
  assertNotEquals(
    base,
    await contentManifestHash([fileEntry({ sha256: "b".repeat(64) })]),
    "bytes change the identity",
  );
});

Deno.test("content manifest rejects malformed input", () => {
  assertThrows(
    () => formatContentManifest([fileEntry({}), fileEntry({})]),
    TypeError,
    "duplicate",
  );
  assertThrows(
    () => formatContentManifest([fileEntry({ path: "/abs" })]),
    TypeError,
    "relative",
  );
  assertThrows(
    () => formatContentManifest([fileEntry({ path: "a/../b" })]),
    TypeError,
    "relative",
  );
  assertThrows(
    () => formatContentManifest([fileEntry({ sha256: null })]),
    TypeError,
    "sha256",
  );
  assertThrows(
    () => formatContentManifest([fileEntry({ type: "dir", sha256: null })]),
    TypeError,
    "sizeBytes 0",
  );
  assertThrows(
    () => parseContentManifest("no tabs here\n"),
    TypeError,
    "malformed",
  );
  assertThrows(
    () => parseContentManifest("file\t0644\t0\t0\t1\t-\t-\tx"),
    TypeError,
    "newline",
  );
});

Deno.test("escaped paths survive a format/parse round-trip", () => {
  const entries = [
    fileEntry({ path: "weird/na%me\twith\ntabs" }),
    fileEntry({
      path: "weird/link",
      type: "symlink",
      sizeBytes: 0,
      sha256: null,
      target: "target\twith\ttabs",
    }),
  ];
  const parsed = parseContentManifest(formatContentManifest(entries));
  assertEquals(parsed.map((e) => e.path).sort(), [
    "weird/link",
    "weird/na%me\twith\ntabs",
  ]);
  assertEquals(parsed[0].target, "target\twith\ttabs");
});

Deno.test("collectContentManifest walks a real tree deterministically", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "etc"));
    await Deno.mkdir(join(dir, "usr", "bin"), { recursive: true });
    const body = new TextEncoder().encode("#!/bin/sh\n");
    await Deno.writeFile(join(dir, "usr", "bin", "agent"), body, {
      mode: 0o755,
    });
    await Deno.writeTextFile(join(dir, "etc", "hostname"), "studiobox\n");
    await Deno.chmod(join(dir, "etc", "hostname"), 0o644);
    await Deno.symlink("/usr/bin/agent", join(dir, "init"));

    const entries = await collectContentManifest(dir);
    assertEquals(entries.map((e) => `${e.type}:${e.path}`), [
      "dir:etc",
      "file:etc/hostname",
      "symlink:init",
      "dir:usr",
      "dir:usr/bin",
      "file:usr/bin/agent",
    ]);
    const agent = entries.find((e) => e.path === "usr/bin/agent")!;
    assertEquals(agent.mode, 0o755);
    assertEquals(agent.sizeBytes, body.length);
    assertEquals(agent.sha256, await sha256Hex(body));
    assertEquals(
      entries.find((e) => e.path === "init")!.target,
      "/usr/bin/agent",
    );

    // Trailing-slash root and a second walk agree byte-for-byte.
    const again = await collectContentManifest(`${dir}/`);
    assertEquals(formatContentManifest(again), formatContentManifest(entries));
    assertEquals(
      await contentManifestHash(again),
      await contentManifestHash(entries),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
