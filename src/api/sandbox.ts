import util from "node:util";

import type { BaseClientOptions } from "./client.ts";
import { SandboxCommandBuilder } from "./command.ts";
import type { Build, DeployOptions, SandboxDeno } from "./deno.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import type { SandboxEnv } from "./env.ts";
import type { SandboxFs } from "./fs.ts";
import type { Memory } from "./memory.ts";
import type { ChildProcess, ChildProcessStatus, Signal } from "./process.ts";
import { resolveSandboxProvider } from "./provider.ts";
import type {
  Region,
  SecretConfig,
  SnapshotId,
  SnapshotSlug,
  VolumeId,
  VolumeSlug,
} from "./types.ts";

/** Options for {@link Sandbox.create}, mirroring `@deno/sandbox`'s `SandboxOptions`. */
export interface SandboxOptions extends BaseClientOptions {
  /** Placement region. Tier B — recorded then ignored; metadata reports `"loc"`. */
  region?: Region;
  /** Override the sandbox endpoint, or derive it from the region. */
  sandboxEndpoint?: string | ((region: string) => string);
  /** Environment variables applied post-create via `env.set` (upstream behavior). */
  env?: Record<string, string>;
  /** Lifetime: `"session"`, or a `"<n>s"`/`"<n>m"` duration. */
  timeout?: "session" | `${number}s` | `${number}m`;
  /** Guest memory: bytes or a unit suffix, clamped to 768–4096 MiB. */
  memory?: Memory;
  /** Enable verbose SDK debug logging. */
  debug?: boolean;
  /** Up to 5 metadata labels (64 B key / 128 B value caps). */
  labels?: Record<string, string>;
  /** Boot from a volume or snapshot. Tier C — unsupported locally. */
  root?: VolumeId | VolumeSlug | SnapshotId | SnapshotSlug;
  /** Mount named persistent volumes. Tier C — unsupported locally. */
  volumes?: Record<string, VolumeId | VolumeSlug>;
  /** Egress allowlist. Tier B — enforced as nftables rules on the sandbox TAP. */
  allowNet?: string[];
  /** Injected secrets. Tier C — unsupported locally. */
  secrets?: Record<string, SecretConfig>;
  /** Request SSH ingress. Tier C — unsupported locally. */
  ssh?: boolean;
  /** Cloud-specific create port. Tier C — no local equivalent. */
  port?: number;
}

/** Options for {@link Sandbox.connect}. */
export interface ConnectOptions extends BaseClientOptions {
  /** Override the sandbox endpoint, or derive it from the region. */
  sandboxEndpoint?: string | ((region: string) => string);
  /** Enable verbose SDK debug logging. */
  debug?: boolean;
}

/** Options for {@link Sandbox.spawn}, mirroring Deno's `Command` options. */
export interface SpawnOptions {
  /** Arguments passed to the command. */
  args?: string[];
  /** Working directory for the command. */
  cwd?: string | URL;
  /** Start from an empty environment instead of inheriting the sandbox's. */
  clearEnv?: boolean;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /** Abort signal that kills the process. */
  signal?: AbortSignal;
  /** Stdin disposition (default `"null"`). */
  stdin?: "piped" | "null";
  /** Stdout disposition (default `"inherit"`). */
  stdout?: "piped" | "inherit" | "null";
  /** Stderr disposition (default `"inherit"`). */
  stderr?: "piped" | "inherit" | "null";
}

/** Request options for {@link Sandbox.fetch}, a subset of the WHATWG `RequestInit`. */
export interface RequestInit {
  /** HTTP method. */
  method?: string;
  /** Request headers. */
  headers?: HeadersInit;
  /** Request body. */
  body?: BodyInit;
  /** Redirect handling mode. */
  redirect?: "follow" | "manual";
  /** Abort signal for the request. */
  signal?: AbortSignal | null;
}

/** Options for {@link Sandbox.exposeVscode}. Tier C — unsupported locally. */
export interface VsCodeOptions {
  /** Environment variables for the VS Code server. */
  env?: Record<string, string>;
  /** Extensions to install. */
  extensions?: string[];
  /** Path or URL to open in a preview pane. */
  preview?: string;
  /** Hide the stop button in the editor UI. */
  disableStopButton?: boolean;
  /** Editor settings overrides. */
  editorSettings?: Record<string, unknown>;
}

