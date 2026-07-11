/**
 * Reproducibility and qualification gate for the canonical schemas and the
 * committed generated bindings (M1 capnp-codegen gate).
 *
 * Always runs:
 *   1. canonical schema bundle hash against `compat/wire.json`;
 *   2. pinned `capnp` compiler version + compile smoke of the bundle;
 *   3. strict typecheck of the committed `src/wire/generated/` bindings.
 *
 * When the `capnp-deno` toolchain checkout is available (sibling
 * `../capnp-deno` or `$STUDIOBOX_CAPNP_DENO`), additionally runs:
 *   4. regeneration drift: the committed bindings must be byte-identical to a
 *      fresh `capnpc-deno` run over `codegen.committedSchemas`;
 *   5. full-binding qualification: regenerates all five canonical schemas and
 *      typechecks the result, then requires the observed outcome to match
 *      `codegen.fullBindingStatus` ("blocked" means the typecheck MUST fail;
 *      if upstream fixes land, this gate fails until the real bindings are
 *      committed and the manifest is updated).
 *
 * Without the checkout, steps 4-5 are skipped loudly. Invoke via
 * `deno task wire:check`; regenerate bindings via `deno task wire:generate`.
 */

interface WireManifest {
  canonicalSchemas: string[];
  schemaSha256: string;
  capnpCompiler: string;
  codegen: {
    committedSchemas: string[];
    fullBindingStatus: string;
    toolchain: { checkout: string; commit: string };
  };
}

const root = new URL("../", import.meta.url);
const rootPath = decodeURIComponent(root.pathname);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("compat/wire.json", root)),
) as WireManifest;

// 1. Canonical schema bundle hash.
const canonicalSchemas = [...manifest.canonicalSchemas].sort();
const schemaChunks: Uint8Array[] = [];
for (const filename of canonicalSchemas) {
  schemaChunks.push(new TextEncoder().encode(`${filename}\0`));
  schemaChunks.push(await Deno.readFile(new URL(`schema/${filename}`, root)));
  schemaChunks.push(new Uint8Array([0]));
}
const schemaHash = toHex(
  await crypto.subtle.digest("SHA-256", concatenate(schemaChunks)),
);
if (schemaHash !== manifest.schemaSha256) {
  throw new Error(
    `canonical schema hash ${schemaHash} does not match ${manifest.schemaSha256}`,
  );
}

// 2. Pinned compiler + compile smoke. Skips loudly (never silently) when
// the `capnp` binary is absent from the environment; the hash and
// typecheck gates above/below still enforce. CI installs the pinned
// compiler so this leg runs there.
let capnpAvailable = true;
try {
  const version = await command("capnp", ["--version"]);
  if (version.stdout.trim() !== manifest.capnpCompiler) {
    throw new Error(
      `capnp compiler ${JSON.stringify(version.stdout.trim())} does not match ${
        JSON.stringify(manifest.capnpCompiler)
      }`,
    );
  }
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) throw err;
  capnpAvailable = false;
  console.warn(
    "warning: `capnp` binary not found — SKIPPING the compiler-pin and " +
      "compile-smoke gates (schema hash and bindings typecheck still enforced)",
  );
}
if (capnpAvailable) {
  await command(
    "capnp",
    [
      "compile",
      "-o-",
      ...canonicalSchemas.map((filename) => `${rootPath}schema/${filename}`),
    ],
    { discardStdout: true },
  );
}

// 3. Committed bindings must typecheck strict against the published runtime.
await command("deno", [
  "check",
  "--config",
  `${rootPath}deno.json`,
  `${rootPath}src/wire/generated/mod.ts`,
]);
console.log("committed generated bindings typecheck");

// 4-5. Toolchain-dependent checks.
const toolchainPath = Deno.env.get("STUDIOBOX_CAPNP_DENO") ??
  decodeURIComponent(
    new URL(manifest.codegen.toolchain.checkout, root).pathname,
  );
