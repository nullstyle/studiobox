import { ChildProcess } from "./process.ts";
import type { RequestInit, SpawnOptions } from "./sandbox.ts";
import type { BuildLog, Revision } from "./types.ts";

/** Source file extension accepted for inline `deno.run({ code })` snippets. */
export type CodeExtension =
  | "js"
  | "cjs"
  | "mjs"
  | "ts"
  | "cts"
  | "mts"
  | "jsx"
  | "tsx";

/** Options for {@link SandboxDeno.run}: either an entrypoint file or inline code, plus spawn options. */
export type DenoRunOptions =
  & (
    | { entrypoint: string | URL; watch?: boolean | string[] }
    | { code: string; extension?: CodeExtension }
  )
  & { scriptArgs?: string[] }
  & Omit<SpawnOptions, "args">;

/** Options for {@link SandboxDeno.repl}: script args plus spawn options. */
export type DenoReplOptions =
  & { scriptArgs?: string[] }
  & Omit<SpawnOptions, "args">;

/** A `deno` child process (Tier A); adds in-runtime HTTP access to {@link ChildProcess}. */
export abstract class DenoProcess extends ChildProcess {
  /** Resolves once the runtime's HTTP server (first `Deno.serve`) is listening. */
  abstract get httpReady(): Promise<boolean>;
  /** Fetch `url` against the process's in-runtime HTTP server. */
  abstract fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

/** A persistent Deno REPL (Tier A); state is preserved across snippets. */
export abstract class DenoRepl extends DenoProcess {
  /** Evaluate `code` in the REPL and return its structured-clone result. */
  abstract eval<T = unknown>(code: string): Promise<T>;
  /** Call the named function `fn` with `args` and return its result. */
  abstract call<T = unknown>(fn: string, ...args: unknown[]): Promise<T>;
  /** Shut down the REPL process. */
  abstract close(): Promise<void>;
}

/** The `sandbox.deno` surface for running code inside the sandbox (Tier A, except `deploy`). */
export interface SandboxDeno {
  /** Run an entrypoint or inline code as a {@link DenoProcess}. */
  run(options: DenoRunOptions): Promise<DenoProcess>;
  /** Evaluate `code` once and return its structured-clone result. */
  eval<T = unknown>(code: string): Promise<T>;
  /** Start a persistent {@link DenoRepl}. */
  repl(options?: DenoReplOptions): Promise<DenoRepl>;
  /** Deploy an app. Tier C — throws `UnsupportedFeatureError` locally. */
  deploy(app: string, options?: DeployOptions): Promise<Build>;
}

/** Handle to a Deploy build. Tier C — the Deploy PaaS surface is unsupported locally. */
export interface Build {
  /** Build identifier. */
  id: string;
  /** Resolves with the produced revision when the build completes. */
  done: Promise<Revision>;
  /** Stream the build's log lines. */
  logs(): AsyncIterable<BuildLog>;
}

/** Build configuration for {@link DeployOptions}. Tier C — Deploy PaaS only. */
export type BuildOptions =
  & {
    entrypoint?: string;
    args?: string[];
  }
  & (
    | { mode?: "none" }
    | {
      mode?: "local";
      frameworkPreset?:
        | ""
        | "astro"
        | "fresh"
        | "lume"
        | "nextjs"
        | "nuxt"
        | "remix"
        | "solidstart"
        | "sveltekit"
        | "tanstackstart";
      installCommand?: string;
      buildCommand?: string;
      buildDirectory?: string;
    }
  );

/** Options for {@link SandboxDeno.deploy}. Tier C — Deploy PaaS only. */
export interface DeployOptions {
  /** Path to the app directory to deploy. */
  path?: string;
  /** Deploy to the production environment. */
  production?: boolean;
  /** Deploy as a preview instead of production. */
  preview?: boolean;
  /** Build settings for the deployment. */
  build?: BuildOptions;
}
