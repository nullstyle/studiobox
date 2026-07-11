import util from "node:util";

import type { BaseClientOptions } from "./client.ts";
import { SandboxCommandBuilder } from "./command.ts";
import type { Build, DeployOptions, SandboxDeno } from "./deno.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import type { SandboxEnv } from "./env.ts";
import type { SandboxFs } from "./fs.ts";
import type { Memory } from "./memory.ts";
import type { ChildProcess, ChildProcessStatus, Signal } from "./process.ts";
import { getSandboxProvider } from "./provider.ts";
import type {
  Region,
  SecretConfig,
  SnapshotId,
  SnapshotSlug,
  VolumeId,
  VolumeSlug,
} from "./types.ts";

export interface SandboxOptions extends BaseClientOptions {
  region?: Region;
  sandboxEndpoint?: string | ((region: string) => string);
  env?: Record<string, string>;
  timeout?: "session" | `${number}s` | `${number}m`;
  memory?: Memory;
  debug?: boolean;
  labels?: Record<string, string>;
  root?: VolumeId | VolumeSlug | SnapshotId | SnapshotSlug;
  volumes?: Record<string, VolumeId | VolumeSlug>;
  allowNet?: string[];
  secrets?: Record<string, SecretConfig>;
  ssh?: boolean;
  port?: number;
}

export interface ConnectOptions extends BaseClientOptions {
  sandboxEndpoint?: string | ((region: string) => string);
  debug?: boolean;
}

export interface SpawnOptions {
  args?: string[];
  cwd?: string | URL;
  clearEnv?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stdin?: "piped" | "null";
  stdout?: "piped" | "inherit" | "null";
  stderr?: "piped" | "inherit" | "null";
}

export interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  redirect?: "follow" | "manual";
  signal?: AbortSignal | null;
}

export interface VsCodeOptions {
  env?: Record<string, string>;
  extensions?: string[];
  preview?: string;
  disableStopButton?: boolean;
  editorSettings?: Record<string, unknown>;
}

/** Public sandbox contract; concrete instances are supplied by the RPC runtime. */
export abstract class Sandbox implements AsyncDisposable {
  static create(options?: SandboxOptions): Promise<Sandbox> {
    return getSandboxProvider().create(options);
  }

  static connect(id: string, options?: ConnectOptions): Promise<Sandbox>;
  static connect(options: ConnectOptions & { id: string }): Promise<Sandbox>;
  static connect(
    idOrOptions: string | (ConnectOptions & { id: string }),
    options?: ConnectOptions,
  ): Promise<Sandbox> {
    return typeof idOrOptions === "string"
      ? getSandboxProvider().connect(idOrOptions, options)
      : getSandboxProvider().connect(idOrOptions.id, idOrOptions);
  }

  sh = (
    templateStrings: TemplateStringsArray,
    ...substitutions: unknown[]
  ): SandboxCommandBuilder =>
    new SandboxCommandBuilder(this, templateStrings, substitutions);

  abstract get id(): string;
  abstract get closed(): Promise<void>;
  abstract get fs(): SandboxFs;
  abstract get deno(): SandboxDeno;
  abstract get env(): SandboxEnv;
  abstract get ssh(): { username: string; hostname: string } | undefined;
  abstract get url(): string | undefined;

  abstract spawn(
    command: string | URL,
    options?: SpawnOptions,
  ): Promise<ChildProcess>;
  abstract fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  abstract close(): Promise<void>;
  abstract kill(): Promise<void>;
  abstract extendTimeout(timeout: `${number}s` | `${number}m`): Promise<Date>;
  abstract exposeHttp(
    target: { port: number } | { pid: number },
  ): Promise<string>;
  abstract exposeSsh(): Promise<{ hostname: string; username: string }>;
  abstract exposeVscode(
    path?: string,
    options?: VsCodeOptions,
  ): Promise<VsCode>;

  deploy(_app: string, _options: DeployOptions = {}): Promise<Build> {
    return Promise.reject(new UnsupportedFeatureError("sandbox.deploy"));
  }

  [util.inspect.custom](
    depth: number,
    options: util.InspectOptionsStylized,
  ): string {
    if (depth < 0) return options.stylize("[Sandbox]", "special");
    const next = options.depth === null ? null : depth - 1;
    const params: Record<string, unknown> = { id: this.id };
    if (this.ssh) params.ssh = this.ssh;
    if (this.url) params.url = this.url;
    return `Sandbox ${util.inspect(params, { ...options, depth: next })}`;
  }

  abstract [Symbol.asyncDispose](): Promise<void>;
}

export abstract class VsCode implements AsyncDisposable {
  abstract get url(): string;
  abstract get stdout(): ReadableStream<Uint8Array<ArrayBuffer>>;
  abstract get stderr(): ReadableStream<Uint8Array<ArrayBuffer>>;
  abstract get status(): Promise<ChildProcessStatus>;
  abstract kill(signal?: Signal): Promise<void>;
  abstract [Symbol.asyncDispose](): Promise<void>;

  [util.inspect.custom](
    depth: number,
    options: util.InspectOptionsStylized,
  ): string {
    if (depth < 0) return options.stylize("[VsCode]", "special");
    const next = options.depth === null ? null : depth - 1;
    return `VsCode ${
      util.inspect({ url: this.url }, { ...options, depth: next })
    }`;
  }
}
