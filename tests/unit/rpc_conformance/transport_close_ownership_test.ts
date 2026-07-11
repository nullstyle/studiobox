// M1 foundation qualification — transport close/EOF ownership conformance.
//
// Exercises the PUBLISHED jsr:@nullstyle/capnp runtime's `TcpTransport`
// wrapping real `Deno.Conn` sockets over both tcp (127.0.0.1) and
// unix-domain sockets, with the generated CodegenProbe bindings carrying a
// live call in flight. The vsock leg of PLAN M1 gate 3 is deferred to M5's
// real-guest integration: AF_VSOCK conns are Linux-only (and behind
// --unstable-vsock on Deno 2.9), but they surface as the same structural
// `Deno.Conn`, so these tcp/UDS conformance results are the contract they
// must match. Behaviors under test:
//
//   (a) server closes mid-call  -> in-flight client call rejects with a typed
//       error (SessionError), promptly, when the transport's onClose hook is
//       wired to the wire-client/stub close (the documented ownership
//       contract). Without that wiring the in-flight call stays pending —
//       that ownership fact is pinned by its own test below.
//   (b) client transport close  -> server session ends and the package's own
//       serve() accept loop stays healthy for subsequent connections.
//   (c) clean EOF settles the transport promptly through onClose with no
//       error; peer-disconnect errors (RST and friends) are normalized onto
//       the same EOF path, so the two are NOT distinguishable through the
//       published API. Destroying the conn out from under the transport is
//       different: only onError observes it and the transport is left
//       half-open (onClose never fires, stats.closed stays false) until an
//       explicit close() — pinned below; see the M1 close-ownership notes.
//   (d) double-close is safe at every layer (transport, wire client, server
//       connection handle), sequentially and concurrently.
//   (e) disposing the client stub and the server handle releases the
//       underlying conns — proven by Deno's resource sanitizer, which stays
//       enabled for every test in this file.
//   (f) dialing a listener that accepts then immediately closes fails
//       promptly with a typed error under the onClose-wiring contract; the
//       high-level connect() helper instead waits out its own bootstrap
//       timeout (pinned below as a documented limitation).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  connect,
  type RpcAcceptedTransport,
  type RpcStub,
  RpcWireClient,
  serve,
  serveConnection,
  SessionError,
  TcpTransport,
  TransportError,
} from "@nullstyle/capnp";
import {
  CodegenProbe,
  type CodegenProbe as CodegenProbeClient,
  type CodegenProbeService,
} from "../../../src/wire/generated/mod.ts";

const TIMEOUT_MS = 2_000;
// Long enough that any prompt settlement observed below is attributable to
// close/EOF propagation rather than the per-call timeout.
const HUNG_CALL_TIMEOUT_MS = 30_000;

type SocketKind = "tcp" | "unix";
const SOCKET_KINDS: readonly SocketKind[] = ["tcp", "unix"];

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

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function closeQuietly(closable: { close(): void }): void {
  try {
    closable.close();
  } catch {
    // Already closed; double-close of raw resources is not under test here.
  }
}

/**
 * Deno 2.9 gates unix sockets behind `--allow-net=unix:<absolute path>` with
 * exact-path matching (no prefixes, no relative paths), so the socket path
 * must be a fixed constant. It has to stay in sync with the `test:unit`
 * task's `--allow-net` grant in deno.json. Unit tests execute serially, so
 * one path is safe to reuse; every user removes any stale file before
 * binding and cleans up after itself.
 */
const UDS_PATH = "/tmp/studiobox-unit-uds.sock";

async function removeUdsFile(): Promise<void> {
  await Deno.remove(UDS_PATH).catch(() => {});
}

interface ConnPair {
  readonly clientConn: Deno.Conn;
  readonly serverConn: Deno.Conn;
  cleanup(): Promise<void>;
}

