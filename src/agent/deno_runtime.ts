/**
 * `AgentDenoRuntime` implementation (Track A of the M3 agent plane):
 * `run` spawns the pinned deno binary; `eval`/`openRepl` drive a small
 * child "repl server" process that preserves state across snippets and
 * marshals structured-clone-ish values (`src/agent/deno_runtime_codec.ts`).
 *
 * ## Why an eval server instead of driving `deno repl`
 *
 * Machine-driving the human REPL is fragile: `deno repl` is a TTY-shaped
 * interface whose prompt text, ANSI escapes, multiline continuation
 * heuristics, and value pretty-printing all change between Deno releases
 * and differ under a pipe vs a PTY — and its output interleaves the
 * evaluated code's own console writes with the result rendering, so
 * there is no reliable framing to parse a result out of. The agent
 * instead spawns a tiny purpose-built server (`deno run` of a
 * materialized script, written here — no new dependencies) that speaks
 * newline-delimited JSON frames over stdio: requests carry an id +
 * source, responses carry the codec-encoded value or a typed error, and
 * the evaluated code's console output is redirected to stderr so it can
 * never corrupt the frame channel. Session state persists because every
 * snippet is evaluated as a SCRIPT (`node:vm` `runInThisContext`, which
 * Deno implements) in the server's own realm: V8 script semantics put
 * top-level `let`/`const`/`class` into the realm's persistent global
 * lexical environment (which indirect `eval` deliberately does not), so
 * bindings of every kind survive across frames. Redeclaring a
 * `let`/`const` binding in a later snippet is a `SyntaxError`, unlike
 * the human REPL's replace-binding affordance — recorded as an M3
 * parity gap.
 *
 * Upstream semantics mirrored (target `@deno/sandbox@0.13.2`):
 * `deno.eval<T>` is an ephemeral repl (open → one eval → close);
 * `repl.eval` preserves state across calls; `repl.call(fn, ...args)`
 * accepts a defined-function name or inline function source;
 * `deno.run({entrypoint | code, extension, watch, scriptArgs, ...spawn})`
 * surfaces `scriptArgs` as `Deno.args`; results are structured-clone-ish
 * (Map/Set/Date preserved, class instances become plain objects); errors
 * thrown by evaluated code re-throw with the guest error's message,
 * while driver/serialization failures are `AgentError` `SBX_AGENT_EVAL`.
 *
 * @module
 */

import {
  type AgentDenoRepl,
  type AgentDenoReplOptions,
  type AgentDenoRunSpec,
  type AgentDenoRuntime,
  AgentError,
  type AgentProcess,
  type AgentProcessSpawner,
  type AgentRootConfig,
  type CodeExtension,
} from "./api.ts";
import { decodeReplValue, encodeReplValue } from "./deno_runtime_codec.ts";
import { normalizeSandboxPath, resolveSandboxPath } from "./processes.ts";

// ---------------------------------------------------------------------------
// The repl server program
// ---------------------------------------------------------------------------

/**
 * Main body of the repl server. `encodeReplValue`/`decodeReplValue` are
 * prepended via `Function.toString()` (see the codec module's embedding
 * contract), so this string may call them by name. Kept as plain JS —
 * it runs via `deno run` of a materialized file inside the sandbox.
 */
