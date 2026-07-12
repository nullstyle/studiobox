// Cross-file codegen qualification round trip, adopted with capnp 0.2.0.
//
// Under 0.1.0 this file proved the PUBLISHED runtime handled the cross-file
// composite wire shape through HAND-BUILT descriptors, isolating the gap to
// the emitter (cross-file references were lowered to TYPE_ANY_POINTER; see
// the historical inventory in compat/wire.json `codegen.blockerNote`).
// capnp-deno 0.2.0 fixed cross-file lowering and namespaced the barrel, so
// these tests now exercise the REAL generated modules end to end:
//
//   1. host_control's `KillResults` wrapper (`kill @6 () ->
//      (result :Common.EmptyResult)`) round-trips through the generated
//      `hostControl.KillResultsCodec`, whose descriptor references
//      common.capnp's `EmptyResult`/`SbxError` via real cross-file imports —
//      both union arms, against the published jsr:@nullstyle/capnp runtime.
//   2. A generated-interface client/server ping (`HostControl.ping`) runs
//      over an in-process MessagePort transport pair, proving the generated
//      service token bootstrap/dispatch path against the published runtime.
//
// Both legs import through the NAMESPACED src/wire/generated/mod.ts barrel
// (`export * as hostControl`, `export * as common`), pinning the 0.2.0
// barrel shape that unblocked committing all six schemas.
import { assertEquals, assertRejects } from "@std/assert";
import {
  connect,
  MessagePortTransport,
  serveConnection,
} from "@nullstyle/capnp";
import { common, hostControl } from "../../../src/wire/generated/mod.ts";

const CALL_TIMEOUT_MS = 2_000;

Deno.test("generated hostControl.KillResultsCodec round-trips the cross-file composite (error arm)", () => {
  const value: hostControl.KillResults = {
    result: {
      which: "error",
      error: {
        code: "sandboxTerminated",
        message: "sandbox exited before kill completed",
        retryable: true,
        operationId: "op-42",
        sandboxId: "sbx-0001",
        details: [
          { key: "phase", value: "kill" },
          { key: "generation", value: "7" },
        ],
      },
    },
  };
  const encoded = hostControl.KillResultsCodec.encode(value);
  const decoded = hostControl.KillResultsCodec.decode(encoded);
  assertEquals(decoded.result.which, "error");
  const error = decoded.result.error;
  assertEquals(error?.code, "sandboxTerminated");
  assertEquals(error?.message, "sandbox exited before kill completed");
  assertEquals(error?.retryable, true);
  assertEquals(error?.operationId, "op-42");
  assertEquals(error?.sandboxId, "sbx-0001");
  assertEquals(error?.details, [
    { key: "phase", value: "kill" },
    { key: "generation", value: "7" },
  ]);
});

Deno.test("generated hostControl.KillResultsCodec round-trips the same composite through the ok arm", () => {
  const encoded = hostControl.KillResultsCodec.encode({
    result: { which: "ok", ok: {} },
  });
  const decoded = hostControl.KillResultsCodec.decode(encoded);
  assertEquals(decoded.result.which, "ok");
  assertEquals(decoded.result.ok, {});
  // Non-active union arms decode to their defaults, matching the generated
  // codec behavior the 0.1.0-era hand-built mirror pinned.
  assertEquals(decoded.result.error?.code, "unknown");
});

Deno.test("generated codec agrees with common.EmptyResultCodec on the embedded cross-file struct", () => {
  // The `result` field's descriptor must be the real common.capnp struct,
  // not an AnyPointer lowering: encoding the embedded value standalone via
  // common's own generated codec and via the host_control wrapper must agree.
  const embedded: common.EmptyResult = {
    which: "error",
    error: {
      code: "deadlineExceeded",
      message: "kill deadline elapsed",
      retryable: false,
      operationId: "op-7",
      sandboxId: "sbx-0002",
      details: [],
    },
  };
  const viaWrapper = hostControl.KillResultsCodec.decode(
    hostControl.KillResultsCodec.encode({ result: embedded }),
  ).result;
  const viaCommon = common.EmptyResultCodec.decode(
    common.EmptyResultCodec.encode(embedded),
  );
  assertEquals(viaWrapper, viaCommon);
});

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
  const options = {
    closePortOnClose: true,
    maxInboundFrameBytes: 1024 * 1024,
    maxOutboundFrameBytes: 1024 * 1024,
    maxQueuedOutboundFrames: 128,
    maxQueuedOutboundBytes: 4 * 1024 * 1024,
    sendTimeoutMs: CALL_TIMEOUT_MS,
  };
  const serverTransport = new MessagePortTransport(channel.port1, options);
  const clientTransport = new MessagePortTransport(channel.port2, options);
  return {
    clientTransport,
    serverTransport,
    accepted: {
      transport: serverTransport,
      localAddress: { transport: "messageport" },
      remoteAddress: { transport: "messageport" },
      id: "studiobox-cross-file-ping",
    },
  };
}

Deno.test("generated HostControl interface serves a client/server ping over an in-process transport", async () => {
  const { clientTransport, serverTransport, accepted } =
    createMessagePortPair();
  const pinged: bigint[] = [];
  const unimplemented = (method: string) => {
    throw new Error(`${method} is not under test`);
  };
  const service: hostControl.HostControl = {
    ping(nonce) {
      pinged.push(nonce);
      return Promise.resolve(nonce ^ 0xffn);
    },
    create: () => unimplemented("create"),
    attach: () => unimplemented("attach"),
    sandbox: () => unimplemented("sandbox"),
    resumeLease: () => unimplemented("resumeLease"),
    list: () => unimplemented("list"),
    capacity: () => unimplemented("capacity"),
  };

  const handle = await serveConnection(
    hostControl.HostControl,
    accepted,
    service,
  );
  let client:
    | Awaited<
      ReturnType<typeof connect<hostControl.HostControl>>
    >
    | null = null;

  try {
    client = await connect(hostControl.HostControl, clientTransport, {
      defaultTimeoutMs: CALL_TIMEOUT_MS,
    });
    assertEquals(
      await client.ping(0x1020_3040n, { timeoutMs: CALL_TIMEOUT_MS }),
      0x1020_3040n ^ 0xffn,
    );
    assertEquals(
      await client.ping(7n, { timeoutMs: CALL_TIMEOUT_MS }),
      7n ^ 0xffn,
    );
    assertEquals(pinged, [0x1020_3040n, 7n]);

    // Handler failures surface to the caller as typed rejections rather than
    // hangs, so the generated dispatch path is proven in both directions.
    await assertRejects(
      () => client!.list({ timeoutMs: CALL_TIMEOUT_MS }),
      Error,
      "list",
    );
  } finally {
    await client?.close().catch(() => {});
    await Promise.resolve(clientTransport.close()).catch(() => {});
    await handle.close();
    await Promise.resolve(serverTransport.close()).catch(() => {});
  }
});
