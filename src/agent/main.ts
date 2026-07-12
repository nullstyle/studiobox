/**
 * studioboxd — the guest-agent entrypoint (`deno compile` target).
 *
 * Serves the M3 {@linkcode AgentApi} domain plane (`./api.ts`) over a
 * Unix-domain-socket control channel.
 *
 * ## M3 TRANSPORT SCAFFOLDING — PRIVATE, TEMPORARY
 *
 * Everything below the "wire scaffolding" marker is a milestone-private
 * stand-in for the capnp plane: once `schema/sandbox_agent.capnp`
 * codegen is unblocked upstream, the `AgentBootstrap`/`SandboxAgent`
 * capnp services replace this file's framing and dispatch wholesale
 * (vsock in prod, UDS/TCP in dev) — which is why the entire transport
 * lives in this ONE file: the swap is surgical, and nothing else in
 * `src/agent/` knows the protocol exists. Do not build clients against
 * this protocol outside this repository's M3 tests and smoke tooling.
 *
 * Protocol (newline-delimited JSON, UTF-8, one frame per line):
 *
 * - Request:  `{"id": <number>, "method": <string>, "params"?: {...}}`
 * - Response: `{"id", "ok": true, "value": ...}` or
 *   `{"id", "ok": false, "error": {"code", "message"}}`
 *
 * Responses may arrive out of request order (dispatch is concurrent);
 * clients correlate by `id`. Binary payloads are base64 strings. Repl
 * values cross in the `deno_runtime_codec` tagged form. Long-lived
 * capabilities (processes, repl sessions) are integer handles scoped to
 * the CONNECTION: when a connection drops, its repl sessions are closed
 * and its process handles released (registry drop; processes themselves
 * keep running, mirroring wire `Process.release` semantics — agent
 * shutdown is what kills them).
 *
 * Flags: `--socket <path>` (required), `--root <hostdir>` (default
 * `/`), `--home <in-sandbox dir>` (default `/home/app`), `--deno
 * <host path>` (the pinned deno binary driving `DenoRuntime`; REQUIRED
 * in compiled builds, where the default — `Deno.execPath()` — resolves
 * to the studioboxd binary itself, not a deno CLI; the guest image
 * bakes a pinned deno and overlay-init passes it here). On boot the
 * agent prints one `{"studioboxd": {...}}` ready line to stdout.
 *
 * @module
 */

import type {
  AgentApi,
  AgentDenoRepl,
  AgentDenoReplOptions,
  AgentDenoRunSpec,
  AgentInfo,
  AgentProcess,
  AgentRootConfig,
  AgentSpawnSpec,
} from "./api.ts";
import { AgentError } from "./api.ts";
import { AgentDeno } from "./deno_runtime.ts";
import { AgentEnv } from "./env.ts";
import { AgentFs } from "./fs.ts";
import { AgentProcesses, collectOutput, sandboxHome } from "./processes.ts";
import { decodeReplValue, encodeReplValue } from "./deno_runtime_codec.ts";

const BUILD_ID = "studioboxd/m3-scaffold";

// ---------------------------------------------------------------------------
// Agent assembly (domain plane — survives the wire swap)
// ---------------------------------------------------------------------------

interface AgentAssembly {
  readonly api: AgentApi;
  readonly processes: AgentProcesses;
}

function assembleAgent(
  config: AgentRootConfig,
  denoPath: string | undefined,
): AgentAssembly {
  // The real guest seeds the agent environment from its boot
  // environment; the fake host seeds explicitly instead (see
  // `testing/mod.ts`).
  const env = new AgentEnv(Deno.env.toObject());
  const processes = new AgentProcesses({ config, env });
  const fs = new AgentFs(config);
  const deno = new AgentDeno({ config, spawner: processes, denoPath });
  const startedAtUnixMs = Date.now();
  const api: AgentApi = {
    processes,
    fs,
    env,
    deno,
    info(): Promise<AgentInfo> {
      return Promise.resolve({
        buildId: BUILD_ID,
        denoVersion: Deno.version.deno,
        arch: Deno.build.arch,
        home: sandboxHome(config),
        startedAtUnixMs,
      });
    },
    ping(nonce: bigint): Promise<bigint> {
      return Promise.resolve(nonce);
    },
  };
  return { api, processes };
}

