import { ImplementationPendingError } from "./errors.ts";
import type { ConnectOptions, Sandbox, SandboxOptions } from "./sandbox.ts";
import type { SandboxesListOptions, SandboxMetadata } from "./types.ts";

/** Internal seam implemented by the host/RPC layer. */
export interface SandboxProvider {
  create(options?: SandboxOptions): Promise<Sandbox>;
  connect(id: string, options?: ConnectOptions): Promise<Sandbox>;
  list(options?: SandboxesListOptions): Promise<SandboxMetadata[]>;
}

let activeProvider: SandboxProvider | undefined;

/** Install the process-wide provider and return a function that restores the prior one. */
export function installSandboxProvider(provider: SandboxProvider): () => void {
  const previous = activeProvider;
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) activeProvider = previous;
  };
}

export function getSandboxProvider(): SandboxProvider {
  if (!activeProvider) throw new ImplementationPendingError("Sandbox");
  return activeProvider;
}
