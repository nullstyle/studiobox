/**
 * studioboxd (src/agent/main.ts) over a real UDS: boots the entrypoint
 * as a subprocess with `--root`/`--socket`, then drives the M3
 * line-framed JSON scaffolding protocol end to end — ping, info, env,
 * fs, spawn+output, deno.eval — and exercises SIGTERM shutdown
 * (socket file removed, exit 0).
 *
 * The protocol is PRIVATE to this milestone (see the main.ts module
 * doc); this test and the compile smoke are its only sanctioned
 * clients.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { decodeReplValue } from "../../../src/agent/deno_runtime_codec.ts";

const MAIN_TS = fromFileUrl(
  new URL("../../../src/agent/main.ts", import.meta.url),
);

interface ErrorShape {
  code: string;
  message: string;
}

class AgentdClient {
  #conn: Deno.UnixConn;
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #nextId = 1;
  #loop: Promise<void>;

  constructor(conn: Deno.UnixConn) {
    this.#conn = conn;
    this.#loop = this.#readLoop();
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const frame = new TextEncoder().encode(
      JSON.stringify({ id, method, params }) + "\n",
    );
    let offset = 0;
    while (offset < frame.length) {
      offset += await this.#conn.write(frame.subarray(offset));
    }
    return await promise as T;
  }

  async close(): Promise<void> {
    try {
      this.#conn.close();
    } catch {
      // Already closed by the server side.
    }
    await this.#loop;
  }

  async #readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.#conn.readable) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          const frame = JSON.parse(line) as {
            id: number;
            ok: boolean;
            value?: unknown;
            error?: ErrorShape;
          };
          const pending = this.#pending.get(frame.id);
          if (pending === undefined) continue;
          this.#pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.value);
          else {
            pending.reject(
              new Error(`${frame.error?.code}: ${frame.error?.message}`),
            );
          }
        }
      }
    } catch {
      // Connection dropped.
    }
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("connection closed"));
    }
    this.#pending.clear();
  }
}

interface RunningAgentd extends AsyncDisposable {
  readonly child: Deno.ChildProcess;
  readonly socket: string;
  readonly root: string;
  connect(): Promise<AgentdClient>;
}

async function startAgentd(): Promise<RunningAgentd> {
  const root = await Deno.makeTempDir({ prefix: "sbx-agentd-" });
  await Deno.mkdir(`${root}/home/app`, { recursive: true });
  const socket = await Deno.makeTempDir({ prefix: "sbxd-" }) + "/a.sock";
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-q",
      "-A",
      MAIN_TS,
      "--root",
      root,
      "--socket",
      socket,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  // Wait for the ready line.
  const reader = child.stdout.getReader();
  let readyText = "";
  const decoder = new TextDecoder();
  while (!readyText.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("studioboxd exited before its ready line");
    readyText += decoder.decode(value, { stream: true });
  }
  const ready = JSON.parse(readyText.slice(0, readyText.indexOf("\n"))) as {
    studioboxd: { socket: string; pid: number; buildId: string };
  };
  assertEquals(ready.studioboxd.socket, socket);
  // Drain any further stdout so the child never blocks on a full pipe.
  const drained = (async () => {
    while (!(await reader.read()).done) {
      // discard
    }
  })().catch(() => {});

  return {
    child,
    socket,
    root,
    connect: async () =>
      new AgentdClient(
        await Deno.connect({ transport: "unix", path: socket }),
      ),
    async [Symbol.asyncDispose]() {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await child.status;
      await drained;
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(socket).catch(() => {});
    },
  };
}

Deno.test("studioboxd serves the agent plane over the M3 UDS protocol", async () => {
  await using agentd = await startAgentd();
  const client = await agentd.connect();
  try {
    // ping echoes the nonce (bigint-as-string on this scaffold).
    const pong = await client.request<{ nonce: string }>("ping", {
      nonce: "18446744073709551615",
    });
    assertEquals(pong.nonce, "18446744073709551615");

    // info identifies the scaffold build.
    const info = await client.request<{ buildId: string; home: string }>(
      "info",
    );
    assertMatch(info.buildId, /^studioboxd\//);
    assertEquals(info.home, "/home/app");

    // env round-trip.
    await client.request("env.set", { key: "AGENTD_TEST", value: "on" });
    assertEquals(
      (await client.request<{ value?: string }>("env.get", {
        key: "AGENTD_TEST",
      })).value,
      "on",
    );

    // fs round-trip under the sandbox root.
    await client.request("fs.writeTextFile", {
      path: "/home/app/probe.txt",
      text: "over the wire",
    });
    assertEquals(
      (await client.request<{ text: string }>("fs.readTextFile", {
        path: "probe.txt",
      })).text,
      "over the wire",
    );
    const escape = await client.request("fs.readTextFile", {
      path: "/../../etc/passwd",
    }).then(() => null, (e: Error) => e);
    // `..` clamps at the sandbox root, so this resolves to /etc/passwd
    // IN-SANDBOX, which does not exist.
    assert(escape instanceof Error && escape.message.includes("NotFound"));

    // spawn + buffered output.
    const spawned = await client.request<{ handle: number; pid: number }>(
      "process.spawn",
      { spec: { command: "/bin/echo", args: ["from", "agentd"] } },
    );
    assert(spawned.pid > 0);
    const output = await client.request<{
      status: { code: number };
      stdout: string | null;
    }>("process.output", { handle: spawned.handle });
    assertEquals(output.status.code, 0);
    assertEquals(atob(output.stdout ?? ""), "from agentd\n");

    // deno.eval crosses in the repl codec form.
    const evaled = await client.request<{ value: unknown }>("deno.eval", {
      source: 'new Map([["k", 41 + 1]])',
    });
    const map = decodeReplValue(evaled.value) as Map<string, number>;
    assertEquals(map.get("k"), 42);
  } finally {
    await client.close();
  }
});

Deno.test("studioboxd SIGTERM shutdown removes the socket and exits 0", async () => {
  const agentd = await startAgentd();
  try {
    const client = await agentd.connect();
    await client.request("ping", { nonce: "1" });
    agentd.child.kill("SIGTERM");
    const status = await agentd.child.status;
    assertEquals(status.code, 0);
    await client.close();
    // The socket file is gone after shutdown.
    const stat = await Deno.lstat(agentd.socket).then(
      () => "present",
      () => "absent",
    );
    assertEquals(stat, "absent");
  } finally {
    await agentd[Symbol.asyncDispose]();
  }
});
