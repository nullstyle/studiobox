/**
 * Canonical rootfs content manifest (the documented reproducibility
 * fallback from PLAN.md M4 / DESIGN.md §7).
 *
 * A content manifest is a sorted listing of every path in a built rootfs
 * tree — type, permission bits, uid/gid, size, per-file sha256, symlink
 * target (or raw rdev for device nodes). Its canonical serialization is
 * hashed to produce the rootfs identity when raw ext4 images are not
 * byte-reproducible across builds: two trees with the same content
 * manifest hash contain identical files even if `mke2fs` laid them out
 * differently.
 *
 * This module is dependency-free (no import map required) because
 * `images/build_rootfs.sh` runs `emit_content_manifest.ts` inside the
 * build VM with a bare pinned Deno binary.
 *
 * Line format (tab-separated, `\n`-terminated, sorted by path in UTF-16
 * code-unit order — plain JS `<`/`>` string comparison; hashes depend on
 * this order, so it must never change):
 *
 * ```
 * type  mode  uid  gid  size  sha256|-  target|-  path
 * ```
 *
 * `path` and `target` are percent-escaped for `%`, tab, LF and CR so the
 * format stays line/field-safe for any file name.
 */

import {
  assertSha256,
  assertText,
  assertUnsignedInteger,
  sha256Hex,
  sha256HexOfText,
} from "./validate.ts";

export type ContentEntryType =
  | "file"
  | "dir"
  | "symlink"
  | "char"
  | "block"
  | "fifo"
  | "socket";

const ENTRY_TYPES: readonly ContentEntryType[] = [
  "file",
  "dir",
  "symlink",
  "char",
  "block",
  "fifo",
  "socket",
];

export interface ContentEntry {
  /** Relative path, `/`-separated, no leading slash or dot segments. */
  path: string;
  type: ContentEntryType;
  /** Permission bits only (0..0o7777). */
  mode: number;
  uid: number;
  gid: number;
  /** Byte size for files; 0 for everything else. */
  sizeBytes: number;
  /** Required for files, null otherwise. */
  sha256: string | null;
  /** Symlink target, or decimal rdev for char/block devices; null otherwise. */
  target: string | null;
}

function escapeField(value: string): string {
  return value.replaceAll("%", "%25")
    .replaceAll("\t", "%09")
    .replaceAll("\n", "%0A")
    .replaceAll("\r", "%0D");
}

function unescapeField(value: string): string {
  return value.replaceAll("%09", "\t")
    .replaceAll("%0A", "\n")
    .replaceAll("%0D", "\r")
    .replaceAll("%25", "%");
}

export function validateContentEntry(entry: ContentEntry): void {
  assertText(entry.path, "content entry path", 4_096);
  if (
    entry.path.startsWith("/") ||
    entry.path.split("/").some((seg) =>
      seg === "" || seg === "." || seg === ".."
    )
  ) {
    throw new TypeError(
      `content entry path ${
        JSON.stringify(entry.path)
      } must be a clean relative path`,
    );
  }
  if (!ENTRY_TYPES.includes(entry.type)) {
    throw new TypeError(`content entry type ${entry.type} is invalid`);
  }
  assertUnsignedInteger(entry.mode, "content entry mode", 0o7777);
  assertUnsignedInteger(entry.uid, "content entry uid", 0xffff_ffff);
  assertUnsignedInteger(entry.gid, "content entry gid", 0xffff_ffff);
  assertUnsignedInteger(
    entry.sizeBytes,
    "content entry sizeBytes",
    Number.MAX_SAFE_INTEGER,
  );
  if (entry.type === "file") {
    assertSha256(entry.sha256, "content entry sha256");
  } else if (entry.sha256 !== null) {
    throw new TypeError("only file entries carry a sha256");
  }
  if (
    entry.type === "symlink" || entry.type === "char" || entry.type === "block"
  ) {
    assertText(entry.target, "content entry target", 4_096, true);
  } else if (entry.target !== null) {
    throw new TypeError(
      "only symlink and device entries carry a target",
    );
  }
  if (entry.type !== "file" && entry.sizeBytes !== 0) {
    throw new TypeError("non-file entries must record sizeBytes 0");
  }
}

/**
 * Canonical path order: UTF-16 code-unit comparison (JS `<`/`>`). The
 * published content-manifest hashes are computed over this order — do
 * not swap in a locale-aware or byte-wise comparator.
 */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical serialization: validated, sorted by path, duplicate paths
 * rejected, one line per entry with a trailing newline.
 */
