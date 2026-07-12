/**
 * `@nullstyle/studiobox/sdk` — install the real {@linkcode StudioboxProvider}
 * behind the `Sandbox.create`/`connect` seam so that
 * `import { Sandbox } from "@nullstyle/studiobox"` drives live Firecracker
 * microVMs over a hostd control plane + ticketed tunnel.
 *
 * ## Precedence (does NOT fight FakeSandboxHost)
 *
 * The provider seam is last-writer-wins: whoever calls
 * {@linkcode installSandboxProvider} most recently owns `Sandbox.create`.
 * This module NEVER auto-installs on import — a test that installs
 * `FakeSandboxHost` keeps it. You opt in explicitly:
 *
 * ```ts
 * import { installStudiobox } from "@nullstyle/studiobox/sdk";
 * import { Sandbox } from "@nullstyle/studiobox";
 *
 * using _provider = installStudiobox(); // reads STUDIOBOX_HOST/TUNNEL/TOKEN
 * await using sandbox = await Sandbox.create();
 * ```
 *
 * `installStudiobox` returns a `Disposable` whose `[Symbol.dispose]`
 * restores the previously-installed provider — so an explicitly-installed
 * fake, or a later `installStudiobox`, always wins by construction.
 *
 * @module
 */

import { installSandboxProvider } from "../api/provider.ts";
import {
  StudioboxProvider,
  type StudioboxProviderOptions,
} from "./provider.ts";

export {
  StudioboxProvider,
  type StudioboxProviderOptions,
} from "./provider.ts";
export { AgentBackedSandbox, type SandboxLifecycle } from "./sandbox.ts";
export type { SandboxBackend } from "./wire_agent.ts";
export { resolveWireBackend } from "./wire_agent.ts";

/** A provider installation handle; disposing restores the prior provider. */
export interface StudioboxInstallation extends Disposable {
  readonly provider: StudioboxProvider;
  /** Restore the previously-installed provider (idempotent). */
  uninstall(): void;
}

/**
 * Install a {@linkcode StudioboxProvider} as the process-wide sandbox
 * provider. With no argument the endpoints/token come from the environment
 * (`STUDIOBOX_HOST`, `STUDIOBOX_TUNNEL`, `STUDIOBOX_TOKEN`); pass options to
 * configure them explicitly (e.g. an in-process test stack).
 */
export function installStudiobox(
  options?: StudioboxProviderOptions,
): StudioboxInstallation {
  const provider = options === undefined
    ? StudioboxProvider.fromEnv()
    : new StudioboxProvider(options);
  let restore: (() => void) | undefined = installSandboxProvider(provider);
  const uninstall = (): void => {
    restore?.();
    restore = undefined;
  };
  return {
    provider,
    uninstall,
    [Symbol.dispose]: uninstall,
  };
}