/** Public sandbox contract; concrete instances are supplied by the RPC runtime. */
export abstract class Sandbox implements AsyncDisposable {
  /** Boot a new microVM sandbox and return its façade. */
  static create(options?: SandboxOptions): Promise<Sandbox> {
    return resolveSandboxProvider().then((provider) =>
      provider.create(options)
    );
  }

  /** Re-attach to a running sandbox by id. */
  static connect(id: string, options?: ConnectOptions): Promise<Sandbox>;
  /** Re-attach to a running sandbox given options carrying its `id`. */
  static connect(options: ConnectOptions & { id: string }): Promise<Sandbox>;
  static connect(
    idOrOptions: string | (ConnectOptions & { id: string }),
    options?: ConnectOptions,
  ): Promise<Sandbox> {
    return resolveSandboxProvider().then((provider) =>
      typeof idOrOptions === "string"
        ? provider.connect(idOrOptions, options)
        : provider.connect(idOrOptions.id, idOrOptions)
    );
  }

  /** Template tag that builds a `bash -c` command via {@link SandboxCommandBuilder}. */
  sh = (
    templateStrings: TemplateStringsArray,
    ...substitutions: unknown[]
  ): SandboxCommandBuilder =>
    new SandboxCommandBuilder(this, templateStrings, substitutions);

  /** The sandbox id (`sbx_loc_…`), stable for {@link connect}. */
  abstract get id(): string;
  /** Resolves when the sandbox connection is torn down. */
  abstract get closed(): Promise<void>;
  /** The filesystem surface. */
  abstract get fs(): SandboxFs;
  /** The Deno code-execution surface. */
  abstract get deno(): SandboxDeno;
  /** The environment-variable surface. */
  abstract get env(): SandboxEnv;
  /** SSH connection details, or `undefined`. Tier C — unset locally. */
  abstract get ssh(): { username: string; hostname: string } | undefined;
  /** Public URL for the sandbox, or `undefined` when none is exposed. */
  abstract get url(): string | undefined;

  /** Spawn a command inside the sandbox and return its {@link ChildProcess}. */
  abstract spawn(
    command: string | URL,
    options?: SpawnOptions,
  ): Promise<ChildProcess>;
  /** Issue an HTTP request through the sandbox's egress (subject to `allowNet`). */
  abstract fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  /** Drop the connection; a `"session"` sandbox then terminates. */
  abstract close(): Promise<void>;
  /** Authoritatively terminate the sandbox. */
  abstract kill(): Promise<void>;
  /** Extend the lifetime (≤ 30 min/call); returns the new deadline. */
  abstract extendTimeout(timeout: `${number}s` | `${number}m`): Promise<Date>;
  /** Expose a port/pid. Tier B — returns a host-loopback `http://127.0.0.1:…` URL. */
  abstract exposeHttp(
    target: { port: number } | { pid: number },
  ): Promise<string>;
  /** Expose SSH access. Tier C — throws `UnsupportedFeatureError` locally. */
  abstract exposeSsh(): Promise<{ hostname: string; username: string }>;
  /** Expose a VS Code server. Tier C — throws `UnsupportedFeatureError` locally. */
  abstract exposeVscode(
    path?: string,
    options?: VsCodeOptions,
  ): Promise<VsCode>;

  /** Deploy an app. Tier C — always rejects with `UnsupportedFeatureError`. */
  deploy(_app: string, _options: DeployOptions = {}): Promise<Build> {
    return Promise.reject(new UnsupportedFeatureError("sandbox.deploy"));
  }

  /** Node `util.inspect` hook rendering a compact `Sandbox { … }` summary. */
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

  /** Dispose semantics: equivalent to {@link close}. */
  abstract [Symbol.asyncDispose](): Promise<void>;
}

/** Handle to a running VS Code server (from {@link Sandbox.exposeVscode}). Tier C locally. */
export abstract class VsCode implements AsyncDisposable {
  /** URL of the VS Code server. */
  abstract get url(): string;
  /** Readable stdout stream of the server process. */
  abstract get stdout(): ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Readable stderr stream of the server process. */
  abstract get stderr(): ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Resolves with the server process's exit {@link ChildProcessStatus}. */
  abstract get status(): Promise<ChildProcessStatus>;
  /** Send `signal` (default `SIGTERM`) to the server process. */
  abstract kill(signal?: Signal): Promise<void>;
  /** Dispose semantics: kill the server process. */
  abstract [Symbol.asyncDispose](): Promise<void>;

  /** Node `util.inspect` hook rendering a compact `VsCode { … }` summary. */
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