export function formatContentManifest(entries: ContentEntry[]): string {
  const sorted = [...entries].sort((a, b) => comparePaths(a.path, b.path));
  let previous: string | null = null;
  const lines: string[] = [];
  for (const entry of sorted) {
    validateContentEntry(entry);
    if (entry.path === previous) {
      throw new TypeError(`duplicate content entry path ${entry.path}`);
    }
    previous = entry.path;
    lines.push([
      entry.type,
      entry.mode.toString(8).padStart(4, "0"),
      String(entry.uid),
      String(entry.gid),
      String(entry.sizeBytes),
      entry.sha256 ?? "-",
      entry.target === null ? "-" : escapeField(entry.target),
      escapeField(entry.path),
    ].join("\t"));
  }
  return lines.map((line) => line + "\n").join("");
}

/** Strict inverse of {@link formatContentManifest} (input may be unsorted). */
export function parseContentManifest(text: string): ContentEntry[] {
  if (text.length > 512 * 1024 * 1024) {
    throw new TypeError("content manifest is unreasonably large");
  }
  const entries: ContentEntry[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) !== "") {
    throw new TypeError("content manifest must end with a newline");
  }
  lines.pop();
  for (const [index, line] of lines.entries()) {
    const fields = line.split("\t");
    if (fields.length !== 8) {
      throw new TypeError(`content manifest line ${index + 1} is malformed`);
    }
    const [type, mode, uid, gid, size, digest, target, path] = fields;
    if (!/^[0-7]{4}$/.test(mode)) {
      throw new TypeError(
        `content manifest line ${index + 1} has a malformed mode`,
      );
    }
    for (
      const [name, numeric] of [["uid", uid], ["gid", gid], ["size", size]]
    ) {
      if (!/^\d{1,16}$/.test(numeric)) {
        throw new TypeError(
          `content manifest line ${index + 1} has a malformed ${name}`,
        );
      }
    }
    const entry: ContentEntry = {
      path: unescapeField(path),
      type: type as ContentEntryType,
      mode: parseInt(mode, 8),
      uid: Number(uid),
      gid: Number(gid),
      sizeBytes: Number(size),
      sha256: digest === "-" ? null : digest,
      target: target === "-" ? null : unescapeField(target),
    };
    validateContentEntry(entry);
    entries.push(entry);
  }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new TypeError(`duplicate content entry path ${entry.path}`);
    }
    paths.add(entry.path);
  }
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}

/** sha256 over the canonical serialization. */
export async function contentManifestHash(
  entries: ContentEntry[],
): Promise<string> {
  return await sha256HexOfText(formatContentManifest(entries));
}

const S_IFMT = 0o170000;
const FILE_TYPE_BY_BITS: Record<number, ContentEntryType> = {
  0o100000: "file",
  0o040000: "dir",
  0o120000: "symlink",
  0o020000: "char",
  0o060000: "block",
  0o010000: "fifo",
  0o140000: "socket",
};

/**
 * Walk `rootDir` and build its content manifest. Requires a POSIX
 * filesystem (mode/uid/gid must be present). File digests read each file
 * whole — acceptable for rootfs-scale inputs, see `validate.ts`.
 */
export async function collectContentManifest(
  rootDir: string,
): Promise<ContentEntry[]> {
  const root = rootDir.replace(/\/+$/, "");
  const entries: ContentEntry[] = [];

  async function visit(relative: string): Promise<void> {
    const absolute = relative === "" ? root : `${root}/${relative}`;
    if (relative !== "") {
      const info = await Deno.lstat(absolute);
      if (info.mode === null || info.uid === null || info.gid === null) {
        throw new TypeError(
          `content manifest requires POSIX metadata (at ${absolute})`,
        );
      }
      const type = FILE_TYPE_BY_BITS[info.mode & S_IFMT];
      if (type === undefined) {
        throw new TypeError(`unsupported file type at ${absolute}`);
      }
      let sha256: string | null = null;
      if (type === "file") {
        sha256 = await sha256Hex(await Deno.readFile(absolute));
      }
      let target: string | null = null;
      if (type === "symlink") {
        target = await Deno.readLink(absolute);
      } else if (type === "char" || type === "block") {
        target = String(info.rdev ?? 0);
      }
      entries.push({
        path: relative,
        type,
        mode: info.mode & 0o7777,
        uid: info.uid,
        gid: info.gid,
        sizeBytes: type === "file" ? info.size : 0,
        sha256,
        target,
      });
      if (type !== "dir") return;
    }
    for await (const child of Deno.readDir(absolute)) {
      await visit(relative === "" ? child.name : `${relative}/${child.name}`);
    }
  }

  await visit("");
  return entries.sort((a, b) => comparePaths(a.path, b.path));
}
