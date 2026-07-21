/**
 * Shared scaffolding for the in-VM (T3) suite (PLAN.md §M5).
 *
 * These tests boot REAL jailed Firecracker microVMs and drive the real
 * studioboxd agent over REAL vsock. They only run inside a Linux+KVM host
 * (the `fc-smoke` Lima VM locally, a KVM CI runner in CI) as root — the
 * jailer needs root to chroot / mknod / drop privilege. `deno test tests/`
 * on macOS or a KVM-less runner skips the whole tier via {@linkcode inGuest}.
 *
 * Environment contract (set by the `test:vm` driver):
 *
 * - `SBX_VM=1`                — arm the tier (absent → every test ignores).
 * - `SBX_VM_CACHE`            — artifact cache root holding the golden set.
 * - `SBX_VM_MANIFEST_HASH`    — the golden set's manifest hash.
 * - `SBX_VM_WORK`             — short work base (chroot/overlay/journal live
 *                              here; keep short — it prefixes the vsock
 *                              sun_path, ~104 bytes).
 * - `SBX_VM_JAILER_BIN`       — jailer path (default `/usr/local/bin/jailer`).
 * - `SBX_VM_FIRECRACKER_BIN`  — firecracker path (default
 *                              `/usr/local/bin/firecracker`).
 * - `SBX_VM_SHARED_HW=1`      — the host is shared CI hardware; relaxes the
 *                              perf-shaped assertions only ({@linkcode
 *                              sharedHardware}).
 *
 * @module
 */

import { join } from "@std/path";
import { assertEquals, assertExists } from "@std/assert";
import type { RpcStub, RpcWireClient } from "@nullstyle/capnp";
import type { VsockConn } from "@nullstyle/firecracker";

import {
  GoldenArtifactLaunchPlanner,
  type GoldenArtifactLaunchPlannerOptions,
} from "../../src/rootd/launch_planner.ts";
import { openAgentSession as dialAgentSession } from "../../src/rootd/agent_dialer.ts";
import { ArtifactCache } from "../../images/cache.ts";
import { Sha256 } from "../../src/agent/sha256.ts";
import type * as wire from "../../src/wire/generated/sandbox_agent_types.ts";
import type * as wireCommon from "../../src/wire/generated/common_types.ts";
import * as wireStreams from "../../src/wire/generated/streams_types.ts";

/** True only when the in-VM tier is armed (Linux + KVM + root, set up). */
export const inGuest = Deno.env.get("SBX_VM") === "1";

/**
 * True when the tier runs on SHARED, virtualized CI hardware (a GitHub-hosted
 * runner) rather than a dedicated host.
 *
 * A wall-clock RATIO between two microVM boots is not measurable there: noisy
 * neighbours and a network-backed disk swamp the difference the measurement is
 * after (the snapshot case's per-restore 512 MiB memory-file copy costs more
 * than the whole boot it replaces, so restore measures ~1.0x cold instead of
 * the ~1.5-2x a real host shows). Cases gate their perf-shaped assertion on
 * this and fall back to a gross-regression bound, logging the numbers loudly;
 * every FUNCTIONAL assertion stays exactly as strict either way.
 *
 * Set EXPLICITLY by the job that knows its hardware (`SBX_VM_SHARED_HW=1`),
 * never inferred from `CI` — a dedicated self-hosted runner must keep the
 * strict gate.
 */
export const sharedHardware = Deno.env.get("SBX_VM_SHARED_HW") === "1";

/**
 * `--config <path>` args for subprocesses this tier spawns, propagating the
 * import map the suite itself was launched with (`SBX_VM_CONFIG`). In the
 * dev loop the config is a sibling `deno.local.json`; a lockfile-pinned host
 * needs nothing here.
 */
export function denoConfigArgs(): string[] {
  const config = Deno.env.get("SBX_VM_CONFIG");
  return config === undefined || config === "" ? [] : ["--config", config];
}

export const CALL_TIMEOUT_MS = 30_000;

export interface VmSuiteConfig {
  readonly cacheRoot: string;
  readonly manifestHash: string;
  readonly workBase: string;
  readonly jailerBin: string;
  readonly firecrackerBin: string;
  readonly arch: "aarch64" | "x86_64";
}

/** Read the in-VM environment contract; throws if `SBX_VM` is armed but bare. */
export function readVmConfig(): VmSuiteConfig {
  const cacheRoot = requireEnv("SBX_VM_CACHE");
  const manifestHash = requireEnv("SBX_VM_MANIFEST_HASH");
  const workBase = requireEnv("SBX_VM_WORK");
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  return {
    cacheRoot,
    manifestHash,
    workBase,
    jailerBin: Deno.env.get("SBX_VM_JAILER_BIN") ?? "/usr/local/bin/jailer",
    firecrackerBin: Deno.env.get("SBX_VM_FIRECRACKER_BIN") ??
      "/usr/local/bin/firecracker",
    arch,
  };
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new Error(`in-VM suite requires ${name}`);
  }
  return value;
}

/**
 * Build the real launch planner against the golden set, rooting the jail /
 * overlay / journal under `workDir` (a fresh short dir per test).
 */
