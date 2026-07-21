/** Verify that the dependency pins match the committed compatibility manifest.
 *
 * Default mode needs only `--allow-read` and checks the import map, the
 * lockfile resolutions, and the runtime floor against
 * `compat/dependencies.json`. `--local` additionally inspects the sibling
 * development checkouts (needs `--allow-run=git`); `--release` enforces the
 * publication posture.
 */

interface DependencyPin {
  package: string;
  version: string;
  releaseSpecifier: string | null;
  localPath: string;
}

interface CompatibilityManifest {
  deno: { development: string; minimum: string };
  lima: DependencyPin & { limactlMinimum: string };
  capnp: DependencyPin & { wasmAbi: number };
  firecracker: DependencyPin & {
    firecrackerPinned: string;
    firecrackerMinimum: string;
  };
}

const checkLocal = Deno.args.includes("--local");
const checkRelease = Deno.args.includes("--release");
if (checkLocal && checkRelease) {
  throw new TypeError("--local and --release are mutually exclusive");
}
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("compat/dependencies.json", root)),
) as CompatibilityManifest;
const denoConfig = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", root)),
) as { version: string; imports: Record<string, string> };

const failures: string[] = [];

if (compareVersions(Deno.version.deno, manifest.deno.minimum) < 0) {
  failures.push(
    `Deno ${Deno.version.deno} is below the manifest minimum ${manifest.deno.minimum}`,
  );
}

for (const pin of [manifest.lima, manifest.capnp, manifest.firecracker]) {
  const release = pin.releaseSpecifier;
  if (release === null || !release.startsWith(`jsr:${pin.package}@`)) {
    failures.push(
      `${pin.package}: manifest release specifier is not a jsr pin`,
    );
    continue;
  }
  const window = rangeWindow(release);
  if (!versionInWindow(pin.version, window)) {
    failures.push(
      `${pin.package}: qualified version ${pin.version} is outside ${release}`,
    );
  }
  if (denoConfig.imports[pin.package] !== release) {
    failures.push(
      `${pin.package}: deno.json import does not match manifest release specifier ${release}`,
    );
  }
  for (const [name, specifier] of Object.entries(denoConfig.imports)) {
    if (!name.startsWith(`${pin.package}/`)) continue;
    const suffix = name.slice(pin.package.length);
    if (specifier !== `${release}${suffix}`) {
      failures.push(`${name}: import must resolve to ${release}${suffix}`);
    }
  }
}

for (const [name, specifier] of Object.entries(denoConfig.imports)) {
  if (
    specifier.startsWith("./vendor/") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("http://")
  ) {
    failures.push(`${name}: development-only source specifier ${specifier}`);
  }
}

const lock = await readLock();
if (lock !== null) {
  for (const pin of [manifest.lima, manifest.capnp, manifest.firecracker]) {
    const release = pin.releaseSpecifier;
    if (release === null) continue;
    const window = rangeWindow(release);
    for (const [specifier, resolved] of Object.entries(lock)) {
      if (!specifier.startsWith(`jsr:${pin.package}@`)) continue;
      if (!versionInWindow(resolved, window)) {
        failures.push(
          `${pin.package}: locked resolution ${resolved} is outside ${release}`,
        );
      } else if (compareVersions(resolved, pin.version) < 0) {
        failures.push(
          `${pin.package}: locked resolution ${resolved} predates the qualified version ${pin.version}`,
        );
      }
    }
  }
}

if (checkLocal) {
  for (const pin of [manifest.lima, manifest.capnp, manifest.firecracker]) {
    await inspectLocalCheckout(pin);
  }
}

if (checkRelease) {
  if (denoConfig.version === "0.0.0") {
    failures.push("package version is still the 0.0.0 development placeholder");
  }
  const rootPath = decodeURIComponent(root.pathname);
  try {
    await git(rootPath, ["rev-parse", "--verify", "HEAD"]);
    if ((await git(rootPath, ["status", "--short"])).length > 0) {
      failures.push("release checkout has uncommitted or untracked files");
    }
  } catch (error) {
    failures.push(`release checkout has no verifiable commit: ${error}`);
  }
}

if (failures.length > 0) {
  failures.forEach((failure) => console.error(`error: ${failure}`));
  Deno.exit(1);
}
console.log("compatibility manifest verified");

async function readLock(): Promise<Record<string, string> | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(new URL("deno.lock", root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const lock = JSON.parse(text) as { specifiers?: Record<string, string> };
  return lock.specifiers ?? {};
}

/** Extract the version window from a `jsr:@scope/name@range` specifier. */
function rangeWindow(specifier: string): string {
  const range = specifier.slice(specifier.lastIndexOf("@") + 1);
  return range.startsWith("^") ? range.slice(1) : range;
}

/** True when `version` sits inside the `major.minor[.patch]` window prefix. */
function versionInWindow(version: string, window: string): boolean {
  return version === window || version.startsWith(`${window}.`);
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function inspectLocalCheckout(pin: DependencyPin): Promise<void> {
  const checkout = new URL(`${pin.localPath}/`, root);
  const path = decodeURIComponent(checkout.pathname);
  try {
    await Deno.stat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    console.warn(
      `warning: ${pin.package}: local checkout ${pin.localPath} is unavailable`,
    );
    return;
  }

  const packageConfig = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", checkout)),
  ) as { name: string; version: string };
  if (
    packageConfig.name !== pin.package || packageConfig.version !== pin.version
  ) {
    console.warn(
      `warning: ${pin.package}: manifest version ${pin.version}, local override has ${packageConfig.name}@${packageConfig.version}`,
    );
  }
  if ((await git(path, ["status", "--short"])).length > 0) {
    console.warn(`warning: ${pin.package}: local checkout is dirty`);
  }

  if (pin.package === manifest.firecracker.package) {
    const compatSource = await Deno.readTextFile(
      new URL("src/compat.ts", checkout),
    );
    for (
      const expected of [
        `pinned: "${manifest.firecracker.firecrackerPinned}"`,
        `min: "${manifest.firecracker.firecrackerMinimum}"`,
      ]
    ) {
      if (!compatSource.includes(expected)) {
        console.warn(
          `warning: ${pin.package}: local compatibility source lacks ${expected}`,
        );
      }
    }
  }
}

async function git(path: string, args: string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args: ["-C", path, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr).trim());
  }
  return new TextDecoder().decode(output.stdout).trim();
}
