import { ChildProcess } from "./process.ts";
import type { RequestInit, SpawnOptions } from "./sandbox.ts";
import type { BuildLog, Revision } from "./types.ts";

export type CodeExtension =
  | "js"
  | "cjs"
  | "mjs"
  | "ts"
  | "cts"
  | "mts"
  | "jsx"
  | "tsx";

export type DenoRunOptions =
  & (
    | { entrypoint: string | URL; watch?: boolean | string[] }
    | { code: string; extension?: CodeExtension }
  )
  & { scriptArgs?: string[] }
  & Omit<SpawnOptions, "args">;

export type DenoReplOptions =
  & { scriptArgs?: string[] }
  & Omit<SpawnOptions, "args">;

export abstract class DenoProcess extends ChildProcess {
  abstract get httpReady(): Promise<boolean>;
  abstract fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

export abstract class DenoRepl extends DenoProcess {
  abstract eval<T = unknown>(code: string): Promise<T>;
  abstract call<T = unknown>(fn: string, ...args: unknown[]): Promise<T>;
  abstract close(): Promise<void>;
}

export interface SandboxDeno {
  run(options: DenoRunOptions): Promise<DenoProcess>;
  eval<T = unknown>(code: string): Promise<T>;
  repl(options?: DenoReplOptions): Promise<DenoRepl>;
  deploy(app: string, options?: DeployOptions): Promise<Build>;
}

export interface Build {
  id: string;
  done: Promise<Revision>;
  logs(): AsyncIterable<BuildLog>;
}

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

export interface DeployOptions {
  path?: string;
  production?: boolean;
  preview?: boolean;
  build?: BuildOptions;
}
