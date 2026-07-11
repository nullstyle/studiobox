// deno-lint-ignore no-import-prefix -- exact audit baseline, never runtime-loaded
import type * as Upstream from "jsr:@deno/sandbox@0.13.2";
import type * as Studiobox from "../../../src/mod.ts";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
  ? (<Value>() => Value extends Right ? 1 : 2) extends
    (<Value>() => Value extends Left ? 1 : 2) ? true : false
  : false;
type Assert<Condition extends true> = Condition;
type IsReadonly<Type, Key extends keyof Type> = Equal<
  Pick<Type, Key>,
  { -readonly [Member in Key]: Type[Member] }
> extends true ? false : true;

// Exact structural contracts used by the Tier A execution surface.
type _CoreDataParity = [
  Assert<Equal<Studiobox.Signal, Upstream.Signal>>,
  Assert<Equal<Studiobox.ChildProcessStatus, Upstream.ChildProcessStatus>>,
  Assert<Equal<Studiobox.ChildProcessOutput, Upstream.ChildProcessOutput>>,
  Assert<Equal<Studiobox.SandboxEnv, Upstream.SandboxEnv>>,
  Assert<Equal<Studiobox.ReadFileOptions, Upstream.ReadFileOptions>>,
  Assert<Equal<Studiobox.WriteFileOptions, Upstream.WriteFileOptions>>,
  Assert<Equal<Studiobox.MkdirOptions, Upstream.MkdirOptions>>,
  Assert<Equal<Studiobox.RemoveOptions, Upstream.RemoveOptions>>,
  Assert<Equal<Studiobox.OpenOptions, Upstream.OpenOptions>>,
  Assert<Equal<Studiobox.DirEntry, Upstream.DirEntry>>,
  Assert<Equal<Studiobox.FileInfo, Upstream.FileInfo>>,
  Assert<Equal<Studiobox.WalkEntry, Upstream.WalkEntry>>,
  Assert<Equal<Studiobox.WalkOptions, Upstream.WalkOptions>>,
  Assert<Equal<Studiobox.ExpandGlobOptions, Upstream.ExpandGlobOptions>>,
  Assert<Equal<Studiobox.CodeExtension, Upstream.CodeExtension>>,
  Assert<Equal<Studiobox.DenoRunOptions, Upstream.DenoRunOptions>>,
  Assert<Equal<Studiobox.DenoReplOptions, Upstream.DenoReplOptions>>,
  Assert<Equal<Studiobox.Build, Upstream.Build>>,
  Assert<Equal<Studiobox.BuildOptions, Upstream.BuildOptions>>,
  Assert<Equal<Studiobox.DeployOptions, Upstream.DeployOptions>>,
  Assert<Equal<Studiobox.ConnectOptions, Upstream.ConnectOptions>>,
  Assert<Equal<Studiobox.RequestInit, Upstream.RequestInit>>,
  Assert<Equal<Studiobox.SandboxOptions, Upstream.SandboxOptions>>,
  Assert<Equal<Studiobox.SpawnOptions, Upstream.SpawnOptions>>,
  Assert<Equal<Studiobox.VsCodeOptions, Upstream.VsCodeOptions>>,
  Assert<Equal<Studiobox.Memory, Upstream.Memory>>,
  Assert<Equal<Studiobox.BaseClientOptions, Upstream.BaseClientOptions>>,
];

// Representative cloud-management shapes are Tier C but remain exact types.
type _ManagementTypeParity = [
  Assert<Equal<Studiobox.App, Upstream.App>>,
  Assert<Equal<Studiobox.AppConfig, Upstream.AppConfig>>,
  Assert<Equal<Studiobox.AppInit, Upstream.AppInit>>,
  Assert<Equal<Studiobox.AppUpdate, Upstream.AppUpdate>>,
  Assert<Equal<Studiobox.Apps, Upstream.Apps>>,
  Assert<Equal<Studiobox.Layer, Upstream.Layer>>,
  Assert<Equal<Studiobox.Layers, Upstream.Layers>>,
  Assert<Equal<Studiobox.Revision, Upstream.Revision>>,
  Assert<Equal<Studiobox.RevisionProgress, Upstream.RevisionProgress>>,
  Assert<Equal<Studiobox.Revisions, Upstream.Revisions>>,
  Assert<Equal<Studiobox.SandboxMetadata, Upstream.SandboxMetadata>>,
  Assert<Equal<Studiobox.Timelines, Upstream.Timelines>>,
  Assert<Equal<Studiobox.VolumeInit, Upstream.VolumeInit>>,
];

// Class-returning interfaces are nominally different across two packages even
// when their callable member shapes match, so audit their keysets separately.
type _NominalInterfaceKeyParity = [
  Assert<Equal<keyof Studiobox.Sandbox, keyof Upstream.Sandbox>>,
  Assert<Equal<keyof Studiobox.VsCode, keyof Upstream.VsCode>>,
  Assert<Equal<keyof Studiobox.Volume, keyof Upstream.Volume>>,
  Assert<Equal<keyof Studiobox.Snapshot, keyof Upstream.Snapshot>>,
  Assert<Equal<keyof Studiobox.SandboxFs, keyof Upstream.SandboxFs>>,
  Assert<Equal<keyof Studiobox.SandboxDeno, keyof Upstream.SandboxDeno>>,
  Assert<Equal<keyof Studiobox.Sandboxes, keyof Upstream.Sandboxes>>,
  Assert<Equal<keyof Studiobox.Snapshots, keyof Upstream.Snapshots>>,
  Assert<Equal<keyof Studiobox.Volumes, keyof Upstream.Volumes>>,
];

// Writable diagnostics and function properties are part of the upstream
// structural contract even though most consumers only read them.
type _MutablePropertyParity = [
  Assert<Equal<IsReadonly<Studiobox.Sandbox, "sh">, false>>,
  Assert<Equal<IsReadonly<Upstream.Sandbox, "sh">, false>>,
  Assert<
    Equal<
      Pick<Studiobox.ApiError, "status" | "code" | "traceId">,
      Pick<Upstream.ApiError, "status" | "code" | "traceId">
    >
  >,
  Assert<
    Equal<
      Pick<
        Studiobox.ConnectionEstablishmentError,
        "status" | "code" | "traceId"
      >,
      Pick<Upstream.ConnectionEstablishmentError, "status" | "code" | "traceId">
    >
  >,
  Assert<
    Equal<
      Pick<Studiobox.ConnectionClosedError, "code" | "reason">,
      Pick<Upstream.ConnectionClosedError, "code" | "reason">
    >
  >,
  Assert<
    Equal<
      Pick<Studiobox.RpcError, "code" | "data">,
      Pick<Upstream.RpcError, "code" | "data">
    >
  >,
  Assert<
    Equal<
      Pick<Studiobox.SandboxKillError, "status" | "response">,
      Pick<Upstream.SandboxKillError, "status" | "response">
    >
  >,
];

// These are all valid zero/default-argument forms in the upstream package.
function defaultedCallParity(
  upstream: Upstream.Sandbox,
  studiobox: Studiobox.Sandbox,
): void {
  void upstream.spawn("true");
  void studiobox.spawn("true");

  void upstream.exposeVscode();
  void studiobox.exposeVscode();

  void upstream.deploy("app");
  void studiobox.deploy("app");
}

Deno.test("upstream member-level type fixtures compile", () => {
  // Keep compile-only fixtures referenced without executing abstract contracts.
  void defaultedCallParity;
});
