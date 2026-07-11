@0xc98f286ea800fca9;

using Common = import "common.capnp";

enum SandboxState {
  creating @0;
  running @1;
  stopping @2;
  terminated @3;
  cleanupPending @4;
}

enum Region {
  ord @0;
  ams @1;
}

struct TimeoutSpec {
  union {
    session @0 :Void;
    durationMs @1 :UInt64;
  }
}

struct CreateOptions {
  timeout @0 :TimeoutSpec;
  memoryMiB @1 :UInt32;
  vcpus @2 :UInt16;
  allowNet @3 :List(Text);
  labels @4 :List(Common.KeyValue);
  region @5 :Region;
  netless @6 :Bool;
  kernelArgs @7 :List(Text);
}

struct LeaseInfo {
  id @0 :Text;
  generation @1 :UInt64;
  resumeSecret @2 :Data;
  expiresAtUnixMs @3 :UInt64;
  timeout @4 :TimeoutSpec;
}

struct SandboxMetadata {
  id @0 :Text;
  state @1 :SandboxState;
  createdAtUnixMs @2 :UInt64;
  deadlineUnixMs @3 :UInt64;
  labels @4 :List(Common.KeyValue);
  region @5 :Region;
  bootNonce @6 :Data;
  liveLeases @7 :UInt16;
  terminationReason @8 :Text;
}

struct CreateSuccess {
  sandbox @0 :SandboxMetadata;
  ownerSecret @1 :Data;
  lease @2 :LeaseInfo;
}

struct CreateResult {
  union {
    success @0 :CreateSuccess;
    error @1 :Common.SbxError;
  }
}

struct AttachSuccess {
  sandbox @0 :SandboxMetadata;
  lease @1 :LeaseInfo;
}

struct AttachResult {
  union {
    success @0 :AttachSuccess;
    error @1 :Common.SbxError;
  }
}

struct ResumeResult {
  union {
    success @0 :AttachSuccess;
    error @1 :Common.SbxError;
  }
}

struct ListSuccess {
  sandboxes @0 :List(SandboxMetadata);
}

struct ListResult {
  union {
    success @0 :ListSuccess;
    error @1 :Common.SbxError;
  }
}

struct Capacity {
  memoryTotalMiB @0 :UInt64;
  memoryCommittedMiB @1 :UInt64;
  vcpusTotal @2 :UInt32;
  vcpusCommitted @3 :UInt32;
  sandboxLimit @4 :UInt32;
  sandboxCount @5 :UInt32;
}

struct CapacityResult {
  union {
    capacity @0 :Capacity;
    error @1 :Common.SbxError;
  }
}

struct MetadataResult {
  union {
    metadata @0 :SandboxMetadata;
    error @1 :Common.SbxError;
  }
}

struct TunnelGrant {
  ticket @0 :Data;
  expiresAtUnixMs @1 :UInt64;
  sandboxId @2 :Text;
  bootNonce @3 :Data;
  leaseId @4 :Text;
  leaseGeneration @5 :UInt64;
  tunnelNonce @6 :Data;
  agentCredential @7 :Data;
}

struct TunnelGrantResult {
  union {
    grant @0 :TunnelGrant;
    error @1 :Common.SbxError;
  }
}

struct Deadline {
  deadlineUnixMs @0 :UInt64;
  leaseGeneration @1 :UInt64;
}

struct DeadlineResult {
  union {
    deadline @0 :Deadline;
    error @1 :Common.SbxError;
  }
}

struct Usage {
  cpuTimeMicros @0 :UInt64;
  memoryCurrentBytes @1 :UInt64;
  memoryPeakBytes @2 :UInt64;
  diskBytes @3 :UInt64;
  rxBytes @4 :UInt64;
  txBytes @5 :UInt64;
}

struct UsageResult {
  union {
    usage @0 :Usage;
    error @1 :Common.SbxError;
  }
}

struct Exposure {
  guestPort @0 :UInt16;
  hostPort @1 :UInt16;
  url @2 :Text;
}

struct ExposureResult {
  union {
    exposure @0 :Exposure;
    error @1 :Common.SbxError;
  }
}

struct LeaseRenewal {
  generation @0 :UInt64;
  expiresAtUnixMs @1 :UInt64;
}

struct LeaseRenewResult {
  union {
    renewal @0 :LeaseRenewal;
    error @1 :Common.SbxError;
  }
}

interface HostBootstrap {
  negotiate @0 (offer :Common.ProtocolOffer)
      -> (result :Common.HandshakeResult);
  authenticate @1 (credential :Data) -> (result :Common.AuthResult);
  host @2 () -> (host :HostControl);
}

interface HostControl {
  create @0 (options :CreateOptions, idempotencyKey :Data)
      -> (result :CreateResult);
  attach @1 (id :Text, ownerSecret :Data, idempotencyKey :Data)
      -> (result :AttachResult);
  sandbox @2 (id :Text) -> (sandbox :HostSandbox);
  resumeLease @3 (id :Text, leaseId :Text, secret :Data)
      -> (result :ResumeResult);
  list @4 () -> (result :ListResult);
  capacity @5 () -> (result :CapacityResult);
  ping @6 (nonce :UInt64) -> (nonce :UInt64);
}

interface HostSandbox {
  metadata @0 () -> (result :MetadataResult);
  lease @1 () -> (lease :Lease);
  openTunnel @2 () -> (result :TunnelGrantResult);
  extendTimeout @3 (milliseconds :UInt64) -> (result :DeadlineResult);
  usage @4 () -> (result :UsageResult);
  exposeHttp @5 (guestPort :UInt16) -> (result :ExposureResult);
  kill @6 () -> (result :Common.EmptyResult);
}

interface Lease {
  renew @0 () -> (result :LeaseRenewResult);
  release @1 () -> (result :Common.EmptyResult);
}
