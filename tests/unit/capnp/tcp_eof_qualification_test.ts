import { assert, assertEquals } from "@std/assert";
import {
  RpcWireClient,
  serveConnection,
  SessionError,
  TcpTransport,
} from "@nullstyle/capnp";
import {
  CodegenProbe,
  type CodegenProbeService,
} from "../../../src/wire/generated/codegen_probe_types.ts";

const TIMEOUT_MS = 2_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

Deno.test("real WASM TCP EOF rejects a pending generated call when transport close is wired to the client", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  const accept = listener.accept();
  const clientConn = await Deno.connect({
    hostname: "127.0.0.1",
    port: address.port,
  });
  const serverConn = await accept;
  listener.close();

  const handlerStarted = deferred<void>();
  const releaseHandler = deferred<void>();
  const serverTransport = new TcpTransport(serverConn, {
    closeTimeoutMs: TIMEOUT_MS,
  });
  let wireClient: RpcWireClient | null = null;
  const clientTransport = new TcpTransport(clientConn, {
    closeTimeoutMs: TIMEOUT_MS,
    onClose: () => wireClient?.close(),
  });

  const service: CodegenProbeService = {
    async ping(nonce) {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return { nonce, acceptedChunks: 0n };
    },
    chunk() {},
  };
  const handle = await serveConnection(
    CodegenProbe,
    {
      transport: serverTransport,
      localAddress: { transport: "tcp" },
      remoteAddress: { transport: "tcp" },
      id: "studiobox-codegen-probe-eof",
    },
    service,
  );

  try {
    assertEquals(handle.runtime.peer.abi.capabilities.abiVersion, 1);
    wireClient = new RpcWireClient(clientTransport, {
      defaultTimeoutMs: 10_000,
    });
    const client = await CodegenProbe.bootstrapClient(wireClient, {
      timeoutMs: TIMEOUT_MS,
    });
    const pending = client.ping(77n, { timeoutMs: 10_000 }).then(
      () => null,
      (error: unknown) => error,
    );

    await withTimeout(handlerStarted.promise, TIMEOUT_MS, "probe handler");
    await waitFor(
      () => wireClient?.stats.pendingReturns === 1,
      TIMEOUT_MS,
      "pending wire return",
    );

    // Closing the server socket produces a real TCP EOF at the client. The
    // transport's onClose callback owns the RpcWireClient teardown contract.
    await serverTransport.close();
    const rejected = await withTimeout(pending, TIMEOUT_MS, "pending call");

    assert(
      rejected instanceof SessionError && /closed/i.test(rejected.message),
      `expected a closed SessionError, got ${String(rejected)}`,
    );
    await waitFor(
      () => wireClient?.stats.closed === true,
      TIMEOUT_MS,
      "wire client close",
    );
    assertEquals(wireClient.stats.pendingReturns, 0);
    assertEquals(wireClient.stats.exportedCapabilities, 0);
    assertEquals(clientTransport.stats.closed, true);
  } finally {
    releaseHandler.resolve();
    await wireClient?.close().catch(() => {});
    await withTimeout(handle.close(), TIMEOUT_MS, "server runtime close");
    await serverTransport.close().catch(() => {});
    await clientTransport.close().catch(() => {});
  }
});
