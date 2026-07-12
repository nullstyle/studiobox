/**
 * DEFECT A (guest availability) regression — a peer that opens a
 * studioboxd connection and then sends a malformed/oversized/incomplete
 * TRANSPORT frame (or nothing) and STALLS must not pin a per-connection
 * session forever. Boots the real entrypoint (`src/agent/main.ts`) as a
 * subprocess over a real UDS with a short handshake deadline
 * (`SBX_AGENT_HANDSHAKE_DEADLINE_MS`), then drives three abusive clients:
 *
 *   (a) sends garbage bytes, then stalls;
 *   (b) sends a valid-looking length prefix for a large frame, then
 *       truncates and stalls (the framer keeps waiting);
 *   (c) connects and never speaks.
 *
 * Each must be DROPPED by the server within a bounded time (our end sees
 * EOF / a peer reset), proving the session was torn down — not leaked. The
 * accept loop must stay healthy: after all three, a legit client completes
 * the full bootstrap and round-trips `ping`, and the agent process is
 * still alive.
 *
 * Pre-fix (onError not wired to teardown; no handshake deadline) the
 * server never closes these connections, so every "expect drop" read hangs
 * and this test times out.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

import { openAgentSession } from "../../../src/rootd/agent_dialer.ts";

const MAIN_TS = fromFileUrl(
  new URL("../../../src/agent/main.ts", import.meta.url),
);

const HANDSHAKE_DEADLINE_MS = 2_000;
// Generous slack over the deadline so a healthy CI box never flakes, while
// staying far under any "hang" (which would be unbounded).
const DROP_BUDGET_MS = 10_000;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

interface RunningAgentd extends AsyncDisposable {
  readonly child: Deno.ChildProcess;
  readonly socket: string;
  readonly credential: Uint8Array;
  isAlive(): boolean;
}

async function startAgentd(): Promise<RunningAgentd> {
  const root = await Deno.makeTempDir({ prefix: "sbx-leakd-" });
  await Deno.mkdir(`${root}/home/app`, { recursive: true });
  const socketDir = await Deno.makeTempDir({ prefix: "sbxld-" });
  const socket = `${socketDir}/a.sock`;
  const credential = crypto.getRandomValues(new Uint8Array(32));
  const tokenFile = `${root}/token.hex`;
  await Deno.writeTextFile(tokenFile, toHex(credential));

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
      "--token-file",
      tokenFile,
    ],
    env: { SBX_AGENT_HANDSHAKE_DEADLINE_MS: String(HANDSHAKE_DEADLINE_MS) },
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  let exited = false;
  const status = child.status.then((s) => {
    exited = true;
    return s;
  });

  const reader = child.stdout.getReader();
  let readyText = "";
  const decoder = new TextDecoder();
  while (!readyText.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("studioboxd exited before its ready line");
    readyText += decoder.decode(value, { stream: true });
  }
  const ready = JSON.parse(readyText.slice(0, readyText.indexOf("\n"))) as {
    studioboxd: { socket: string };
  };
  assertEquals(ready.studioboxd.socket, socket);
  const drained = (async () => {
    while (!(await reader.read()).done) {
      // discard
    }
  })().catch(() => {});

  return {
    child,
    socket,
    credential,
    isAlive: () => !exited,
    async [Symbol.asyncDispose]() {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await status;
      await drained;
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(socketDir, { recursive: true }).catch(() => {});
    },
  };
}

/**
 * Assert the server drops `conn` within the budget: a read returns EOF
 * (`null`) or throws a peer-disconnect error. Only an unbounded hang (the
 * timeout winning the race) fails.
 */
async function assertServerDrops(
  conn: Deno.Conn,
  label: string,
): Promise<void> {
  const buf = new Uint8Array(64);
  try {
    const n = await withTimeout(conn.read(buf), DROP_BUDGET_MS, label);
    assertEquals(
      n,
      null,
      `${label}: expected server-side EOF, read ${n} bytes`,
    );
  } catch (error) {
    if (error instanceof Error && /timed out/.test(error.message)) {
      throw error; // The defect: the server hung instead of dropping us.
    }
    // A ConnectionReset / BadResource is the server closing on us: a drop.
  } finally {
    try {
      conn.close();
    } catch {
      // Already closed by the server.
    }
  }
}

Deno.test("studioboxd drops a peer that sends garbage then stalls", async () => {
  await using agentd = await startAgentd();
  const conn = await Deno.connect({ transport: "unix", path: agentd.socket });
  await conn.write(crypto.getRandomValues(new Uint8Array(48)));
  // Do NOT close: stall, holding the connection open.
  await assertServerDrops(conn, "garbage-then-stall");
  assert(agentd.isAlive(), "agent must survive an abusive connection");
});

Deno.test("studioboxd drops a peer that truncates a large frame then stalls", async () => {
  await using agentd = await startAgentd();
  const conn = await Deno.connect({ transport: "unix", path: agentd.socket });
  // A capnp stream frame begins with a little-endian (segmentCount - 1)
  // then per-segment word counts. Claim one huge segment, then send only a
  // few of its bytes and stall: the framer waits forever for the rest.
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0, true); // segmentCount - 1 = 0 (one segment)
  view.setUint32(4, 0x0010_0000, true); // 1M words claimed
  await conn.write(header);
  await conn.write(new Uint8Array(16)); // a sliver, then stall
  await assertServerDrops(conn, "truncated-then-stall");
  assert(agentd.isAlive(), "agent must survive an abusive connection");
});

Deno.test("studioboxd drops a peer that connects and never speaks", async () => {
  await using agentd = await startAgentd();
  const conn = await Deno.connect({ transport: "unix", path: agentd.socket });
  await assertServerDrops(conn, "silent");
  assert(agentd.isAlive(), "agent must survive an abusive connection");
});

Deno.test("the accept loop stays healthy after abusive connections", async () => {
  await using agentd = await startAgentd();

  // Three abusive connections, back to back.
  const garbage = await Deno.connect({
    transport: "unix",
    path: agentd.socket,
  });
  await garbage.write(crypto.getRandomValues(new Uint8Array(32)));
  const silent = await Deno.connect({ transport: "unix", path: agentd.socket });
  await assertServerDrops(garbage, "garbage");
  await assertServerDrops(silent, "silent");

  // A legit client must still complete the whole bootstrap and round-trip.
  const conn = await Deno.connect({ transport: "unix", path: agentd.socket });
  await using session = await openAgentSession(conn, {
    credential: agentd.credential,
    sandboxId: "sbx-leak-test",
    bootNonce: new Uint8Array(32),
    timeoutMs: DROP_BUDGET_MS,
  });
  const echoed = await session.agent.ping(0x1234n);
  assertEquals(echoed, 0x1234n, "legit client must round-trip after abuse");
  assert(agentd.isAlive(), "agent must still be serving");
});
