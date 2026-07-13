@0x9f91945d88bf875b;

using Common = import "common.capnp";
using Streams = import "streams.capnp";

enum StdioMode {
  inherit @0;
  piped @1;
  discard @2;
}

enum KillSignal {
  sigterm @0;
  sigkill @1;
  sigint @2;
  sighup @3;
}

struct SpawnSpec {
  command @0 :Text;
  args @1 :List(Text);
  cwd @2 :Text;
  env @3 :List(Common.KeyValue);
  stdin @4 :StdioMode;
  stdout @5 :StdioMode;
  stderr @6 :StdioMode;
}

struct SpawnResult {
  union {
    process @0 :Process;
    error @1 :Common.SbxError;
  }
}

struct ProcessStatus {
  running @0 :Bool;
  code @1 :Int32;
  signal @2 :KillSignal;
  signaled @3 :Bool;
  oom @4 :Bool;
}

struct ProcessStatusResult {
  union {
    status @0 :ProcessStatus;
    error @1 :Common.SbxError;
  }
}

interface ProcessSpawner {
  spawn @0 (spec :SpawnSpec, output :Streams.OutputSink)
      -> (result :SpawnResult);
}

interface Process {
  writeStdin @0 (sequence :UInt64, data :Data) -> stream;
  closeStdin @1 (commit :Streams.TransferCommit)
      -> (result :Streams.FinishResult);
  signal @2 (signal :KillSignal) -> (result :Common.EmptyResult);
  status @3 () -> (result :ProcessStatusResult);
  wait @4 () -> (result :ProcessStatusResult);
  release @5 () -> (result :Common.EmptyResult);
}

enum FileKind {
  regular @0;
  directory @1;
  symlink @2;
}

struct FileInfo {
  path @0 :Text;
  kind @1 :FileKind;
  size @2 :UInt64;
  mode @3 :UInt32;
  modifiedAtUnixMs @4 :UInt64;
}

struct FileInfoResult {
  union {
    info @0 :FileInfo;
    error @1 :Common.SbxError;
  }
}

struct FileList {
  entries @0 :List(FileInfo);
}

struct FileListResult {
  union {
    list @0 :FileList;
    error @1 :Common.SbxError;
  }
}

struct OpenResult {
  union {
    file @0 :RemoteFile;
    error @1 :Common.SbxError;
  }
}

struct UploadResult {
  union {
    upload @0 :Upload;
    error @1 :Common.SbxError;
  }
}

struct DownloadResult {
  union {
    reader @0 :Streams.ByteReader;
    error @1 :Common.SbxError;
  }
}

interface FileSystem {
  stat @0 (path :Text) -> (result :FileInfoResult);
  list @1 (path :Text) -> (result :FileListResult);
  makeDir @2 (path :Text, recursive :Bool) -> (result :Common.EmptyResult);
  remove @3 (path :Text, recursive :Bool) -> (result :Common.EmptyResult);
  rename @4 (from :Text, to :Text) -> (result :Common.EmptyResult);
  open @5 (path :Text, create :Bool, truncate :Bool) -> (result :OpenResult);
  beginUpload @6 (path :Text, mode :UInt32) -> (result :UploadResult);
  beginDownload @7 (path :Text) -> (result :DownloadResult);
}

interface RemoteFile {
  stat @0 () -> (result :FileInfoResult);
  read @1 (offset :UInt64, maxBytes :UInt32) -> (result :Streams.ReadResult);
  write @2 (offset :UInt64, sequence :UInt64, data :Data) -> stream;
  truncate @3 (size :UInt64) -> (result :Common.EmptyResult);
  sync @4 () -> (result :Common.EmptyResult);
  close @5 () -> (result :Common.EmptyResult);
}

interface Upload {
  chunk @0 (sequence :UInt64, data :Data) -> stream;
  finish @1 (commit :Streams.TransferCommit) -> (result :Streams.FinishResult);
  abort @2 () -> (result :Common.EmptyResult);
}

struct EnvValueResult {
  union {
    value @0 :Text;
    missing @1 :Void;
    error @2 :Common.SbxError;
  }
}

struct EnvListResult {
  union {
    values @0 :List(Common.KeyValue);
    error @1 :Common.SbxError;
  }
}

interface Environment {
  get @0 (key :Text) -> (result :EnvValueResult);
  set @1 (key :Text, value :Text) -> (result :Common.EmptyResult);
  delete @2 (key :Text) -> (result :Common.EmptyResult);
  list @3 () -> (result :EnvListResult);
}

struct EvalResult {
  union {
    json @0 :Data;
    error @1 :Common.SbxError;
  }
}

struct ReplResult {
  union {
    repl @0 :DenoRepl;
    error @1 :Common.SbxError;
  }
}

