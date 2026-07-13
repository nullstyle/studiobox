/**
 * The {@linkcode StudioboxProvider} driven against the IN-PROCESS assembled
 * stack — real hostd (`HostControlCore` + `startHostControlServer` +
 * `WireBridgeFactory`) + the rootd half (`BridgeWireGateway` standing up a
 * real `BridgeServer` per openBridge) + the REAL studioboxd over a UDS +
 * the shared tunnel router — with NO VM. This proves the WHOLE provider path
 * a `@deno/sandbox` consumer drives:
 *
 *   Sandbox.create → host_control.create → openTunnel → dial the static
 *   tunnel → SandboxAgent authenticate → sh / fs / env / deno / close
 *
 * on macOS, exactly as the Parity phase will against the real in-VM stack
 * (only the endpoints + token change).
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

import {
  ConnectionClosedError,
  ConnectionEstablishmentError,
  InvalidMemoryError,
  InvalidTimeoutError,
  MissingTokenError,
  SandboxCommandError,
  SandboxKillError,
  UnsupportedFeatureError,
} from "../../../src/api/errors.ts";
import { installSandboxProvider } from "../../../src/api/provider.ts";
import { Sandbox } from "../../../src/api/sandbox.ts";
import { HostControlCore } from "../../../src/hostd/control_core.ts";
import { WireBridgeFactory } from "../../../src/hostd/wire_bridge.ts";
import {
  buildHostContractIdentity,
  type HostCompatIdentitySource,
} from "../../../src/hostd/service.ts";
import { startHostControlServer } from "../../../src/hostd/main.ts";
import type { ContractIdentity } from "../../../src/wire/contract.ts";
import { StudioboxProvider } from "../../../src/sdk/provider.ts";
import { BridgeWireGateway, startFakeAgent } from "../hostd/tunnel_harness.ts";

const TIMEOUT_MS = 20_000;

async function loadCompat(): Promise<HostCompatIdentitySource> {
  const text = await Deno.readTextFile(
    new URL("../../../compat/wire.json", import.meta.url),
  );
  return JSON.parse(text) as HostCompatIdentitySource;
}

interface AssembledStack extends AsyncDisposable {
  readonly provider: StudioboxProvider;
  readonly hostCredential: Uint8Array;
  readonly identity: ContractIdentity;
  readonly controlSocket: string;
  readonly tunnelSocket: string;
  /** The fake rootd gateway (records exposeHttp installs for assertions). */
  readonly gateway: BridgeWireGateway;
}