const REPL_SERVER_MAIN = `
import { runInThisContext as __evalScript } from "node:vm";
const __enc = new TextEncoder();
const __dec = new TextDecoder();
const __out = Deno.stdout.writable.getWriter();
async function __send(frame) {
  await __out.write(__enc.encode(JSON.stringify(frame) + "\\n"));
}

// The frame channel owns stdout. Route every console method of the
// evaluated code to stderr (plainly formatted) so console output can
// never corrupt a frame.
{
  const __errWriter = Deno.stderr.writable.getWriter();
  const __fmt = (args) =>
    args.map((a) => (typeof a === "string" ? a : Deno.inspect(a))).join(" ") +
    "\\n";
  globalThis.console = new Proxy(globalThis.console, {
    get(_target, _prop) {
      return (...args) => {
        __errWriter.write(__enc.encode(__fmt(args))).catch(() => {});
      };
    },
  });
}

async function __handle(frame) {
  const id = frame.id;
  try {
    let value;
    if (frame.op === "eval") {
      value = __evalScript(frame.source);
    } else if (frame.op === "call") {
      let fn;
      try {
        fn = __evalScript("(" + frame.fn + "\\n)");
      } catch {
        fn = undefined;
      }
      if (typeof fn !== "function") fn = __evalScript(frame.fn);
      if (typeof fn !== "function") {
        throw new TypeError("repl.call target is not a function: " + frame.fn);
      }
      const args = (frame.args ?? []).map((a) => decodeReplValue(a));
      value = fn(...args);
    } else {
      await __send({ id, ok: false, driver: "unknown op: " + String(frame.op) });
      return;
    }
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function"
    ) {
      value = await value;
    }
    let encoded;
    try {
      encoded = encodeReplValue(value);
    } catch (e) {
      await __send({
        id,
        ok: false,
        driver: e && e.message ? String(e.message) : String(e),
      });
      return;
    }
    await __send({ id, ok: true, value: encoded });
  } catch (e) {
    await __send({
      id,
      ok: false,
      thrown: {
        name: e && e.name ? String(e.name) : "Error",
        message: e && e.message !== undefined ? String(e.message) : String(e),
      },
    });
  }
}

await __send({ ready: true });
let __buf = "";
for await (const chunk of Deno.stdin.readable) {
  __buf += __dec.decode(chunk, { stream: true });
  let __idx;
  while ((__idx = __buf.indexOf("\\n")) >= 0) {
    const line = __buf.slice(0, __idx);
    __buf = __buf.slice(__idx + 1);
    if (line.trim() === "") continue;
    await __handle(JSON.parse(line));
  }
}
Deno.exit(0);
`;