// ---------------------------------------------------------------------------
// M3 wire scaffolding from here down — replaced by the capnp plane.
// ---------------------------------------------------------------------------

interface RequestFrame {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type ResponseFrame =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

function toErrorFrame(id: number, error: unknown): ResponseFrame {
  if (error instanceof AgentError) {
    return {
      id,
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  // Deno.errors.* names pass through so clients can map OS failures.
  return { id, ok: false, error: { code: `OS_${name}`, message } };
}

function bad(message: string): never {
  throw new AgentError("SBX_AGENT_VALIDATION", message);
}

function str(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") bad(`param "${key}" must be a string`);
  return value;
}

function optStr(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  return params[key] === undefined ? undefined : str(params, key);
}

function num(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number") bad(`param "${key}" must be a number`);
  return value;
}

function b64encode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON-lossy FileInfo projection (Dates → epoch ms). Scaffold-only. */
function fileInfoJson(info: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    out[key] = value instanceof Date ? value.getTime() : value;
  }
  return out;
}

/** Per-connection capability tables. */
class ConnectionScope {
  readonly processes = new Map<number, AgentProcess>();
  readonly repls = new Map<number, AgentDenoRepl>();
  #nextHandle = 1;

  grant<T>(table: Map<number, T>, value: T): number {
    const handle = this.#nextHandle++;
    table.set(handle, value);
    return handle;
  }

  claim<T>(table: Map<number, T>, handle: number, what: string): T {
    const value = table.get(handle);
    if (value === undefined) {
      throw new AgentError(
        "SBX_AGENT_CLOSED",
        `unknown ${what} handle ${handle}`,
      );
    }
    return value;
  }
}

function spawnSpecFromParams(
  params: Record<string, unknown>,
): AgentSpawnSpec {
  // Structural validation is the spawner's job; this just shapes the
  // JSON payload.
  return params.spec as AgentSpawnSpec;
}

async function dispatch(
  agent: AgentApi,
  scope: ConnectionScope,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    // -- plane ----------------------------------------------------------
    case "ping":
      return {
        nonce: (await agent.ping(BigInt(str(params, "nonce")))).toString(),
      };
    case "info":
      return await agent.info();

    // -- env ------------------------------------------------------------
    case "env.get":
      return { value: await agent.env.get(str(params, "key")) };
    case "env.set":
      await agent.env.set(str(params, "key"), str(params, "value"));
      return {};
    case "env.delete":
      await agent.env.delete(str(params, "key"));
      return {};
    case "env.toObject":
      return { vars: await agent.env.toObject() };

    // -- fs (core subset; the full surface arrives with the capnp plane)
    case "fs.readFile":
      return { data: b64encode(await agent.fs.readFile(str(params, "path"))) };
    case "fs.writeFile":
      await agent.fs.writeFile(
        str(params, "path"),
        b64decode(str(params, "data")),
        params.options as import("./api.ts").WriteFileOptions | undefined,
      );
      return {};
    case "fs.readTextFile":
      return { text: await agent.fs.readTextFile(str(params, "path")) };
    case "fs.writeTextFile":
      await agent.fs.writeTextFile(
        str(params, "path"),
        str(params, "text"),
        params.options as import("./api.ts").WriteFileOptions | undefined,
      );
      return {};
    case "fs.readDir": {
      const entries = [];
      for await (const entry of agent.fs.readDir(str(params, "path"))) {
        entries.push(entry);
      }
      return { entries };
    }
    case "fs.mkdir":
      await agent.fs.mkdir(
        str(params, "path"),
        params.options as import("./api.ts").MkdirOptions | undefined,
      );
      return {};
    case "fs.remove":
      await agent.fs.remove(
        str(params, "path"),
        params.options as import("./api.ts").RemoveOptions | undefined,
      );
      return {};
    case "fs.rename":
      await agent.fs.rename(str(params, "oldPath"), str(params, "newPath"));
      return {};
    case "fs.stat":
      return fileInfoJson(
        await agent.fs.stat(str(params, "path")) as unknown as Record<
          string,
          unknown
        >,
      );
    case "fs.lstat":
      return fileInfoJson(
        await agent.fs.lstat(str(params, "path")) as unknown as Record<
          string,
          unknown
        >,
      );
    case "fs.realPath":
      return { path: await agent.fs.realPath(str(params, "path")) };
    case "fs.readLink":
      return { target: await agent.fs.readLink(str(params, "path")) };
    case "fs.symlink":
      await agent.fs.symlink(str(params, "target"), str(params, "path"));
      return {};
    case "fs.truncate":
      await agent.fs.truncate(
        str(params, "path"),
        params.length === undefined ? undefined : num(params, "length"),
      );
      return {};
    case "fs.makeTempDir":
      return {
        path: await agent.fs.makeTempDir({
          dir: optStr(params, "dir"),
          prefix: optStr(params, "prefix"),
          suffix: optStr(params, "suffix"),
        }),
      };
    case "fs.makeTempFile":
      return {
        path: await agent.fs.makeTempFile({
          dir: optStr(params, "dir"),
          prefix: optStr(params, "prefix"),
          suffix: optStr(params, "suffix"),
        }),
      };

    // -- processes --------------------------------------------------------
    case "process.spawn": {
      const process = await agent.processes.spawn(spawnSpecFromParams(params));
      return {
        handle: scope.grant(scope.processes, process),
        pid: process.pid,
      };
    }
    case "process.status": {
      const process = scope.claim(
        scope.processes,
        num(params, "handle"),
        "process",
      );
      return await process.status;
    }
    case "process.kill": {
      const process = scope.claim(
        scope.processes,
        num(params, "handle"),
        "process",
      );
      await process.kill(
        optStr(params, "signal") as import("./api.ts").AgentKillSignal ??
          undefined,
      );
      return {};
    }
    case "process.writeStdin": {
      const process = scope.claim(
        scope.processes,
        num(params, "handle"),
        "process",
      );
      await process.writeStdin(b64decode(str(params, "data")));
      return {};
    }
    case "process.closeStdin": {
      const process = scope.claim(
        scope.processes,
        num(params, "handle"),
        "process",
      );
      await process.closeStdin();
      return {};
    }
    case "process.output": {
      // Buffered convenience for the scaffold (streamed stdio arrives
      // with the capnp OutputSink plane).
      const process = scope.claim(
        scope.processes,
        num(params, "handle"),
        "process",
      );
      const output = await collectOutput(process);
      return {
        status: output.status,
        stdout: output.stdout === null ? null : b64encode(output.stdout),
        stderr: output.stderr === null ? null : b64encode(output.stderr),
      };
    }
    case "process.release": {
      scope.processes.delete(num(params, "handle"));
      return {};
    }

    // -- deno runtime -----------------------------------------------------
    case "deno.eval": {
      const value = await agent.deno.eval(
        str(params, "source"),
        params.options as AgentDenoReplOptions | undefined,
      );
      return { value: encodeReplValue(value) };
    }
    case "deno.run": {
      const process = await agent.deno.run(params.spec as AgentDenoRunSpec);
      return {
        handle: scope.grant(scope.processes, process),
        pid: process.pid,
      };
    }
    case "repl.open": {
      const session = await agent.deno.openRepl(
        params.options as AgentDenoReplOptions | undefined,
      );
      return { handle: scope.grant(scope.repls, session) };
    }
    case "repl.eval": {
      const session = scope.claim(scope.repls, num(params, "handle"), "repl");
      const value = await session.eval(str(params, "source"));
      return { value: encodeReplValue(value) };
    }
    case "repl.call": {
      const session = scope.claim(scope.repls, num(params, "handle"), "repl");
      const args = ((params.args ?? []) as unknown[]).map(decodeReplValue);
      const value = await session.call(str(params, "fn"), ...args);
      return { value: encodeReplValue(value) };
    }
    case "repl.close": {
      const handle = num(params, "handle");
      const session = scope.repls.get(handle);
      scope.repls.delete(handle);
      if (session !== undefined) await session.close();
      return {};
    }

    default:
      throw new AgentError(
        "SBX_AGENT_UNSUPPORTED",
        `unknown method: ${method}`,
      );
  }
}

async function handleConnection(
  conn: Deno.Conn,
  agent: AgentApi,
): Promise<void> {
  const scope = new ConnectionScope();
  const encoder = new TextEncoder();
  // Serialize response writes; dispatch itself is concurrent, so
  // responses may leave out of request order (clients match on id).
  let writeChain = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  const send = (frame: ResponseFrame): Promise<void> => {
    writeChain = writeChain
      .then(async () => {
        const bytes = encoder.encode(JSON.stringify(frame) + "\n");
        let offset = 0;
        while (offset < bytes.length) {
          offset += await conn.write(bytes.subarray(offset));
        }
      })
      .catch(() => {});
    return writeChain;
  };
  const serve = (request: RequestFrame): void => {
    const task = dispatch(agent, scope, request.method, request.params ?? {})
      .then(
        (value) => send({ id: request.id, ok: true, value }),
        (error) => send(toErrorFrame(request.id, error)),
      );
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  };

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of conn.readable) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        let request: RequestFrame;
        try {
          request = JSON.parse(line) as RequestFrame;
        } catch {
          continue; // Not a frame; scaffold drops it.
        }
        if (
          typeof request.id !== "number" || typeof request.method !== "string"
        ) {
          continue;
        }
        serve(request);
      }
    }
  } catch {
    // Connection torn down mid-read; fall through to scope cleanup.
  }
  await Promise.allSettled([...inFlight]);
  // Connection-scoped cleanup: close repl sessions, drop process
  // handles (release semantics — the processes keep running until
  // agent shutdown).
  for (const session of scope.repls.values()) {
    await session.close().catch(() => {});
  }
  scope.repls.clear();
  scope.processes.clear();
  try {
    conn.close();
  } catch {
    // Already closed.
  }
}

