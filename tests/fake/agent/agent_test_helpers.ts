/**
 * Shared scaffolding for the fake-tier agent tests: a per-test sandbox
 * root (temp dir with `/home/app` and `/tmp`), an `AgentEnv` seeded with
 * a minimal PATH/HOME (children are spawned with the host environment
 * cleared, so the base layer must carry what the tools need), and the
 * Track A implementations wired together.
 */

import type {
  AgentOomAnnotator,
  AgentRootConfig,
} from "../../../src/agent/api.ts";
import { AgentDeno } from "../../../src/agent/deno_runtime.ts";
import { AgentEnv } from "../../../src/agent/env.ts";
import { AgentProcesses } from "../../../src/agent/processes.ts";

export interface TestAgent extends AsyncDisposable {
  readonly config: AgentRootConfig;
  /** Host path of the sandbox root (as created). */
  readonly root: string;
  /** Symlink-resolved host path of the sandbox root. */
  readonly realRoot: string;
  readonly env: AgentEnv;
  readonly processes: AgentProcesses;
  readonly deno: AgentDeno;
}

export interface TestAgentOptions {
  readonly oomAnnotator?: AgentOomAnnotator;
  readonly seedEnv?: Readonly<Record<string, string>>;
}

export async function makeTestAgent(
  options: TestAgentOptions = {},
): Promise<TestAgent> {
  const root = await Deno.makeTempDir({ prefix: "sbx-agent-" });
  await Deno.mkdir(`${root}/home/app`, { recursive: true });
  await Deno.mkdir(`${root}/tmp`, { recursive: true });
  const realRoot = await Deno.realPath(root);
  const config: AgentRootConfig = { root };
  const env = new AgentEnv({
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: `${realRoot}/home/app`,
    ...options.seedEnv,
  });
  const processes = new AgentProcesses({
    config,
    env,
    oomAnnotator: options.oomAnnotator,
  });
  const deno = new AgentDeno({ config, spawner: processes });
  return {
    config,
    root,
    realRoot,
    env,
    processes,
    deno,
    async [Symbol.asyncDispose]() {
      await processes.shutdown();
      await Deno.remove(root, { recursive: true });
    },
  };
}

export function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}