async function makeConnPair(kind: SocketKind): Promise<ConnPair> {
  if (kind === "tcp") {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const accept = listener.accept();
    const clientConn = await Deno.connect({
      hostname: "127.0.0.1",
      port: (listener.addr as Deno.NetAddr).port,
    });
    const serverConn = await accept;
    listener.close();
    return { clientConn, serverConn, cleanup: () => Promise.resolve() };
  }
  await removeUdsFile();
  const listener = Deno.listen({ transport: "unix", path: UDS_PATH });
  const accept = listener.accept();
  const clientConn = await Deno.connect({ transport: "unix", path: UDS_PATH });
  const serverConn = await accept;
  listener.close();
  return { clientConn, serverConn, cleanup: removeUdsFile };
}

function gatedProbeService(): {
  service: CodegenProbeService;
  handlerStarted: Deferred<void>;
  releaseHandler: Deferred<void>;
} {
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
  return { service, handlerStarted, releaseHandler };
}

function echoProbeService(): CodegenProbeService {
  return {
    ping(nonce) {
      return { nonce, acceptedChunks: 0n };
    },
    chunk() {},
  };
}

function acceptedFor(
  transport: TcpTransport,
  kind: SocketKind,
  id: string,
): RpcAcceptedTransport {
  return {
    transport,
    localAddress: { transport: kind },
    remoteAddress: { transport: kind },
    id,
  };
}

// ---------------------------------------------------------------------------
// (a) server closes mid-call -> typed, prompt rejection under wired onClose
// ---------------------------------------------------------------------------