// ---------------------------------------------------------------------------
// Flags + serve loop
// ---------------------------------------------------------------------------

interface AgentFlags {
  socket: string;
  root: string;
  home?: string;
  deno?: string;
}

export function parseAgentFlags(args: readonly string[]): AgentFlags {
  const flags: Partial<AgentFlags> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const take = (name: string): string => {
      const inline = `--${name}=`;
      if (arg.startsWith(inline)) return arg.slice(inline.length);
      const next = args[++i];
      if (next === undefined) {
        throw new AgentError("SBX_AGENT_VALIDATION", `--${name} needs a value`);
      }
      return next;
    };
    if (arg === "--socket" || arg.startsWith("--socket=")) {
      flags.socket = take("socket");
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      flags.root = take("root");
    } else if (arg === "--home" || arg.startsWith("--home=")) {
      flags.home = take("home");
    } else if (arg === "--deno" || arg.startsWith("--deno=")) {
      flags.deno = take("deno");
    } else {
      throw new AgentError("SBX_AGENT_VALIDATION", `unknown flag: ${arg}`);
    }
  }
  if (flags.socket === undefined) {
    throw new AgentError("SBX_AGENT_VALIDATION", "--socket <path> is required");
  }
  return {
    socket: flags.socket,
    root: flags.root ?? "/",
    home: flags.home,
    deno: flags.deno,
  };
}

