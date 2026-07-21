/** Fail-closed guard for the package publication dry run. */

interface PublishConfig {
  name: string;
  version: string;
  exports: Record<string, string>;
  imports: Record<string, string>;
  publish?: { include?: string[] };
}

interface PublishDependency {
  package: string;
  version: string;
  releaseSpecifier: string | null;
}

interface PublishManifest {
  lima: PublishDependency;
  capnp: PublishDependency;
  firecracker: PublishDependency;
}

const REQUIRED_FILES = [
  "mod.ts",
  "src/**",
  "schema/**",
  "compat/**",
  "README.md",
  "LICENSE",
  "deno.json",
] as const;

export function publishReadinessFailures(
  config: PublishConfig,
  manifest: PublishManifest,
): string[] {
  const failures: string[] = [];
  if (config.name !== "@nullstyle/studiobox") {
    failures.push(`unexpected package identity ${config.name}`);
  }
  if (config.version === "0.0.0") {
    failures.push("package version is still 0.0.0");
  }
  if (config.exports["."] !== "./mod.ts") {
    failures.push("root export must resolve to ./mod.ts");
  }

  const included = new Set(config.publish?.include ?? []);
  for (const required of REQUIRED_FILES) {
    if (!included.has(required)) {
      failures.push(`publish allowlist is missing ${required}`);
    }
  }

  for (
    const dependency of [manifest.lima, manifest.capnp, manifest.firecracker]
  ) {
    const release = dependency.releaseSpecifier;
    if (release === null || !release.startsWith(`jsr:${dependency.package}@`)) {
      failures.push(
        `${dependency.package} release must be a published jsr specifier`,
      );
      continue;
    }
    if (!versionInWindow(dependency.version, rangeWindow(release))) {
      failures.push(
        `${dependency.package} release must be a window admitting the qualified version ${dependency.version}`,
      );
    }
    if (!(dependency.package in config.imports)) {
      failures.push(`${dependency.package} is missing from the import map`);
    }
    for (const [name, specifier] of Object.entries(config.imports)) {
      if (
        name !== dependency.package &&
        !name.startsWith(`${dependency.package}/`)
      ) {
        continue;
      }
      const suffix = name.slice(dependency.package.length);
      if (specifier !== `${release}${suffix}`) {
        failures.push(`${name} must resolve to ${release}${suffix}`);
      }
    }
  }

  for (const [name, specifier] of Object.entries(config.imports)) {
    if (
      specifier.startsWith("./vendor/") ||
      specifier.startsWith("https://") ||
      specifier.startsWith("http://")
    ) {
      failures.push(`${name} uses a development-only source specifier`);
    }
  }
  return failures;
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

if (import.meta.main) {
  const root = new URL("../", import.meta.url);
  const config = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  ) as PublishConfig;
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("compat/dependencies.json", root)),
  ) as PublishManifest;
  const failures = publishReadinessFailures(config, manifest);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`release blocker: ${failure}`);
    }
    Deno.exit(1);
  }
  console.log("publish dependency guard verified");
}
