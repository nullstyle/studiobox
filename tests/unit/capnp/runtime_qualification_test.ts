import { assert, assertEquals } from "@std/assert";
import {
  connect,
  InMemoryRpcHarnessTransport,
  MessagePortTransport,
  RpcServerRuntime,
  type RpcServerRuntimeRootRegistrationOptions,
  type RpcStub,
  serveConnection,
  SessionError,
  SessionRpcClientTransport,
} from "@nullstyle/capnp";
import {
  CodegenProbe,
  type CodegenProbe as CodegenProbeClient,
  CodegenProbeInterfaceId,
  type CodegenProbeService,
  createCodegenProbeChunkStreamSender,
} from "../../../src/wire/generated/mod.ts";

const CALL_TIMEOUT_MS = 2_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function createMessagePortPair(): {
  clientTransport: MessagePortTransport;
  serverTransport: MessagePortTransport;
  accepted: {
    transport: MessagePortTransport;
    localAddress: { transport: string };
    remoteAddress: { transport: string };
    id: string;
  };
} {
  const channel = new MessageChannel();
  const serverTransport = new MessagePortTransport(channel.port1, {
    closePortOnClose: true,
    maxInboundFrameBytes: 1024 * 1024,
    maxOutboundFrameBytes: 1024 * 1024,
    maxQueuedOutboundFrames: 128,
    maxQueuedOutboundBytes: 4 * 1024 * 1024,
    sendTimeoutMs: CALL_TIMEOUT_MS,
  });
  const clientTransport = new MessagePortTransport(channel.port2, {
    closePortOnClose: true,
    maxInboundFrameBytes: 1024 * 1024,
    maxOutboundFrameBytes: 1024 * 1024,
    maxQueuedOutboundFrames: 128,
    maxQueuedOutboundBytes: 4 * 1024 * 1024,
    sendTimeoutMs: CALL_TIMEOUT_MS,
  });

  return {
    clientTransport,
    serverTransport,
    accepted: {
      transport: serverTransport,
      localAddress: { transport: "messageport" },
      remoteAddress: { transport: "messageport" },
      id: "studiobox-codegen-probe",
    },
  };
}

Deno.test("real WASM CodegenProbe handles concurrent unary calls and bounded streaming without ambient permissions", async () => {
  const { clientTransport, serverTransport, accepted } =
    createMessagePortPair();
  let client: RpcStub<CodegenProbeClient> | null = null;
  const pingNonces = new Set<bigint>();
  const chunks: Array<{ sequence: bigint; data: Uint8Array }> = [];
  let activeChunks = 0;
  let maxActiveChunks = 0;

  const service: CodegenProbeService = {
    ping(nonce) {
      pingNonces.add(nonce);
      return {
        nonce,
        acceptedChunks: BigInt(chunks.length),
      };
    },
    async chunk(params, ctx) {
      assertEquals(ctx.signal.aborted, false);
      activeChunks++;
      maxActiveChunks = Math.max(maxActiveChunks, activeChunks);
      try {
        chunks.push({
          sequence: params.sequence,
          data: new Uint8Array(params.data),
        });
        await Promise.resolve();
      } finally {
        activeChunks--;
      }
    },
  };

  const handle = await serveConnection(CodegenProbe, accepted, service);

  try {
    // The service runtime factory imports the committed capnp_deno.wasm module.
    // These feature assertions distinguish the production runtime from the
    // fake-WASM fixtures used by capnp-deno's unit tests.
    const capabilities = handle.runtime.peer.abi.capabilities;
    assertEquals(capabilities.abiVersion, 1);
    assertEquals(capabilities.hasHostCallBridge, true);
    assertEquals(capabilities.hasHostCallReturnFrame, true);
    assertEquals(capabilities.hasLifecycleHelpers, true);

    client = await connect(CodegenProbe, clientTransport, {
      defaultTimeoutMs: CALL_TIMEOUT_MS,
    });

    const unaryCount = 50;
    const unaryResults = await Promise.all(
      Array.from(
        { length: unaryCount },
        (_, index) =>
          client!.ping(BigInt(index), {
            timeoutMs: CALL_TIMEOUT_MS,
          }),
      ),
    );

    assertEquals(pingNonces.size, unaryCount);
    assertEquals(
      unaryResults.map((result) => result.nonce),
      Array.from({ length: unaryCount }, (_, index) => BigInt(index)),
    );
    assert(
      unaryResults.every((result) => result.acceptedChunks === 0n),
      "unary responses should observe the pre-stream state",
    );

    const streamWindow = 4;
    const streamCount = 24;
    const sender = createCodegenProbeChunkStreamSender(client, {
      maxInFlight: streamWindow,
      call: { timeoutMs: CALL_TIMEOUT_MS },
    });
    let maxObservedClientInFlight = 0;

    for (let index = 0; index < streamCount; index++) {
      await sender.send({
        sequence: BigInt(index),
        data: new Uint8Array([index, index ^ 0xff]),
      });
      maxObservedClientInFlight = Math.max(
        maxObservedClientInFlight,
        sender.inFlight,
      );
      assert(
        sender.inFlight <= streamWindow,
        `stream sender exceeded its ${streamWindow}-call window`,
      );
    }
    await sender.flush();

    assertEquals(sender.maxInFlight, streamWindow);
    assertEquals(sender.inFlight, 0);
    assertEquals(sender.totalSent, streamCount);
    assertEquals(sender.totalReceived, streamCount);
    assert(maxObservedClientInFlight > 1);
    assertEquals(maxActiveChunks, 1);
    assertEquals(
      chunks.map((chunk) => chunk.sequence),
      Array.from({ length: streamCount }, (_, index) => BigInt(index)),
    );
    assertEquals(
      chunks.map((chunk) => Array.from(chunk.data)),
      Array.from(
        { length: streamCount },
        (_, index) => [index, index ^ 0xff],
      ),
    );

    const final = await client.ping(999n, { timeoutMs: CALL_TIMEOUT_MS });
    assertEquals(final, {
      nonce: 999n,
      acceptedChunks: BigInt(streamCount),
    });
  } finally {
    await client?.close().catch(() => {});
    await Promise.resolve(clientTransport.close()).catch(() => {});
    await handle.close();
    await Promise.resolve(serverTransport.close()).catch(() => {});
  }
});

