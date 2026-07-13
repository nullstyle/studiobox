import { ProviderNotInstalledError } from "./errors.ts";
import type { ConnectOptions, Sandbox, SandboxOptions } from "./sandbox.ts";
import type { SandboxesListOptions, SandboxMetadata } from "./types.ts";

/** Internal seam implemented by the host/RPC layer. */
export interface SandboxProvider {
  create(options?: SandboxOptions): Promise<Sandbox>;
  connect(id: string, options?: ConnectOptions): Promise<Sandbox>;
  list(options?: SandboxesListOptions): Promise<SandboxMetadata[]>;
}

let activeProvider: SandboxProvider | undefined;
let defaultLoader: (() => Promise<SandboxProvider>) | undefined;
/** Memoized in-flight/settled build of the default provider (cleared on failure). */
let defaultBuild: Promise<SandboxProvider> | undefined;

/** Install the process-wide provider and return a function that restores the prior one. */
export function installSandboxProvider(provider: SandboxProvider): () => void {
  const previous = activeProvider;
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) activeProvider = previous;
  };
}

/**
 * Register a lazy fallback used by {@linkcode resolveSandboxProvider} when no
 * provider was installed explicitly. The main entry (`@nullstyle/studiobox`)
 * registers one that builds a `StudioboxProvider` from the environment, so
 * `Sandbox.create()` connects automatically once a host is up — WITHOUT
 * statically importing the host-dialing graph into the client barrel (the
 * loader `dynamic-import`s it only when it actually fires).
 *
 * An explicitly installed provider always wins: this fallback is consulted only
 * while `activeProvider` is unset, so a test's `FakeSandboxHost` or an
 * `installStudiobox()` is never clobbered. Returns a function that restores the
 * previously-registered loader (used by tests).
 */
export function registerDefaultSandboxProvider(
  loader: () => Promise<SandboxProvider>,
): () => void {
  const previous = defaultLoader;
  defaultLoader = loader;
  defaultBuild = undefined;
  return () => {
    if (defaultLoader === loader) {
      defaultLoader = previous;
      defaultBuild = undefined;
    }
  };
}

/**
 * The explicitly installed provider, or throw {@linkcode
 * ProviderNotInstalledError}. Synchronous; does NOT consult the lazy default —
 * use {@linkcode resolveSandboxProvider} for the auto-wiring `create`/`connect`
 * path.
 */
export function getSandboxProvider(): SandboxProvider {
  if (!activeProvider) throw new ProviderNotInstalledError();
  return activeProvider;
}

/**
 * Resolve the provider backing a `create`/`connect`/`list` call: the explicitly
 * installed one if present, else the lazily-built default (env-wired), else
 * throw {@linkcode ProviderNotInstalledError}. The default build is memoized
 * once (so repeated creates reuse one provider/connection) but a failed build
 * is not cached, so a later call retries once the environment is set.
 */
export function resolveSandboxProvider(): Promise<SandboxProvider> {
  if (activeProvider) return Promise.resolve(activeProvider);
  if (defaultLoader) {
    if (!defaultBuild) {
      const build: Promise<SandboxProvider> = defaultLoader().catch(
        (error: unknown) => {
          if (defaultBuild === build) defaultBuild = undefined;
          throw error;
        },
      );
      defaultBuild = build;
    }
    return defaultBuild;
  }
  return Promise.reject(new ProviderNotInstalledError());
}