for (const kind of SOCKET_KINDS) {
  Deno.test(`(${kind}) server close mid-call rejects the in-flight call with SessionError when onClose is wired to stub close`, async () => {
    const pair = await makeConnPair(kind);
    const { service, handlerStarted, releaseHandler } = gatedProbeService();
    const serverTransport = new TcpTransport(pair.serverConn, {
      closeTimeoutMs: TIMEOUT_MS,
    });
    let stub: RpcStub<CodegenProbeClient> | null = null;
    const clientTransport = new TcpTransport(pair.clientConn, {
      closeTimeoutMs: TIMEOUT_MS,
      // The ownership contract: the transport observes EOF, the owner closes
      // the client. Nothing rejects the in-flight call otherwise.
      onClose: () => void stub?.close().catch(() => {}),
    });
    const handle = await serveConnection(
      CodegenProbe,
      acceptedFor(serverTransport, kind, `close-mid-call-${kind}`),
      service,
    );

    try {
      stub = await connect(CodegenProbe, clientTransport, {
        defaultTimeoutMs: TIMEOUT_MS,
        bootstrap: { timeoutMs: TIMEOUT_MS },
      });
      const pending = stub.ping(7n, { timeoutMs: HUNG_CALL_TIMEOUT_MS }).then(
        () => null,
        (error: unknown) => error,
      );
      await withTimeout(handlerStarted.promise, TIMEOUT_MS, "handler start");

      await serverTransport.close();

      const rejected = await withTimeout(
        pending,
        TIMEOUT_MS,
        "in-flight call settlement after server close",
      );
      assert(
        rejected instanceof SessionError,
        `expected SessionError, got ${String(rejected)}`,
      );
      assert(
        /closed/i.test(rejected.message),
        `expected a closed-session message, got: ${rejected.message}`,
      );
      await waitFor(
        () => clientTransport.stats.closed,
        TIMEOUT_MS,
        "client transport closed after server EOF",
      );
    } finally {
      releaseHandler.resolve();
      await stub?.close().catch(() => {});
      await withTimeout(handle.close(), TIMEOUT_MS, "server handle close");
      await serverTransport.close().catch(() => {});
      await clientTransport.close().catch(() => {});
      await pair.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// (a, ownership pin) remote EOF alone does NOT settle an in-flight call
// ---------------------------------------------------------------------------

Deno.test("(tcp) remote EOF without onClose wiring leaves the in-flight call pending until the owner closes the wire client", async () => {
  const pair = await makeConnPair("tcp");
  const { service, handlerStarted, releaseHandler } = gatedProbeService();
  const serverTransport = new TcpTransport(pair.serverConn, {
    closeTimeoutMs: TIMEOUT_MS,
  });
  // Deliberately NO onClose wiring: this pins the published ownership
  // contract — TcpTransport does not propagate EOF into RpcWireClient.
  const clientTransport = new TcpTransport(pair.clientConn, {
    closeTimeoutMs: TIMEOUT_MS,
  });
  const wireClient = new RpcWireClient(clientTransport, {
    defaultTimeoutMs: HUNG_CALL_TIMEOUT_MS,
  });
  const handle = await serveConnection(
    CodegenProbe,
    acceptedFor(serverTransport, "tcp", "eof-unwired"),
    service,
  );

  try {
    const client = await CodegenProbe.bootstrapClient(wireClient, {
      timeoutMs: TIMEOUT_MS,
    });
    let settled = false;
    const pending = client.ping(11n, { timeoutMs: HUNG_CALL_TIMEOUT_MS }).then(
      () => null,
      (error: unknown) => error,
    );
    void pending.then(() => {
      settled = true;
    });
    await withTimeout(handlerStarted.promise, TIMEOUT_MS, "handler start");
    assertEquals(wireClient.stats.pendingReturns, 1);

    await serverTransport.close();
    await waitFor(
      () => clientTransport.stats.closed,
      TIMEOUT_MS,
      "client transport observes EOF",
    );
    // Give the runtime every opportunity to (incorrectly) auto-settle.
    await delay(100);
    assertEquals(
      settled,
      false,
      "in-flight call must remain pending on bare EOF — settling here means upstream changed close ownership semantics",
    );
    assertEquals(wireClient.stats.pendingReturns, 1);

    // New calls after EOF still fail fast and typed (send hits the closed
    // transport), so only the already-in-flight wait is ownership-bound.
    const afterEof = await withTimeout(
      client.ping(12n, { timeoutMs: HUNG_CALL_TIMEOUT_MS }).then(
        () => null,
        (error: unknown) => error,
      ),
      TIMEOUT_MS,
      "post-EOF call settlement",
    );
    assert(
      afterEof instanceof TransportError,
      `expected TransportError for a post-EOF send, got ${String(afterEof)}`,
    );

    // The owner closes; the pending call now rejects deterministically.
    await wireClient.close();
    const rejected = await withTimeout(
      pending,
      TIMEOUT_MS,
      "pending call settlement after owner close",
    );
    assert(
      rejected instanceof SessionError && /closed/i.test(rejected.message),
      `expected a closed SessionError, got ${String(rejected)}`,
    );
    assertEquals(wireClient.stats.pendingReturns, 0);
  } finally {
    releaseHandler.resolve();
    await wireClient.close().catch(() => {});
    await withTimeout(handle.close(), TIMEOUT_MS, "server handle close");
    await serverTransport.close().catch(() => {});
    await clientTransport.close().catch(() => {});
    await pair.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) client close ends the server session; the accept loop stays healthy
// ---------------------------------------------------------------------------

type AcceptSource = Parameters<typeof serve>[1];

class UnixAcceptSource implements AcceptSource {
  readonly #listener: Deno.Listener;
  readonly #path: string;
  #closed = false;
  #nextId = 0;

  constructor(path: string) {
    this.#path = path;
    this.#listener = Deno.listen({ transport: "unix", path });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *accept(): AsyncIterable<RpcAcceptedTransport> {
    while (!this.#closed) {
      let conn: Deno.Conn;
      try {
        conn = await this.#listener.accept();
      } catch (error) {
        if (this.#closed) return;
        throw error;
      }
      yield {
        transport: new TcpTransport(conn, { closeTimeoutMs: TIMEOUT_MS }),
        localAddress: { transport: "unix", path: this.#path },
        remoteAddress: { transport: "unix" },
        id: `uds-accept-${this.#nextId++}`,
      };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeQuietly(this.#listener);
  }
}

for (const kind of SOCKET_KINDS) {
  Deno.test(`(${kind}) client transport close ends the server session and serve()'s accept loop keeps serving new conns`, async () => {
    let acceptor: AcceptSource;
    let dial: () => Promise<Deno.Conn>;
    let cleanup: () => Promise<void> = () => Promise.resolve();

    if (kind === "tcp") {
      const listener = TcpTransport.listen({
        hostname: "127.0.0.1",
        port: 0,
        transportOptions: { closeTimeoutMs: TIMEOUT_MS },
      });
      const port = (listener.addr as Deno.NetAddr).port;
      acceptor = listener;
      dial = () => Deno.connect({ hostname: "127.0.0.1", port });
    } else {
      await removeUdsFile();
      acceptor = new UnixAcceptSource(UDS_PATH);
      dial = () => Deno.connect({ transport: "unix", path: UDS_PATH });
      cleanup = removeUdsFile;
    }

    const serviceHandle = serve(CodegenProbe, acceptor, echoProbeService());
    const openTransports: TcpTransport[] = [];
    const openStubs: RpcStub<CodegenProbeClient>[] = [];

    try {
      const transportA = new TcpTransport(await dial(), {
        closeTimeoutMs: TIMEOUT_MS,
      });
      openTransports.push(transportA);
      const stubA = await connect(CodegenProbe, transportA, {
        defaultTimeoutMs: TIMEOUT_MS,
        bootstrap: { timeoutMs: TIMEOUT_MS },
      });
      openStubs.push(stubA);
      await waitFor(
        () => serviceHandle.stats.activeConnections === 1,
        TIMEOUT_MS,
        "first connection active",
      );
      assertEquals((await stubA.ping(1n, { timeoutMs: TIMEOUT_MS })).nonce, 1n);

      // Client-side close: stub close tears down the wire client, which
      // closes the transport and sends EOF to the server.
      await stubA.close();
      await waitFor(
        () => serviceHandle.stats.activeConnections === 0,
        TIMEOUT_MS,
        "server session ended after client close",
      );

      // The accept loop must remain healthy for a second connection.
      const transportB = new TcpTransport(await dial(), {
        closeTimeoutMs: TIMEOUT_MS,
      });
      openTransports.push(transportB);
      const stubB = await connect(CodegenProbe, transportB, {
        defaultTimeoutMs: TIMEOUT_MS,
        bootstrap: { timeoutMs: TIMEOUT_MS },
      });
      openStubs.push(stubB);
      assertEquals((await stubB.ping(2n, { timeoutMs: TIMEOUT_MS })).nonce, 2n);
      await stubB.close();

      assertEquals(serviceHandle.stats.acceptedConnections, 2);
      assertEquals(serviceHandle.stats.failedConnections, 0);
      assertEquals(serviceHandle.stats.refusedConnections, 0);
    } finally {
      for (const stub of openStubs) await stub.close().catch(() => {});
      for (const transport of openTransports) {
        await transport.close().catch(() => {});
      }
      await withTimeout(serviceHandle.close(), TIMEOUT_MS, "service close");
      await Promise.resolve(acceptor.close()).catch(() => {});
      await cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// (c) clean EOF vs abortive close: both settle promptly; not distinguishable
// ---------------------------------------------------------------------------

for (const kind of SOCKET_KINDS) {
  Deno.test(`(${kind}) clean EOF from the peer settles the transport promptly and surfaces no error`, async () => {
    const pair = await makeConnPair(kind);
    const closed = deferred<void>();
    let observedError: unknown = null;
    const local = new TcpTransport(pair.clientConn, {
      closeTimeoutMs: TIMEOUT_MS,
      onClose: () => closed.resolve(),
      onError: (error) => {
        observedError = error;
      },
    });
    const peer = new TcpTransport(pair.serverConn, {
      closeTimeoutMs: TIMEOUT_MS,
    });
    local.start(() => {});
    peer.start(() => {});

    try {
      await peer.close();
      await withTimeout(closed.promise, TIMEOUT_MS, "onClose after clean EOF");
      assertEquals(local.stats.closed, true);
      assertEquals(
        observedError,
        null,
        "clean EOF must not surface through onError",
      );
      await assertRejects(
        () => local.send(new Uint8Array(8)),
        TransportError,
      );
      // Local close after remote EOF is safe and idempotent.
      await local.close();
    } finally {
      await local.close().catch(() => {});
      await peer.close().catch(() => {});
      await pair.cleanup();
    }
  });

  Deno.test(`(${kind}) destroying the conn out from under the transport surfaces onError only and leaves it half-open until close()`, async () => {
    const pair = await makeConnPair(kind);
    let onCloseFired = false;
    let observedError: unknown = null;
    const local = new TcpTransport(pair.clientConn, {
      closeTimeoutMs: TIMEOUT_MS,
      onClose: () => {
        onCloseFired = true;
      },
      // Without this handler the read-loop failure escapes as a GLOBAL
      // unhandled rejection (verified against 0.1.0; see the M1
      // close-ownership notes) — which is exactly why this suite pins the
      // onError-wired variant.
      onError: (error) => {
        observedError = error;
      },
    });
    local.start(() => {});

    try {
      // Destroy the conn out from under the transport. The in-flight read
      // rejects with `Interrupted: operation canceled`, which the published
      // transport does NOT normalize onto its EOF path.
      pair.clientConn.close();
      await waitFor(
        () => observedError !== null,
        TIMEOUT_MS,
        "onError after conn destruction",
      );
      assert(
        observedError instanceof TransportError,
        `expected TransportError, got ${String(observedError)}`,
      );
      // Pinned upstream behavior: the transport stays half-open — onClose
      // does not fire and stats.closed remains false even though the read
      // loop is permanently dead. Only an explicit close() transitions it.
      await delay(50);
      assertEquals(onCloseFired, false);
      assertEquals(local.stats.closed, false);
      // Sends still fail promptly and typed, so nothing hangs.
      await assertRejects(
        () => local.send(new Uint8Array(8)),
        TransportError,
      );
      // Explicit close() recovers the lifecycle: onClose fires exactly once.
      await local.close();
      assertEquals(onCloseFired, true);
      assertEquals(local.stats.closed, true);
    } finally {
      await local.close().catch(() => {});
      closeQuietly(pair.serverConn);
      await pair.cleanup();
    }
  });
}

Deno.test("(tcp) peer close with unread inbound data (RST-prone) still settles the transport promptly", async () => {
  const pair = await makeConnPair("tcp");
  const closed = deferred<void>();
  const local = new TcpTransport(pair.clientConn, {
    closeTimeoutMs: TIMEOUT_MS,
    onClose: () => closed.resolve(),
    onError: () => {},
  });
  local.start(() => {});

  try {
    // Leave bytes unread in the peer's receive queue, then close it. On
    // most stacks this produces RST rather than FIN; either way the local
    // transport must settle without hanging.
    await local.send(new Uint8Array(64));
    pair.serverConn.close();
    await withTimeout(
      closed.promise,
      TIMEOUT_MS,
      "onClose after peer close with unread data",
    );
    assertEquals(local.stats.closed, true);
  } finally {
    await local.close().catch(() => {});
    closeQuietly(pair.serverConn);
    await pair.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) double-close is safe at every layer
// ---------------------------------------------------------------------------

for (const kind of SOCKET_KINDS) {
  Deno.test(`(${kind}) double-close is safe across transport, wire client, and server handle`, async () => {
    const pair = await makeConnPair(kind);
    const serverTransport = new TcpTransport(pair.serverConn, {
      closeTimeoutMs: TIMEOUT_MS,
    });
    const clientTransport = new TcpTransport(pair.clientConn, {
      closeTimeoutMs: TIMEOUT_MS,
    });
    const handle = await serveConnection(
      CodegenProbe,
      acceptedFor(serverTransport, kind, `double-close-${kind}`),
      echoProbeService(),
    );
    const wireClient = new RpcWireClient(clientTransport, {
      defaultTimeoutMs: TIMEOUT_MS,
    });

    try {
      const client = await CodegenProbe.bootstrapClient(wireClient, {
        timeoutMs: TIMEOUT_MS,
      });
      assertEquals(
        (await client.ping(5n, { timeoutMs: TIMEOUT_MS })).nonce,
        5n,
      );

      // Concurrent double-close on the client side, mixing layers.
      await Promise.all([
        wireClient.close(),
        wireClient.close(),
        clientTransport.close(),
        clientTransport.close(),
      ]);
      // Concurrent double-close on the server transport, then the handle.
      await Promise.all([serverTransport.close(), serverTransport.close()]);
      await handle.close();
      await handle.close();
      // Late sequential closes after everything is down.
      await wireClient.close();
      await clientTransport.close();
      await serverTransport.close();

      assertEquals(clientTransport.stats.closed, true);
      assertEquals(serverTransport.stats.closed, true);
      assertEquals(wireClient.stats.closed, true);
      assertEquals(handle.closed, true);
    } finally {
      await wireClient.close().catch(() => {});
      await handle.close().catch(() => {});
      await pair.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// (e) disposing the session releases the underlying conns (sanitizer proof)
// ---------------------------------------------------------------------------

for (const kind of SOCKET_KINDS) {
  Deno.test(`(${kind}) closing the stub and server handle releases the underlying conns`, async () => {
    const pair = await makeConnPair(kind);
    const serverTransport = new TcpTransport(pair.serverConn, {
      closeTimeoutMs: TIMEOUT_MS,
    });
    const clientTransport = new TcpTransport(pair.clientConn, {
      closeTimeoutMs: TIMEOUT_MS,
    });
    const handle = await serveConnection(
      CodegenProbe,
      acceptedFor(serverTransport, kind, `dispose-${kind}`),
      echoProbeService(),
    );
    const stub = await connect(CodegenProbe, clientTransport, {
      defaultTimeoutMs: TIMEOUT_MS,
      bootstrap: { timeoutMs: TIMEOUT_MS },
    });

    assertEquals((await stub.ping(3n, { timeoutMs: TIMEOUT_MS })).nonce, 3n);

    // Only the session-level disposals below touch the raw conns. Deno's
    // resource sanitizer fails this test if either conn leaks.
    await stub.close();
    await withTimeout(handle.close(), TIMEOUT_MS, "server handle close");
    assertEquals(clientTransport.stats.closed, true);
    assertEquals(serverTransport.stats.closed, true);
    await pair.cleanup();
  });
}

// ---------------------------------------------------------------------------
// (f) dial to an accept-then-immediately-close listener fails promptly
// ---------------------------------------------------------------------------

for (const kind of SOCKET_KINDS) {
  Deno.test(`(${kind}) dialing a listener that accepts then immediately closes fails promptly with a typed error`, async () => {
    let listener: Deno.Listener;
    let dial: () => Promise<Deno.Conn>;
    let cleanup: () => Promise<void> = () => Promise.resolve();

    if (kind === "tcp") {
      const tcpListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (tcpListener.addr as Deno.NetAddr).port;
      listener = tcpListener;
      dial = () => Deno.connect({ hostname: "127.0.0.1", port });
    } else {
      await removeUdsFile();
      listener = Deno.listen({ transport: "unix", path: UDS_PATH });
      dial = () => Deno.connect({ transport: "unix", path: UDS_PATH });
      cleanup = removeUdsFile;
    }

    const acceptAndClose = (async () => {
      const conn = await listener.accept();
      conn.close();
      listener.close();
    })();

    let wireClient: RpcWireClient | null = null;
    const conn = await dial();
    const transport = new TcpTransport(conn, {
      closeTimeoutMs: TIMEOUT_MS,
      onClose: () => void wireClient?.close().catch(() => {}),
    });
    wireClient = new RpcWireClient(transport, {
      defaultTimeoutMs: HUNG_CALL_TIMEOUT_MS,
    });

    try {
      const outcome = await withTimeout(
        CodegenProbe.bootstrapClient(wireClient, {
          timeoutMs: HUNG_CALL_TIMEOUT_MS,
        }).then(
          () => null,
          (error: unknown) => error,
        ),
        TIMEOUT_MS,
        "bootstrap settlement against an accept-then-close listener",
      );
      // Two prompt, typed settlement paths race here: if the EOF is observed
      // first, the wired onClose closes the wire client and the bootstrap
      // rejects with SessionError; if the bootstrap write loses the race
      // against the peer's close (common on unix sockets), the send itself
      // rejects with TransportError (broken pipe). Either way the dial fails
      // promptly with a typed CapnpError subclass — never a hang.
      assert(
        (outcome instanceof SessionError && /closed/i.test(outcome.message)) ||
          outcome instanceof TransportError,
        `expected a closed SessionError or a TransportError, got ${
          String(outcome)
        }`,
      );
      await acceptAndClose;
    } finally {
      await wireClient.close().catch(() => {});
      await transport.close().catch(() => {});
      closeQuietly(listener);
      await cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// (f, gap pin) the high-level connect() helper cannot observe transport EOF
// during bootstrap; only its own timeout or signal settles the dial
// ---------------------------------------------------------------------------

Deno.test("(tcp) connect() against an accept-then-close listener settles only via its bootstrap timeout, not the observed EOF", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const acceptAndClose = (async () => {
    const conn = await listener.accept();
    conn.close();
    listener.close();
  })();

  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  // connect() constructs its internal RpcWireClient, so there is nothing an
  // onClose hook here could close — the EOF cannot be propagated by the
  // caller. This pins that limitation.
  const transport = new TcpTransport(conn, { closeTimeoutMs: TIMEOUT_MS });
  const bootstrapTimeoutMs = 500;
  const startedAt = performance.now();

  try {
    const pendingDial = connect(CodegenProbe, transport, {
      defaultTimeoutMs: TIMEOUT_MS,
      bootstrap: { timeoutMs: bootstrapTimeoutMs },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // The transport observes the EOF almost immediately...
    await waitFor(
      () => transport.stats.closed,
      TIMEOUT_MS,
      "transport observes EOF",
    );
    const eofObservedAt = performance.now();

    // ...but the dial keeps waiting for its own bootstrap timeout.
    const outcome = await withTimeout(
      pendingDial,
      TIMEOUT_MS,
      "connect() settlement",
    );
    const settledAt = performance.now();

    assert(
      outcome instanceof SessionError && /timed out/i.test(outcome.message),
      `expected a bootstrap timeout SessionError, got ${String(outcome)}`,
    );
    assert(
      settledAt - startedAt >= bootstrapTimeoutMs - 50,
      `connect() settled after ${
        Math.round(settledAt - startedAt)
      }ms — earlier than its ${bootstrapTimeoutMs}ms bootstrap timeout, meaning upstream now propagates EOF into connect(); update the close-ownership notes`,
    );
    assert(
      eofObservedAt - startedAt < settledAt - startedAt,
      "EOF should be observed before the bootstrap timeout fires",
    );
    await acceptAndClose;
  } finally {
    await transport.close().catch(() => {});
    closeQuietly(listener);
  }
});