/** Stand up the whole in-process hostd+rootd+agent+tunnel stack. */
async function startStack(): Promise<AssembledStack> {
  const agent = await startFakeAgent();
  const gateway = await BridgeWireGateway.start(agent);
  const dir = await Deno.makeTempDir({ prefix: "sbx-sdk-" });
  const controlSocket = join(dir, "host.sock");
  const tunnelSocket = join(dir, "tunnel.sock");

  const core = new HostControlCore({
    gateway,
    bridgeFactory: new WireBridgeFactory(gateway),
    tunnelListen: { transport: "unix", path: tunnelSocket },
  });
  const identity = await buildHostContractIdentity(await loadCompat(), {
    buildId: "hostd-sdk-test",
  });
  const hostCredential = crypto.getRandomValues(new Uint8Array(32));
  const server = await startHostControlServer({
    listen: { kind: "unix", socketPath: controlSocket },
    core,
    identity,
    credential: hostCredential,
  });

  const provider = new StudioboxProvider({
    control: { transport: "unix", path: controlSocket },
    tunnel: { transport: "unix", path: tunnelSocket },
    token: hostCredential,
    identity,
    buildId: "studiobox/sdk-test",
    callTimeoutMs: TIMEOUT_MS,
  });

  return {
    provider,
    hostCredential,
    identity,
    controlSocket,
    tunnelSocket,
    gateway,
    async [Symbol.asyncDispose]() {
      await server.close();
      await core.closeAllTunnels();
      await core.drain();
      await gateway[Symbol.asyncDispose]();
      await agent[Symbol.asyncDispose]();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

Deno.test("StudioboxProvider: full Tier-A path over the assembled stack", async () => {
  await using stack = await startStack();
  const restore = installSandboxProvider(stack.provider);
  try {
    const sandbox = await Sandbox.create({ env: { GREETING: "hi" } });
    try {
      // id grammar.
      assert(
        /^sbx_loc_[0-9a-hjkmnp-z]{20}$/.test(sandbox.id),
        `id grammar: ${sandbox.id}`,
      );

      // sh: bash -c, trailing newline, per-arg escaping.
      assertEquals(await sandbox.sh`echo hello`.text(), "hello\n");
      const who = "wire world";
      assertEquals(await sandbox.sh`echo ${who}`.text(), "wire world\n");

      // sh nonzero throws SandboxCommandError; .noThrow() does not.
      await assertRejects(
        () => sandbox.sh`exit 3`.result(),
        SandboxCommandError,
      );
      assertEquals(
        (await sandbox.sh`exit 7`.noThrow().result()).status.code,
        7,
      );

      // env: SandboxOptions.env applied post-create + set/get.
      assertEquals(await sandbox.env.get("GREETING"), "hi");
      await sandbox.env.set("K", "V");
      assertEquals(await sandbox.env.get("K"), "V");
      assertEquals(await sandbox.env.get("ABSENT"), undefined);

      // fs: write + read roundtrip through Upload/Download, stat, mkdir.
      await sandbox.fs.mkdir("/home/app/d", { recursive: true });
      await sandbox.fs.writeTextFile("/home/app/d/f.txt", "file body");
      assertEquals(
        await sandbox.fs.readTextFile("/home/app/d/f.txt"),
        "file body",
      );
      const info = await sandbox.fs.stat("/home/app/d/f.txt");
      assertEquals(info.isFile, true);
      assertEquals(info.size, "file body".length);

      // fs error mapping: missing file -> Deno.errors.NotFound.
      await assertRejects(
        () => sandbox.fs.readTextFile("/home/app/nope.txt"),
        Deno.errors.NotFound,
      );

      // deno.eval + repl state.
      assertEquals(await sandbox.deno.eval<number>("40 + 2"), 42);
      const repl = await sandbox.deno.repl();
      try {
        assertEquals(await repl.eval<number>("let z = 41; z"), 41);
        assertEquals(await repl.eval<number>("z + 1"), 42);
      } finally {
        await repl.close();
      }

      // spawn: output() buffers stdout, never throws.
      const child = await sandbox.spawn("bash", {
        args: ["-c", "printf abc"],
        stdout: "piped",
      });
      const out = await child.output();
      assertEquals(out.stdoutText, "abc");
      assertEquals(out.status.code, 0);
    } finally {
      // dispose === close: idempotent teardown, later calls throw closed.
      await sandbox[Symbol.asyncDispose]();
      await sandbox.close();
      await assertRejects(
        () => sandbox.env.get("GREETING"),
        ConnectionClosedError,
      );
    }
  } finally {
    restore();
  }
});

Deno.test("StudioboxProvider: extendTimeout returns a later deadline", async () => {
  await using stack = await startStack();
  const restore = installSandboxProvider(stack.provider);
  try {
    const sandbox = await Sandbox.create({ timeout: "5m" });
    try {
      const deadline = await sandbox.extendTimeout("10m");
      assert(deadline instanceof Date, "extendTimeout resolves a Date");
      assert(
        deadline.getTime() > Date.now(),
        "the extended deadline is in the future",
      );
    } finally {
      await sandbox.close();
    }
  } finally {
    restore();
  }
});

Deno.test("StudioboxProvider: exposeHttp returns a reserved-range loopback URL and leases distinct ports", async () => {
  await using stack = await startStack();
  const restore = installSandboxProvider(stack.provider);
  try {
    const sandbox = await Sandbox.create();
    try {
      const first = await sandbox.exposeHttp({ port: 8080 });
      // The URL is a reserved-range loopback forward (40100..40199).
      const match = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(first);
      assert(match !== null, `unexpected exposeHttp url: ${first}`);
      const firstPort = Number(match[1]);
      assert(
        firstPort >= 40_100 && firstPort <= 40_199,
        `host port ${firstPort} in reserved range`,
      );
      assertEquals(first, "http://127.0.0.1:40100");

      // rootd received the install with the guest port and the leased host port
      // (the reserve-on-close / reuse lifecycle is proven deterministically in
      // the hostd control-core test, where server-side settlement is sync).
      assertEquals(stack.gateway.exposed.length, 1);
      assertEquals(stack.gateway.exposed[0].guestPort, 8080);
      assertEquals(stack.gateway.exposed[0].hostPort, 40_100);

      // A second exposeHttp on the same sandbox gets a DISTINCT host port.
      const second = await sandbox.exposeHttp({ port: 9090 });
      assertEquals(second, "http://127.0.0.1:40101");
    } finally {
      await sandbox.close();
    }
  } finally {
    restore();
  }
});

Deno.test("StudioboxProvider: exposeHttp by pid is unsupported", async () => {
  await using stack = await startStack();
  const restore = installSandboxProvider(stack.provider);
  try {
    const sandbox = await Sandbox.create();
    try {
      await assertRejects(
        () => sandbox.exposeHttp({ pid: 4321 }),
        UnsupportedFeatureError,
      );
    } finally {
      await sandbox.close();
    }
  } finally {
    restore();
  }
});

Deno.test("StudioboxProvider: kill terminates the sandbox", async () => {
  await using stack = await startStack();
  const restore = installSandboxProvider(stack.provider);
  try {
    const sandbox = await Sandbox.create();
    assertEquals(await sandbox.sh`echo up`.text(), "up\n");
    await sandbox.kill();
    await assertRejects(
      () => sandbox.env.get("X"),
      ConnectionClosedError,
    );
  } finally {
    restore();
  }
});

Deno.test("StudioboxProvider: kill after close surfaces the terminate failure", async () => {
  await using stack = await startStack();
  const restore = installSandboxProvider(stack.provider);
  try {
    const sandbox = await Sandbox.create();
    // close() drops the control connection; the authoritative terminate can
    // then no longer be delivered. kill() must NOT report false success — it
    // surfaces the failure as SandboxKillError rather than swallowing it.
    await sandbox.close();
    await assertRejects(() => sandbox.kill(), SandboxKillError);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Grammar / token validation — no live stack needed (these fail before dial)
// ---------------------------------------------------------------------------

function offlineProvider(token?: string): StudioboxProvider {
  return new StudioboxProvider({
    control: { transport: "unix", path: "/tmp/sbx-nonexistent.sock" },
    tunnel: { transport: "unix", path: "/tmp/sbx-nonexistent-t.sock" },
    ...(token === undefined ? {} : { token }),
    callTimeoutMs: 2_000,
  });
}

Deno.test("StudioboxProvider: MissingTokenError when no token is resolvable", async () => {
  const previous = Deno.env.get("STUDIOBOX_TOKEN");
  Deno.env.delete("STUDIOBOX_TOKEN");
  try {
    await assertRejects(
      () => offlineProvider().create(),
      MissingTokenError,
    );
  } finally {
    if (previous !== undefined) Deno.env.set("STUDIOBOX_TOKEN", previous);
  }
});

Deno.test("StudioboxProvider: memory grammar is validated before dial", async () => {
  // 100 bytes -> 0 MiB, below the 768 MiB floor.
  await assertRejects(
    () => offlineProvider("deadbeef").create({ memory: 100 }),
    InvalidMemoryError,
  );
});

Deno.test("StudioboxProvider: timeout grammar is validated before dial", async () => {
  await assertRejects(
    () =>
      offlineProvider("deadbeef").create({
        timeout: "30x" as unknown as `${number}s`,
      }),
    InvalidTimeoutError,
  );
});

Deno.test("StudioboxProvider: connect rejects a non-sbx_loc id", async () => {
  await assertRejects(
    () => offlineProvider("deadbeef").connect("not-a-sandbox-id"),
    ConnectionEstablishmentError,
  );
});