export function buildPlanner(
  config: VmSuiteConfig,
  workDir: string,
  overrides: Partial<GoldenArtifactLaunchPlannerOptions> = {},
): GoldenArtifactLaunchPlanner {
  return new GoldenArtifactLaunchPlanner({
    cache: new ArtifactCache({ root: config.cacheRoot }),
    manifestHash: config.manifestHash,
    arch: config.arch,
    jailerBin: config.jailerBin,
    firecrackerBin: config.firecrackerBin,
    uid: 0,
    gid: 0,
    chrootBaseDir: join(workDir, "jail"),
    overlayDir: join(workDir, "ov"),
    ...overrides,
  });
}

/** Chroot exec dir (`<base>/firecracker/<execId>`) removed on reclaim. */
export function jailExecDir(workDir: string, executionId: string): string {
  return join(workDir, "jail", "firecracker", executionId);
}

/** Host view of the guest vsock UDS for one execution. */
export function vsockHostPath(workDir: string, executionId: string): string {
  return join(jailExecDir(workDir, executionId), "root", "v.sock");
}

// ---------------------------------------------------------------------------
// Agent-plane client (over a VsockConn instead of a UDS Deno.Conn)
// ---------------------------------------------------------------------------

export interface AgentSession extends AsyncDisposable {
  readonly agent: RpcStub<wire.SandboxAgent>;
  readonly wireClient: RpcWireClient;
}

/** Options that RETAIN a result capability (see the agent wire test). */
export const CAP_CALL = {
  timeoutMs: CALL_TIMEOUT_MS,
  finish: { releaseResultCaps: false },
} as const;

/**
 * Wrap an established guest vsock connection in the `sandbox_agent.capnp`
 * client and run the fail-closed negotiate → authenticate → agent()
 * bootstrap with the launch's minted credential.
 *
 * Delegates to the production host dialer
 * (`src/rootd/agent_dialer.ts`), so the real-vsock in-VM suite exercises
 * the same bounded dial+handshake path the supervisor's host peer uses
 * (DEFECT A, dial side): a stalling / garbage-spewing guest surfaces a
 * typed `SupervisorError` within the timeout instead of hanging.
 */
export function openAgentSession(
  conn: VsockConn,
  credential: Uint8Array,
  sandboxId: string,
  bootNonce: Uint8Array,
): Promise<AgentSession> {
  return dialAgentSession(conn, {
    credential,
    sandboxId,
    bootNonce,
    callerBuildId: "studiobox/m5-vm",
    timeoutMs: CALL_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------
// Client-hosted OutputSink (the agent pumps process output INTO this)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

interface SinkChannel {
  chunks: Uint8Array[];
  nextSequence: bigint;
  done: Deferred<wireStreams.TransferCommit>;
}

/** Collects an agent output channel; mirrors the agent wire test's sink. */
export class SinkCollector implements wireStreams.OutputSinkService {
  readonly #channels = new Map<wireStreams.OutputChannel, SinkChannel>();

  #channel(name: wireStreams.OutputChannel): SinkChannel {
    let channel = this.#channels.get(name);
    if (channel === undefined) {
      channel = {
        chunks: [],
        nextSequence: 0n,
        done: deferred<wireStreams.TransferCommit>(),
      };
      this.#channels.set(name, channel);
    }
    return channel;
  }

  chunk(params: wireStreams.ChunkParams2): void {
    const channel = this.#channel(params.channel);
    assertEquals(params.sequence, channel.nextSequence, "dense sequence");
    channel.nextSequence += 1n;
    channel.chunks.push(params.data.slice());
  }

  finish(params: wireStreams.FinishParams2): wireStreams.FinishResult {
    const channel = this.#channel(params.channel);
    const hash = new Sha256();
    let totalBytes = 0n;
    for (const chunk of channel.chunks) {
      hash.update(chunk);
      totalBytes += BigInt(chunk.byteLength);
    }
    channel.done.resolve(params.commit);
    return {
      which: "receipt",
      receipt: {
        totalBytes,
        chunkCount: BigInt(channel.chunks.length),
        sha256: hash.digest(),
      },
    };
  }

  fail(params: wireStreams.FailParams): wireCommon.EmptyResult {
    this.#channel(params.channel).done.reject(
      new Error(`${params.channel} pump failed: ${params.error.message}`),
    );
    return { which: "ok", ok: {} };
  }

  commit(name: wireStreams.OutputChannel): Promise<wireStreams.TransferCommit> {
    return this.#channel(name).done.promise;
  }

  bytes(name: wireStreams.OutputChannel): Uint8Array {
    return concatBytes(this.#channel(name).chunks);
  }
}

/** Export a client-hosted OutputSink for `spawn`'s `output` param. */
export function registerSink(
  wireClient: RpcWireClient,
  sink: SinkCollector,
): RpcStub<wireStreams.OutputSink> {
  return wireStreams.OutputSink.registerServer(wireClient, sink, {
    referenceCount: 2,
  }) as unknown as RpcStub<wireStreams.OutputSink>;
}

export function spec(overrides: Partial<wire.SpawnSpec>): wire.SpawnSpec {
  return {
    command: "",
    args: [],
    cwd: "",
    env: [],
    stdin: "discard",
    stdout: "piped",
    stderr: "piped",
    ...overrides,
  };
}

export function requireProcess(
  result: wire.SpawnResult,
): RpcStub<wire.Process> {
  assertEquals(result.which, "process", result.error?.message);
  assertExists(result.process);
  return result.process;
}

/** Signal-0 liveness (SIGCONT fallback for runtimes without kill(pid,0)). */
export function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    if (!(error instanceof TypeError)) return true;
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (error) {
    return !(error instanceof Deno.errors.NotFound);
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