struct DenoProcessResult {
  union {
    process @0 :DenoProcess;
    error @1 :Common.SbxError;
  }
}

interface DenoRuntime {
  eval @0 (source :Text, env :List(Common.KeyValue)) -> (result :EvalResult);
  openRepl @1 (env :List(Common.KeyValue)) -> (result :ReplResult);
  run @2 (spec :SpawnSpec, output :Streams.OutputSink)
      -> (result :DenoProcessResult);
}

interface DenoRepl {
  eval @0 (source :Text) -> (result :EvalResult);
  close @1 () -> (result :Common.EmptyResult);
}

struct Header {
  name @0 :Text;
  value @1 :Text;
}

struct HttpRequestHead {
  method @0 :Text;
  url @1 :Text;
  headers @2 :List(Header);
}

struct HttpResponseHead {
  status @0 :UInt16;
  headers @1 :List(Header);
}

struct HttpExchangeResult {
  union {
    exchange @0 :HttpExchange;
    error @1 :Common.SbxError;
  }
}

interface HttpResponseSink {
  start @0 (head :HttpResponseHead) -> (result :Common.EmptyResult);
  chunk @1 (sequence :UInt64, data :Data) -> stream;
  finish @2 (commit :Streams.TransferCommit) -> (result :Streams.FinishResult);
  fail @3 (error :Common.SbxError) -> (result :Common.EmptyResult);
}

interface HttpClient {
  begin @0 (request :HttpRequestHead, response :HttpResponseSink)
      -> (result :HttpExchangeResult);
}

interface HttpExchange {
  writeRequestBody @0 (sequence :UInt64, data :Data) -> stream;
  finishRequest @1 (commit :Streams.TransferCommit)
      -> (result :Streams.FinishResult);
  cancel @2 () -> (result :Common.EmptyResult);
}

struct HttpReadyResult {
  union {
    port @0 :UInt16;
    error @1 :Common.SbxError;
  }
}

interface DenoProcess extends(Process) {
  fetch @0 (request :HttpRequestHead, response :HttpResponseSink)
      -> (result :HttpExchangeResult);
  httpReady @1 () -> (result :HttpReadyResult);
}

# Per-restore personalization (snapshot-restore, DESIGN docs/snapshot-restore.md
# §2.1). A warm-template studioboxd boots holding NO credential and with its
# NIC present but unconfigured; every restore shares one snapshot's guest
# memory, so per-sandbox identity CANNOT be baked at boot. rootd injects it
# after restore+resume over the in-jail vsock via `personalize` (below), which
# sets the credential the later `authenticate` must present and reconfigures the
# guest NIC in-band. A cold-booted (--token-file) agent never needs it.
struct GuestNetwork {
  guestCidr @0 :Text;  # e.g. 10.201.0.2/30 ; EMPTY => netless (leave iface down)
  gateway @1 :Text;    # host TAP address (10.201.<t>.<b+1>)
  dns @2 :Text;        # per-sandbox dnsmasq (written to /etc/resolv.conf)
  iface @3 :Text;      # guest NIC to (re)configure in-band (e.g. eth0)
}

struct PersonalizeRequest {
  credential @0 :Data;        # per-restore authenticate secret (16..512 bytes)
  bootNonce @1 :Data;         # per-restore boot nonce (bound like the cold path)
  sandboxId @2 :Text;         # bound sandbox id
  network @3 :GuestNetwork;   # in-band NIC config (empty guestCidr => netless)
}

struct PersonalizeAck {
  buildId @0 :Text;      # echoes studioboxd buildId for the caller's log
  appliedCidr @1 :Text;  # the applied guest CIDR; empty when netless
}

struct PersonalizeResult {
  union {
    ok @0 :PersonalizeAck;
    error @1 :Common.SbxError;
  }
}

interface AgentBootstrap {
  negotiate @0 (offer :Common.ProtocolOffer)
      -> (result :Common.HandshakeResult);
  authenticate @1 (credential :Data, sandboxId :Text, bootNonce :Data)
      -> (result :Common.AuthResult);
  agent @2 () -> (agent :SandboxAgent);
  # Pre-auth, one-shot (snapshot-restore §2.1): a template-mode agent accepts
  # ONLY personalize after negotiate (authenticate/agent are rejected until it
  # succeeds); a second call after success returns "already personalized". Sets
  # the per-sandbox credential + bootNonce binding and applies the guest NIC.
  personalize @3 (request :PersonalizeRequest) -> (result :PersonalizeResult);
}

interface SandboxAgent {
  processes @0 () -> (service :ProcessSpawner);
  filesystem @1 () -> (service :FileSystem);
  environment @2 () -> (service :Environment);
  deno @3 () -> (service :DenoRuntime);
  http @4 () -> (service :HttpClient);
  ping @5 (nonce :UInt64) -> (nonce :UInt64);
}
