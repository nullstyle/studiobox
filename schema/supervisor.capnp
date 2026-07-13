@0xd4a63f0d047f5cea;

using Common = import "common.capnp";

# Root-boundary protocol. Requests contain only logical identifiers resolved by
# studiobox-rootd against signed manifests and pre-reserved allocations. There are
# deliberately no argv, host-path, UID/GID, cgroup, netns, or nftables fields.
#
# `allowNet` is a LOGICAL egress policy (host/IP patterns) that rootd resolves
# internally via the nftables engine at launch — it is not an argv, host-path,
# uid, or netns field, so it is consistent with the "logical identifiers only"
# principle above (rootd, not the client, derives every TAP/table/rule name).

enum MachineState {
  launching @0;
  running @1;
  stopping @2;
  exited @3;
  cleanupPending @4;
}

# Egress presence, honored by rootd (see the header note on allowNet):
#   netless == true                          -> no network at all (overrides allowNet)
#   netless == false && allowNetSet == false -> UNRESTRICTED (full internet; ignore allowNet)
#   netless == false && allowNetSet == true  -> RESTRICTED to allowNet ([] = deny-all)
struct LaunchRequest {
  sandboxId @0 :Text;
  executionId @1 :Text;
  artifactId @2 :Text;
  allocationId @3 :Text;
  bootNonce @4 :Data;
  idempotencyKey @5 :Data;
  allowNet @6 :List(Text);
  allowNetSet @7 :Bool;
  netless @8 :Bool;
  vcpus @9 :UInt16;
}

struct MachineStatus {
  sandboxId @0 :Text;
  executionId @1 :Text;
  state @2 :MachineState;
  pid @3 :UInt32;
  exitCode @4 :Int32;
  exitedAtUnixMs @5 :UInt64;
  reason @6 :Text;
}

struct LaunchResult {
  union {
    status @0 :MachineStatus;
    error @1 :Common.SbxError;
  }
}

struct StatusResult {
  union {
    status @0 :MachineStatus;
    error @1 :Common.SbxError;
  }
}

struct MachineUsage {
  cpuTimeMicros @0 :UInt64;
  memoryCurrentBytes @1 :UInt64;
  memoryPeakBytes @2 :UInt64;
  diskBytes @3 :UInt64;
  rxBytes @4 :UInt64;
  txBytes @5 :UInt64;
}

struct UsageResult {
  union {
    usage @0 :MachineUsage;
    error @1 :Common.SbxError;
  }
}

struct ProbeResult {
  union {
    ready @0 :Void;
    error @1 :Common.SbxError;
  }
}

struct BridgeRequest {
  sandboxId @0 :Text;
  executionId @1 :Text;
  leaseId @2 :Text;
  leaseGeneration @3 :UInt64;
  tunnelNonce @4 :Data;
  expiresAtUnixMs @5 :UInt64;
}

struct BridgeGrant {
  bridgeId @0 :Text;
  socketPath @1 :Text;
  bridgeCredential @2 :Data;
  agentCredential @3 :Data;
  expiresAtUnixMs @4 :UInt64;
}

struct BridgeResult {
  union {
    grant @0 :BridgeGrant;
    error @1 :Common.SbxError;
  }
}

struct ReconcileSummary {
  examined @0 :UInt32;
  killed @1 :UInt32;
  reclaimed @2 :UInt32;
  quarantined @3 :UInt32;
  failures @4 :List(Common.SbxError);
}

struct ReconcileResult {
  union {
    summary @0 :ReconcileSummary;
    error @1 :Common.SbxError;
  }
}

struct Health {
  buildId @0 :Text;
  startedAtUnixMs @1 :UInt64;
  activeMachines @2 :UInt32;
  activeBridges @3 :UInt32;
  reconciling @4 :Bool;
}

struct HealthResult {
  union {
    health @0 :Health;
    error @1 :Common.SbxError;
  }
}

interface SupervisorBootstrap {
  negotiate @0 (offer :Common.ProtocolOffer)
      -> (result :Common.HandshakeResult);
  authenticate @1 (credential :Data) -> (result :Common.AuthResult);
  supervisor @2 () -> (supervisor :Supervisor);
}

interface Supervisor {
  launch @0 (request :LaunchRequest) -> (result :LaunchResult);
  status @1 (executionId :Text) -> (result :StatusResult);
  usage @2 (executionId :Text) -> (result :UsageResult);
  probeAgent @3 (executionId :Text) -> (result :ProbeResult);
  openBridge @4 (request :BridgeRequest) -> (result :BridgeResult);
  shutdown @5 (executionId :Text) -> (result :Common.EmptyResult);
  kill @6 (executionId :Text) -> (result :Common.EmptyResult);
  reconcile @7 () -> (result :ReconcileResult);
  health @8 () -> (result :HealthResult);
  ping @9 (nonce :UInt64) -> (nonce :UInt64);
  # hostd owns the host-port lease (40100..40199) and passes the allocated
  # hostPort; rootd installs the per-sandbox loopback DNAT/SNAT (sbx_pf_<id>)
  # and journals resources.exposedPorts. Logical ids only, as everywhere else.
  exposeHttp @10 (executionId :Text, guestPort :UInt16, hostPort :UInt16)
      -> (result :Common.EmptyResult);
}