const toolchainMain = `${toolchainPath}/tools/capnpc-deno/main.ts`;
if (!(await exists(toolchainMain)) || !capnpAvailable) {
  console.warn(
    !capnpAvailable
      ? "warning: `capnp` binary missing; SKIPPING regeneration drift and " +
        "full-binding qualification (the codegen toolchain shells out to it)"
      : `warning: capnp-deno toolchain not found at ${toolchainPath}; ` +
        "SKIPPING regeneration drift and full-binding qualification " +
        "(set STUDIOBOX_CAPNP_DENO or clone the sibling checkout to run them)",
  );
} else {
  const commit = (await command("git", [
    "-C",
    toolchainPath,
    "rev-parse",
    "HEAD",
  ])).stdout.trim();
  if (commit !== manifest.codegen.toolchain.commit) {
    console.warn(
      `warning: toolchain checkout is at ${commit}, manifest records ` +
        `${manifest.codegen.toolchain.commit}; byte comparison still governs`,
    );
  }

  // 4. Regeneration drift over the committed schema set.
  const regenDir = await Deno.makeTempDir({ prefix: "studiobox_wire_regen_" });
  try {
    await runCapnpcDeno(
      toolchainMain,
      manifest.codegen.committedSchemas,
      regenDir,
    );
    const committedDir = `${rootPath}src/wire/generated`;
    const regenerated = await listTsFiles(regenDir);
    const committed = await listTsFiles(committedDir);
    if (regenerated.join(",") !== committed.join(",")) {
      throw new Error(
        `regenerated file set [${regenerated.join(", ")}] does not match ` +
          `committed src/wire/generated/ [${committed.join(", ")}]`,
      );
    }
    for (const name of committed) {
      const fresh = await Deno.readFile(`${regenDir}/${name}`);
      const existing = await Deno.readFile(`${committedDir}/${name}`);
      if (!bytesEqual(fresh, existing)) {
        throw new Error(
          `src/wire/generated/${name} drifted from toolchain output; ` +
            "run `deno task wire:generate` and commit the result",
        );
      }
    }
    console.log(
      `generated bindings reproduce byte-identically (toolchain ${commit})`,
    );
  } finally {
    await Deno.remove(regenDir, { recursive: true });
  }

  // 5. Full-binding qualification over the five canonical schemas.
  const fullDir = await Deno.makeTempDir({ prefix: "studiobox_wire_full_" });
  try {
    await runCapnpcDeno(toolchainMain, canonicalSchemas, fullDir);
    const check = await tryCommand("deno", [
      "check",
      "--config",
      `${rootPath}deno.json`,
      `${fullDir}/mod.ts`,
    ]);
    const observed = check.success ? "qualified" : "blocked";
    const recorded = manifest.codegen.fullBindingStatus;
    if (observed !== recorded) {
      throw new Error(
        `full five-schema bindings are observed "${observed}" but ` +
          `compat/wire.json records "${recorded}"` +
          (observed === "qualified"
            ? "; the upstream codegen blockers appear FIXED - commit the " +
              "full bindings and update the manifest"
            : `; typecheck failure follows:\n${check.stderr}`),
      );
    }
    if (recorded === "blocked") {
      console.warn(
        "warning: full five-schema bindings remain BLOCKED upstream " +
          "(cross-file lowering + barrel collisions, see compat/wire.json " +
          "codegen.blockers); committed bindings stay probe-only",
      );
    } else {
      console.log("full five-schema bindings typecheck");
    }
  } finally {
    await Deno.remove(fullDir, { recursive: true });
  }
}

console.log(`wire contract verified: ${schemaHash}`);

async function runCapnpcDeno(
  toolchainMain: string,
  schemas: string[],
  outDir: string,
): Promise<void> {
  await command("deno", [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-run=capnp",
    toolchainMain,
    "generate",
    ...schemas.flatMap((filename) => [
      "--schema",
      `${rootPath}schema/${filename}`,
    ]),
    "--out",
    outDir,
    "--layout",
    "flat",
    "--quiet",
  ]);
}

async function listTsFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".ts")) names.push(entry.name);
  }
  return names.sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function tryCommand(
  executable: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const output = await new Deno.Command(executable, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    cwd: rootPath,
  }).output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function command(
  executable: string,
  args: string[],
  options: { discardStdout?: boolean } = {},
): Promise<{ stdout: string }> {
  const output = await new Deno.Command(executable, {
    args,
    stdin: "null",
    stdout: options.discardStdout ? "null" : "piped",
    stderr: "piped",
    cwd: rootPath,
  }).output();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    throw new Error(`${executable} ${args[0] ?? ""} failed: ${stderr}`);
  }
  return {
    stdout: options.discardStdout
      ? ""
      : new TextDecoder().decode(output.stdout),
  };
}

function concatenate(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(buffer),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
