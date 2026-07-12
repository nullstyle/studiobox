/**
 * DEFECT A (host availability) regression — the host dialer
 * (`src/rootd/agent_dialer.ts`) must never HANG on a studioboxd that
 * accepts the connection and then stalls or sends garbage instead of
 * speaking the capnp bootstrap. It must reject with a typed
 * `SupervisorError` within its timeout AND leak nothing (the resource
 * sanitizer stays on for every test in this file).
 *
 * A fake "studioboxd" is a TCP listener on 127.0.0.1 (within `test:unit`'s
 * `--allow-net=127.0.0.1`) that, per case, accepts and then: (a) holds the
 * connection open and never writes; (b) writes garbage bytes and stalls;
 * (c) writes a valid-looking length prefix for a large frame, truncates,
 * and stalls. Each dial must reject promptly.
 *
 * Pre-fix (the published `connect()` helper, or an unbounded bootstrap)
 * the in-flight bootstrap call has no timeout and no onClose wiring, so the
 * dial hangs forever and these tests time out.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import { openAgentSession } from "../../../src/rootd/agent_dialer.ts";
import { SupervisorError } from "../../../src/rootd/supervisor_core_api.ts";

const DIAL_TIMEOUT_MS = 750;
// A dial that respects its timeout settles well within this; a hang blows
// past it. The test-level guard makes a regression a fast failure, not a
// wedged suite.
const HANG_GUARD_MS = 8_000;

type StallMode = "silent" | "garbage" | "truncated-frame";

interface FakeAgentd extends AsyncDisposable {
  readonly port: number;
}

/**
 * A listener that accepts one (or more) connections and, per `mode`,
 * stalls without ever completing the capnp handshake. Accepted conns are
 * held open (referenced) until disposal so the peer genuinely waits.
 */
function startFakeAgentd(mode: StallMode): FakeAgentd {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const held: Deno.Conn[] = [];
  const loop = (async () => {
    for await (const conn of listener) {
      held.push(conn);
      if (mode === "garbage") {
        await conn.write(crypto.getRandomValues(new Uint8Array(48))).catch(
          () => {},
        );
      } else if (mode === "truncated-frame") {
        const header = new Uint8Array(8);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0, true); // one segment
        view.setUint32(4, 0x0010_0000, true); // 1M words claimed
        await conn.write(header).catch(() => {});
        await conn.write(new Uint8Array(16)).catch(() => {}); // sliver, stall
      }
      // "silent": accept and hold, never write.
    }
  })();

  return {
    port: (listener.addr as Deno.NetAddr).port,
    async [Symbol.asyncDispose]() {
      try {
        listener.close();
      } catch {
        // Already closed.
      }
      for (const conn of held) {
        try {
          conn.close();
        } catch {
          // Already closed.
        }
      }
      await loop.catch(() => {});
    },
  };
}

async function dial(port: number): Promise<never> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  return await openAgentSession(conn, {
    credential: crypto.getRandomValues(new Uint8Array(32)),
    sandboxId: "sbx-dial-test",
    bootNonce: new Uint8Array(32),
    timeoutMs: DIAL_TIMEOUT_MS,
  }) as never;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} hung past ${HANG_GUARD_MS}ms`)),
      HANG_GUARD_MS,
    );
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

for (const mode of ["silent", "garbage", "truncated-frame"] as const) {
  Deno.test(`connectAgent rejects a stalling studioboxd (${mode}), no hang`, async () => {
    await using agentd = startFakeAgentd(mode);
    const started = performance.now();
    const error = await withTimeout(
      assertRejects(() => dial(agentd.port), SupervisorError),
      `dial(${mode})`,
    ) as SupervisorError;
    const elapsed = performance.now() - started;
    assertEquals(error.code, "SBX_SUP_UNAVAILABLE");
    assert(
      elapsed < HANG_GUARD_MS,
      `dial should reject near its ${DIAL_TIMEOUT_MS}ms timeout, took ${
        Math.round(elapsed)
      }ms`,
    );
  });
}
