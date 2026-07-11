/** Reproducibility gate for canonical schemas and generated probe bindings. */

interface WireManifest {
  canonicalSchemas: string[];
  schemaSha256: string;
  capnpCompiler: string;
  codegen: { probeSchema: string };
}

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("compat/wire.json", root)),
) as WireManifest;

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

const version = await command("capnp", ["--version"]);
if (version.stdout.trim() !== manifest.capnpCompiler) {
  throw new Error(
    `capnp compiler ${JSON.stringify(version.stdout.trim())} does not match ${
      JSON.stringify(manifest.capnpCompiler)
    }`,
  );
}

await command(
  "capnp",
  [
    "compile",
    "-o-",
    ...canonicalSchemas.map((filename) =>
      decodeURIComponent(new URL(`schema/${filename}`, root).pathname)
    ),
  ],
  { discardStdout: true },
);

// M1 TODO(capnp-codegen gate): the limabox version of this gate regenerated
// `codegen.probeSchema` with the vendored `capnp-deno` toolchain
// (`vendor/capnp-deno/tools/capnpc-deno/main.ts`) and byte-compared the output
// against the committed `src/wire/generated/` bindings, then type-checked
// `src/wire/generated/mod.ts`. The published `jsr:@nullstyle/capnp@^0.1` does
// not ship the `capnpc-deno` CLI (its publish allowlist is `src/**` plus the
// WASM asset), so probe regeneration cannot point at the published package.
// Studiobox regenerates `src/wire/generated/` during the M1 capnp-codegen
// gate; until then this tool verifies only the canonical schema bundle and the
// pinned compiler, and it is deliberately NOT wired into the `check` task.
console.warn(
  "warning: generated-binding reproduction is deferred to the M1 capnp-codegen gate",
);

console.log(`wire contract verified: ${schemaHash}`);

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