Deno.test("real WASM session close rejects a pending generated call and releases client waiters", async () => {
  const transport = new InMemoryRpcHarnessTransport();
  const handlerStarted = deferred<void>();
  const releaseHandler = deferred<void>();

  const service: CodegenProbeService = {
    async ping(nonce) {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return { nonce, acceptedChunks: 0n };
    },
    chunk() {},
  };

  const runtime = await RpcServerRuntime.createWithRoot(
    transport,
    (
      registry,
      server,
      options?: RpcServerRuntimeRootRegistrationOptions,
    ) => CodegenProbe.registerServer(registry, server, options),
    service,
    { autoStart: true },
  );
  const clientTransport = new SessionRpcClientTransport(
    runtime.session,
    transport,
    {
      interfaceId: CodegenProbeInterfaceId,
      autoStart: false,
      defaultTimeoutMs: 10_000,
    },
  );

  try {
    assertEquals(runtime.peer.abi.capabilities.abiVersion, 1);
    const client = await CodegenProbe.bootstrapClient(clientTransport, {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    const pending = client.ping(42n, { timeoutMs: 10_000 }).then(
      () => null,
      (error: unknown) => error,
    );

    await withTimeout(handlerStarted.promise, CALL_TIMEOUT_MS, "probe handler");
    await waitFor(
      () => clientTransport.stats.pendingReturns === 1,
      CALL_TIMEOUT_MS,
      "pending return waiter",
    );
    assertEquals(clientTransport.stats.expectedReturns, 1);
    assertEquals(clientTransport.stats.pendingReturns, 1);
    assertEquals(clientTransport.stats.responsePumpActive, true);

    await withTimeout(
      clientTransport.close(),
      CALL_TIMEOUT_MS,
      "client transport close",
    );

    const rejected = await pending;
    assert(
      rejected instanceof SessionError && /closed/i.test(rejected.message),
      `expected a closed SessionError, got ${String(rejected)}`,
    );
    assertEquals(clientTransport.stats.closed, true);
    assertEquals(clientTransport.stats.sessionClosed, true);
    assertEquals(clientTransport.stats.expectedReturns, 0);
    assertEquals(clientTransport.stats.pendingReturns, 0);
    assertEquals(clientTransport.stats.queuedReturns, 0);
    assertEquals(clientTransport.stats.exportedCapabilities, 0);
    assertEquals(clientTransport.stats.responsePumpActive, false);
  } finally {
    releaseHandler.resolve();
    await withTimeout(runtime.close(), CALL_TIMEOUT_MS, "runtime close");
  }
});