async function main(): Promise<void> {
  let flags: AgentFlags;
  try {
    flags = parseAgentFlags(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error),
      "\nusage: studioboxd --socket <path> [--root <dir>] [--home <dir>] [--deno <path>]",
    );
    Deno.exit(2);
  }
  const config: AgentRootConfig = { root: flags.root, home: flags.home };
  const { api, processes } = assembleAgent(config, flags.deno);

  // Replace a stale socket file from a previous run.
  try {
    await Deno.remove(flags.socket);
  } catch {
    // Absent is the normal case.
  }
  const listener = Deno.listen({ transport: "unix", path: flags.socket });

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      listener.close();
    } catch {
      // Already closed.
    }
    await processes.shutdown();
    try {
      await Deno.remove(flags.socket);
    } catch {
      // Best-effort.
    }
    Deno.exit(code);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(signal, () => void shutdown(0));
  }

  // Ready line (consumed by smoke tooling and process supervisors).
  console.log(JSON.stringify({
    studioboxd: {
      buildId: BUILD_ID,
      socket: flags.socket,
      root: flags.root,
      pid: Deno.pid,
    },
  }));

  for await (const conn of listener) {
    void handleConnection(conn, api);
  }
  await shutdown(0);
}

if (import.meta.main) {
  await main();
}