/** Assemble the complete repl server source (codec + main loop). */
export function replServerSource(): string {
  return [
    '"use strict";',
    encodeReplValue.toString(),
    decodeReplValue.toString(),
    REPL_SERVER_MAIN,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The repl session (driver side)
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ServerFrame {
  ready?: boolean;
  id?: number;
  ok?: boolean;
  value?: unknown;
  thrown?: { name?: string; message?: string };
  driver?: string;
}

class AgentReplSession implements AgentDenoRepl {
  readonly #process: AgentProcess;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #loopDone: Promise<void>;
  #nextId = 1;
  #closed = false;
  #readyResolve!: () => void;
  #readyReject!: (error: unknown) => void;
  /** Resolves when the server's ready frame arrives. */
  readonly ready: Promise<void>;

  constructor(process: AgentProcess) {
    this.#process = process;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#loopDone = this.#readLoop();
  }

  eval<T = unknown>(source: string): Promise<T> {
    if (typeof source !== "string") {
      return Promise.reject(
        new AgentError("SBX_AGENT_VALIDATION", "eval source must be a string"),
      );
    }
    return this.#request({ op: "eval", source }) as Promise<T>;
  }

  call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
    if (typeof fn !== "string" || fn.length === 0) {
      return Promise.reject(
        new AgentError(
          "SBX_AGENT_VALIDATION",
          "repl.call target must be a function name or inline function source",
        ),
      );
    }
    let encodedArgs: unknown[];
    try {
      encodedArgs = args.map((arg) => encodeReplValue(arg));
    } catch (err) {
      return Promise.reject(
        new AgentError(
          "SBX_AGENT_EVAL",
          `repl.call argument is not serializable: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err,
        ),
      );
    }
    return this.#request({ op: "call", fn, args: encodedArgs }) as Promise<T>;
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#fail(
        new AgentError("SBX_AGENT_CLOSED", "the repl session is closed"),
      );
      await this.#process.closeStdin();
      await this.#process.kill("SIGKILL");
    }
    try {
      await this.#process.status;
    } catch {
      // Annotator faults are not close()'s problem.
    }
    await this.#loopDone;
  }

  async #readLoop(): Promise<void> {
    const stdout = this.#process.stdout;
    try {
      if (stdout === null) {
        throw new Error("repl driver spawned without piped stdout");
      }
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stdout) {
        buf += dec.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim() === "") continue;
          this.#dispatch(line);
        }
      }
    } catch {
      // Stream failure — handled below as an unexpected exit.
    }
    this.#fail(
      this.#closed
        ? new AgentError("SBX_AGENT_CLOSED", "the repl session is closed")
        : new AgentError(
          "SBX_AGENT_EVAL",
          "the repl driver process exited unexpectedly",
        ),
    );
  }

  #dispatch(line: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(line) as ServerFrame;
    } catch {
      return; // Not a frame; ignore.
    }
    if (frame.ready === true) {
      this.#readyResolve();
      return;
    }
    if (typeof frame.id !== "number") return;
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    this.#pending.delete(frame.id);
    if (frame.ok === true) {
      try {
        pending.resolve(decodeReplValue(frame.value));
      } catch (err) {
        pending.reject(
          new AgentError(
            "SBX_AGENT_EVAL",
            "failed to decode the repl result",
            err,
          ),
        );
      }
    } else if (frame.thrown !== undefined) {
      // An error thrown BY the evaluated code: re-throw with the guest
      // error's message (a plain Error, not an AgentError).
      const error = new Error(frame.thrown.message ?? "error thrown in repl");
      if (frame.thrown.name) error.name = frame.thrown.name;
      pending.reject(error);
    } else {
      pending.reject(
        new AgentError(
          "SBX_AGENT_EVAL",
          frame.driver ?? "the repl driver reported a failure",
        ),
      );
    }
  }

  #fail(error: AgentError): void {
    this.#readyReject(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #request(frame: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new AgentError("SBX_AGENT_CLOSED", "the repl session is closed"),
      );
    }
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const payload = new TextEncoder().encode(
      JSON.stringify({ id, ...frame }) + "\n",
    );
    this.#process.writeStdin(payload).catch((err) => {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        pending.reject(
          this.#closed
            ? new AgentError("SBX_AGENT_CLOSED", "the repl session is closed")
            : new AgentError(
              "SBX_AGENT_EVAL",
              "failed to send the request to the repl driver",
              err,
            ),
        );
      }
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS: readonly CodeExtension[] = [
  "js",
  "cjs",
  "mjs",
  "ts",
  "cts",
  "mts",
  "jsx",
  "tsx",
];

/** Construction options for {@linkcode AgentDeno}. */
export interface AgentDenoOptions {
  /** Sandbox root/home/cwd; see the confinement contract in `api.ts`. */
  readonly config: AgentRootConfig;
  /** The spawner every runtime process goes through (registry included). */
  readonly spawner: AgentProcessSpawner;
  /**
   * Host path of the pinned deno binary. Default: `Deno.execPath()` —
   * the deno hosting the agent (the HOST deno under the fake, the baked
   * pinned deno in the real guest image).
   */
  readonly denoPath?: string;
}

/**
 * {@linkcode AgentDenoRuntime} over a spawner: `run` assembles the
 * pinned `deno run` argv; `eval`/`openRepl` drive the materialized repl
 * server (module doc). Inline code and the repl server are materialized
 * under the sandbox's `/tmp` and deleted once the process no longer
 * needs them.
 */
export class AgentDeno implements AgentDenoRuntime {
  readonly #config: AgentRootConfig;
  readonly #spawner: AgentProcessSpawner;
  readonly #pinnedDeno: string | undefined;

  constructor(options: AgentDenoOptions) {
    this.#config = options.config;
    this.#spawner = options.spawner;
    this.#pinnedDeno = options.denoPath;
  }

  async eval<T = unknown>(
    source: string,
    options?: AgentDenoReplOptions,
  ): Promise<T> {
    // Upstream `deno.eval<T>` is an EPHEMERAL repl: open → eval → close.
    const repl = await this.openRepl(options);
    try {
      return await repl.eval<T>(source);
    } finally {
      await repl.close();
    }
  }

  async openRepl(options: AgentDenoReplOptions = {}): Promise<AgentDenoRepl> {
    const serverPath = await this.#materialize(
      replServerSource(),
      "js",
      "sbx-repl-server-",
    );
    let process: AgentProcess;
    try {
      process = await this.#spawner.spawn({
        command: this.#denoPath(),
        args: [
          "run",
          "-q",
          "-A",
          "--no-lock",
          serverPath,
          ...(options.scriptArgs ?? []),
        ],
        cwd: options.cwd,
        env: options.env,
        clearEnv: options.clearEnv,
        stdin: "piped",
        stdout: "piped",
        // The server routes evaluated console output to stderr; the
        // domain repl has no output surface, so discard it.
        stderr: "null",
      });
    } catch (err) {
      await removeQuietly(serverPath);
      throw err;
    }
    const session = new AgentReplSession(process);
    try {
      await session.ready;
    } catch (err) {
      await session.close();
      throw err;
    } finally {
      // `deno run` has fully loaded the file once it answers ready (or
      // died); the materialized server is no longer needed either way.
      await removeQuietly(serverPath);
    }
    return session;
  }

  async run(spec: AgentDenoRunSpec): Promise<AgentProcess> {
    validateRunSpec(spec);
    const config = spec.cwd === undefined ? this.#config : {
      ...this.#config,
      cwd: normalizeSandboxPath(this.#config, spec.cwd),
    };
    const args = ["run", "-q", "-A", "--no-lock"];
    let script: string;
    let materialized: string | null = null;
    if ("entrypoint" in spec) {
      if (spec.watch === true) {
        args.push("--watch");
      } else if (Array.isArray(spec.watch)) {
        const watched: string[] = [];
        for (const watchPath of spec.watch) {
          watched.push(
            (await resolveSandboxPath(config, watchPath)).realHostPath,
          );
        }
        args.push(`--watch=${watched.join(",")}`);
      }
      script = (await resolveSandboxPath(config, spec.entrypoint)).realHostPath;
    } else {
      materialized = await this.#materialize(
        spec.code,
        spec.extension ?? "ts",
        "sbx-deno-run-",
      );
      script = materialized;
    }
    args.push(script, ...(spec.scriptArgs ?? []));
    const process = await this.#spawner.spawn({
      command: this.#denoPath(),
      args,
      cwd: spec.cwd,
      env: spec.env,
      clearEnv: spec.clearEnv,
      stdin: spec.stdin,
      stdout: spec.stdout,
      stderr: spec.stderr,
    });
    if (materialized !== null) {
      const path = materialized;
      const cleanup = () => void removeQuietly(path);
      process.status.then(cleanup, cleanup);
    }
    return process;
  }

  #denoPath(): string {
    return this.#pinnedDeno ?? Deno.execPath();
  }

  /**
   * Materialize `source` as a file under the sandbox's `/tmp` (created
   * if missing) and resolve its HOST path.
   */
  async #materialize(
    source: string,
    extension: string,
    prefix: string,
  ): Promise<string> {
    const tmp = await resolveSandboxPath(this.#config, "/tmp");
    await Deno.mkdir(tmp.realHostPath, { recursive: true });
    const file = await Deno.makeTempFile({
      dir: tmp.realHostPath,
      prefix,
      suffix: `.${extension}`,
    });
    await Deno.writeTextFile(file, source);
    return file;
  }
}

function validateRunSpec(spec: AgentDenoRunSpec): void {
  if (typeof spec !== "object" || spec === null) {
    throw new AgentError("SBX_AGENT_VALIDATION", "run spec must be an object");
  }
  const record = spec as Record<string, unknown>;
  const hasEntrypoint = record.entrypoint !== undefined;
  const hasCode = record.code !== undefined;
  if (hasEntrypoint === hasCode) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "run spec must have exactly one of entrypoint or code",
    );
  }
  if (hasEntrypoint && typeof record.entrypoint !== "string") {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "run entrypoint must be a string",
    );
  }
  if (hasCode && typeof record.code !== "string") {
    throw new AgentError("SBX_AGENT_VALIDATION", "run code must be a string");
  }
  if (
    hasCode && record.extension !== undefined &&
    !CODE_EXTENSIONS.includes(record.extension as CodeExtension)
  ) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `run extension must be one of ${CODE_EXTENSIONS.join(", ")}: ${
        JSON.stringify(record.extension)
      }`,
    );
  }
  if (
    hasCode && record.watch !== undefined
  ) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "run watch applies to entrypoint runs only",
    );
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // Best-effort cleanup of a materialized temp file.
  }
}
