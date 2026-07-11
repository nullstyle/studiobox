/**
 * Shared bounded validators and hashing helpers for the artifact pipeline.
 *
 * Mirrors the fail-closed, unknown-key-rejecting style of
 * `src/state/model.ts`. This module (and everything it is imported by that
 * must run inside the rootfs build VM, i.e. `content_manifest.ts` and
 * `emit_content_manifest.ts`) is deliberately dependency-free so the builder
 * can run it with a bare pinned Deno binary and no import map.
 */

export function assertRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertKeys(
  value: object,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${field} contains unknown field ${key}`);
    }
  }
}

export function assertText(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new TypeError(`${field} must be bounded text`);
  }
}

export function assertUnsignedInteger(
  value: unknown,
  field: string,
  maximum: number,
  minimum = 0,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

export function assertTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" || value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a bounded timestamp`);
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function assertSha256(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha256 hex digest`);
  }
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Deterministic JSON serialization: object keys sorted byte-wise, arrays in
 * order, no insignificant whitespace. Properties with `undefined` values are
 * skipped (matching `JSON.stringify`); non-finite numbers and non-JSON types
 * are rejected instead of silently lowered to `null`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("cannot canonicalize a non-finite number");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${
      value.map((entry) => {
        if (entry === undefined) {
          throw new TypeError("cannot canonicalize undefined array entries");
        }
        return canonicalJson(entry);
      }).join(",")
    }]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  }
  return `{${parts.join(",")}}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256HexOfText(text: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(text));
}

/**
 * Whole-file digest. Artifact inputs top out around the ~150 MiB guest Deno
 * binary, so a single read keeps this dependency-free (WebCrypto has no
 * streaming digest) without a meaningful memory risk on build hosts.
 */
export async function sha256HexOfFile(path: string): Promise<string> {
  return await sha256Hex(await Deno.readFile(path));
}
