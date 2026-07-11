@0xabeac9d96f412348;

using Common = import "common.capnp";

# Application-level bounded streams. `chunk()` calls are declared streaming so
# generated clients can pipeline a small, explicitly bounded in-flight window.

struct TransferCommit {
  totalBytes @0 :UInt64;
  chunkCount @1 :UInt64;
  sha256 @2 :Data;
}

struct TransferReceipt {
  totalBytes @0 :UInt64;
  chunkCount @1 :UInt64;
  sha256 @2 :Data;
}

struct FinishResult {
  union {
    receipt @0 :TransferReceipt;
    error @1 :Common.SbxError;
  }
}

struct ReadChunk {
  sequence @0 :UInt64;
  data @1 :Data;
}

struct ReadResult {
  union {
    chunk @0 :ReadChunk;
    end @1 :TransferReceipt;
    error @2 :Common.SbxError;
  }
}

enum OutputChannel {
  stdout @0;
  stderr @1;
}

interface ByteSink {
  chunk @0 (sequence :UInt64, data :Data) -> stream;
  finish @1 (commit :TransferCommit) -> (result :FinishResult);
  abort @2 () -> (result :Common.EmptyResult);
}

interface ByteReader {
  read @0 (maxBytes :UInt32) -> (result :ReadResult);
  cancel @1 () -> (result :Common.EmptyResult);
}

interface OutputSink {
  chunk @0 (channel :OutputChannel, sequence :UInt64, data :Data) -> stream;
  finish @1 (channel :OutputChannel, commit :TransferCommit)
      -> (result :FinishResult);
  fail @2 (channel :OutputChannel, error :Common.SbxError)
      -> (result :Common.EmptyResult);
}
