@0xaab5db2f508b76bd;

# Qualification-only schema. It is not part of Studiobox's negotiated protocol
# hash; it proves the exact capnpc-deno snapshot can generate, type-check, and
# execute unary plus application-streaming RPC bindings while full multi-file
# import lowering is addressed upstream.

struct ProbeResult {
  nonce @0 :UInt64;
  acceptedChunks @1 :UInt64;
}

interface CodegenProbe {
  ping @0 (nonce :UInt64) -> (result :ProbeResult);
  chunk @1 (sequence :UInt64, data :Data) -> stream;
}
