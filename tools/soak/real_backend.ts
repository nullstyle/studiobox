/**
 * `RealMicrovmSoakBackend` — the REAL-microVM {@linkcode SoakBackend} the 1.0
 * soak drill (PLAN.md §M11) runs inside `fc-smoke`. It is the fc-smoke twin of
 * the host-safe {@linkcode import("./fake_backend.ts").FakeVmmSoakBackend}:
 * same `create → use → terminate` + kill-9-mid-fleet + destructive-reconcile
 * contract, but over the ACTUAL launch stack —
 *
 *   {@linkcode GoldenArtifactLaunchPlanner} (real jailed Firecracker microVM +
 *   real studioboxd on real vsock) + the M10 Tier-B dataplane
 *   ({@linkcode BitmapSubnetAllocator} + {@linkcode NetworkController} +
 *   {@linkcode DnsmasqController} + {@linkcode EgressController} +
 *   {@linkcode PortForwardController})
 *
 * driven through a real {@linkcode SupervisorCore} exactly as
 * `tests/vm/real_stack.ts` + `src/rootd/main.ts` assemble it. That gives the
 * in-guest {@linkcode buildInGuestAudit} real resources to enumerate across
 * every leak class: `/proc` VMMs, `sbxtap<slot>` TAPs, `inet sbx_eg_*` +
 * `ip sbx_pf_*` nft tables, per-sandbox dnsmasq, jail mounts / roots, overlays,
 * host ports, journal phases, and artifact refcounts.
 *
 * The kill-9-mid-fleet drill is simulated the way the real rootd recovers: a
 * mid-fleet batch is launched, self-audited (with the batch allowance), then
 * the in-memory supervisor + planner + allocator are DROPPED — the batch's real
 * VMMs survive as orphans — and a fresh stack is rebuilt over the SAME journal,
 * running the identical cold-start reconcile `main.ts` runs at boot
 * (reserve surviving slots → seal shared tables → sweep network orphans →
 * destructive reconcile), reaping every orphan VMM + its dataplane state.
 *
 * This backend can only RUN inside a Linux+KVM+root guest (the jailer needs
 * root); on any other host it is type-checked but never provisioned — the
 * `soak:vm` entrypoint gates it behind `SBX_VM=1` (see `soak_vm_main.ts`).
 *
 * @module
 */

import { basename, join } from "@std/path";

import { ArtifactCache } from "../../images/cache.ts";
import { SupervisorCore } from "../../src/rootd/supervisor_core.ts";
import { GoldenArtifactLaunchPlanner } from "../../src/rootd/launch_planner.ts";
import { openAgentSession } from "../../src/rootd/agent_dialer.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import type { ArtifactReference } from "../../src/state/model.ts";
import {
  BitmapSubnetAllocator,
  DenoCommandEnumerator,
  DenoPidfileLister,
  DnsmasqController,
  EgressController,
  egressTableName,
  NetworkController,
  PortForwardController,
  reserveLiveSlots,
  slotOfTapName,
  type SubnetAllocator,
  sweepNetworkOrphans,
  TAP_NAME_PREFIX,
} from "../../src/rootd/network/mod.ts";

import {
  journalPhaseIdentity,
  type LeakAllowance,
  type LeakAudit,
  processIdentity,
} from "./leak_audit.ts";
import { buildInGuestAudit } from "./soak_vm_main.ts";
import type { SoakBackend, SoakSandboxHandle } from "./soak_runner.ts";

/** Resolved `SBX_VM_*` contract + the temp run tree for one soak backend. */
interface RealVmSoakConfig {
  /** Temp run dir (jail / overlay / journal live here); removed on close. */
  readonly workDir: string;
  /** Artifact cache root holding the golden set (`SBX_VM_CACHE`). */
  readonly cacheRoot: string;
  /** The golden set's manifest hash (`SBX_VM_MANIFEST_HASH`). */
  readonly manifestHash: string;
  /** Architecture the golden set was built for. */
  readonly arch: ArtifactReference["arch"];
  /** Jailer binary (`SBX_VM_JAILER_BIN`). */
  readonly jailerBin: string;
  /** Firecracker binary (`SBX_VM_FIRECRACKER_BIN`). */
  readonly firecrackerBin: string;
  /** Jailer `--chroot-base-dir` (`<workDir>/j`). */
  readonly chrootBaseDir: string;
  /** Per-boot overlay dir (`<workDir>/o`). */
  readonly overlayDir: string;
  /** Journal state file (`<workDir>/state.json`). */
  readonly journalPath: string;
  /** Upstream resolver each per-sandbox dnsmasq forwards to. */
  readonly upstreamDns: string;
}

/** One live sandbox plus the dataplane resources its allowance needs. */
interface RealLive extends SoakSandboxHandle {
  /** `/30` slot; keys the TAP name (`sbxtap<slot>`) + dnsmasq (`dns:<slot>`). */
  readonly slot: number;
  /** Host-side TAP device name (`sbxtap<slot>`). */
  readonly tapName: string;
  /** Per-boot nonce, needed to re-dial the agent in the `use` phase. */
  readonly bootNonce: Uint8Array;
}

/** The rebuildable half of the stack (dropped + recreated on a crash drill). */
interface RealStack {
  readonly planner: GoldenArtifactLaunchPlanner;
  readonly core: SupervisorCore;
  readonly allocator: SubnetAllocator;
  readonly network: NetworkController;
  readonly dnsmasq: DnsmasqController;
}

/** See the module doc. Build via {@linkcode RealMicrovmSoakBackend.provision}. */
export class RealMicrovmSoakBackend implements SoakBackend {
  readonly #config: RealVmSoakConfig;
  readonly #store: JsonFileSandboxStore;
  readonly #live = new Map<string, RealLive>();
  #stack: RealStack;
  #seq = 0;

  readonly audit: LeakAudit;
  readonly journalPath: string;

  private constructor(config: RealVmSoakConfig) {
    this.#config = config;
    this.journalPath = config.journalPath;
    this.#store = new JsonFileSandboxStore(config.journalPath);
    this.#stack = this.#makeStack();
    this.audit = buildInGuestAudit({
      cacheRoot: config.cacheRoot,
      journalPath: config.journalPath,
      overlayDir: config.overlayDir,
      chrootBaseDir: config.chrootBaseDir,
      mountScope: config.chrootBaseDir,
      // TAP names are `sbxtap<slot>`: pass the exact TAP prefix, not the broader
      // `sbx`, so an unrelated `sbx`-prefixed host iface is never flagged. The
      // M10 dataplane has no netns, so the netns prefix stays the default `sbx`.
      ownedTapPrefix: TAP_NAME_PREFIX,
      identityTokens: () => this.#identityTokens(),
    });
  }

  /**
   * Read the `SBX_VM_*` contract, carve a temp run tree, build the stack, and
   * install the one-time shared NAT / isolation / host-guard seal before any
   * launch (exactly as `main.ts` does on cold start).
   */
  static async provision(): Promise<RealMicrovmSoakBackend> {
    const config = await readRealVmConfig();
    const backend = new RealMicrovmSoakBackend(config);
    await backend.#stack.network.ensureGlobal();
    return backend;
  }

  /**
   * Build a fresh launch stack over the shared journal — a real planner with
   * the full M10 dataplane, its network + artifact reclaim hooks (network
   * FIRST, §8), and a `SupervisorCore` — mirroring `main.ts` `loadLaunchPlanner`.
   * Called once at construction and again per crash drill (the "restart".)
   */
  #makeStack(): RealStack {
    const cache = new ArtifactCache({ root: this.#config.cacheRoot });
    const allocator = new BitmapSubnetAllocator();
    const network = new NetworkController();
    const dnsmasq = new DnsmasqController();
    const egress = new EgressController();
    const portForward = new PortForwardController();
    const planner = new GoldenArtifactLaunchPlanner({
      cache,
      manifestHash: this.#config.manifestHash,
      arch: this.#config.arch,
      jailerBin: this.#config.jailerBin,
      firecrackerBin: this.#config.firecrackerBin,
      uid: 0,
      gid: 0,
      chrootBaseDir: this.#config.chrootBaseDir,
      overlayDir: this.#config.overlayDir,
      dataplane: {
        allocator,
        network,
        dnsmasq,
        egress,
        portForward,
        upstreamDns: this.#config.upstreamDns,
      },
    });
    const networkReclaimHook = planner.networkReclaimHook;
    const reclaimHooks = networkReclaimHook === undefined
      ? [planner.reclaimHook]
      : [networkReclaimHook, planner.reclaimHook];
    const core = new SupervisorCore({
      store: this.#store,
      planner,
      reclaimHooks,
      portForward,
      buildId: "studiobox/soak-vm",
    });
    return { planner, core, allocator, network, dnsmasq };
  }

  async create(): Promise<SoakSandboxHandle> {
    const entry = await this.#launchOne();
    this.#live.set(entry.executionId, entry);
    return entry;
  }

  async use(handle: SoakSandboxHandle): Promise<void> {
    // Exercise the real agent plane the way `tests/vm/real_stack.ts` does: dial
    // studioboxd over vsock and run the fail-closed negotiate → authenticate →
    // agent() handshake with the launch's minted credential, then dispose. A
    // leaked conn/session would keep the guest's outbound set live; the dispose
    // (and terminate) close it.
    const live = this.#live.get(handle.executionId);
    const coords = this.#stack.planner.coordinatesFor(handle.executionId);
    if (live === undefined || coords === undefined) return;
    const conn = await this.#stack.core.connectAgent(handle.executionId, {
      retryTimeoutMs: 5_000,
    });
    const session = await openAgentSession(conn, {
      credential: coords.credential,
      sandboxId: handle.sandboxId,
      bootNonce: live.bootNonce,
      callerBuildId: "studiobox/soak-vm",
      timeoutMs: 10_000,
    });
    await session[Symbol.asyncDispose]();
  }

  async terminate(handle: SoakSandboxHandle): Promise<void> {
    // Authoritative termination: the core runs the network + artifact reclaim
    // hooks (TAP / egress table / dnsmasq → overlay / refcount) and the record
    // reaches `terminated` before kill resolves.
    await this.#stack.core.kill(handle.executionId);
    this.#live.delete(handle.executionId);
  }

  async crashAndReconcile(batchSize: number): Promise<void> {
    const batch: RealLive[] = [];
    for (let i = 0; i < batchSize; i++) batch.push(await this.#launchOne());
    // Mid-fleet self-audit: the journal now holds `batchSize` ready records with
    // live VMMs + TAPs + dnsmasq; with the batch allowance the audit must still
    // be clean (no false positive on legitimately-live resources).
    await this.audit.assertClean(
      this.#allowanceForLive(batch),
      "mid-fleet before crash",
    );
    // Simulate a rootd crash: DROP the in-memory supervisor + planner + allocator
    // (the batch's real jailed VMMs keep running as orphans) and rebuild a fresh
    // stack over the SAME journal, then run the destructive cold-start reconcile
    // rootd runs at boot — reserve every surviving slot, re-seal the shared
    // tables, sweep half-provisioned network orphans, and reconcile — so every
    // orphan VMM + its TAP / egress table / dnsmasq is reaped and its record
    // converges to `terminated`.
    this.#stack = this.#makeStack();
    const journaled = await this.#store.list();
    reserveLiveSlots(this.#stack.allocator, journaled);
    await this.#stack.network.ensureGlobal();
    await sweepNetworkOrphans({
      records: journaled,
      enumerator: new DenoCommandEnumerator(),
      pidfiles: new DenoPidfileLister(),
      network: this.#stack.network,
      dnsmasq: this.#stack.dnsmasq,
    });
    await this.#stack.core.reconcile();
  }

  allowanceFor(live: readonly SoakSandboxHandle[]): LeakAllowance {
    const entries: RealLive[] = [];
    for (const handle of live) {
      const entry = this.#live.get(handle.executionId);
      if (entry !== undefined) entries.push(entry);
    }
    return this.#allowanceForLive(entries);
  }

  sampleRssBytes(): number {
    return Deno.memoryUsage().rss;
  }

  async close(): Promise<void> {
    for (const entry of [...this.#live.values()]) {
      await this.#stack.core.kill(entry.executionId).catch(() => {});
    }
    this.#live.clear();
    await Deno.remove(this.#config.workDir, { recursive: true }).catch(
      () => {},
    );
  }

  /** Launch one real sandbox to `ready` and resolve its dataplane resources. */
  async #launchOne(): Promise<RealLive> {
    const n = this.#seq++;
    const sandboxId = `sbx-sv${n}`;
    const executionId = `esv${n}`;
    const bootNonce = crypto.getRandomValues(new Uint8Array(32));
    const status = await this.#stack.core.launch({
      sandboxId,
      executionId,
      artifactId: "artifact-soak-vm",
      allocationId: "alloc-soak-vm",
      bootNonce,
      idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
    });
    // The planner journaled `resources.tapName` in the staging→booting commit
    // (BEFORE boot), so the live slot is authoritative from the journal.
    const record = await this.#store.get(sandboxId);
    const tapName = record?.resources.tapName;
    if (tapName === undefined) {
      throw new Error(
        `launched sandbox ${sandboxId} has no journaled tapName; is the dataplane configured?`,
      );
    }
    return {
      sandboxId,
      executionId,
      pid: status.pid!,
      slot: slotOfTapName(tapName),
      tapName,
      bootNonce,
    };
  }

  /** The per-class allowance identities for a set of live sandboxes. */
  #allowanceForLive(entries: readonly RealLive[]): LeakAllowance {
    const firecracker = basename(this.#config.firecrackerBin);
    return {
      // The in-guest `process` enumerator is the /proc-cmdline scan, so a live
      // VMM's pid is `pid=<n>`; it also matches the firecracker/jailer identity
      // tokens, hence the allowance.
      process: entries.map((entry) => processIdentity(entry.pid)),
      tap: entries.map((entry) => entry.tapName),
      // The seal egress table is `inet sbx_eg_<id>`, keyed by sandbox id. Soak
      // never exposeHttps, so there is no `ip sbx_pf_<id>` forward table.
      nftables: entries.map((entry) =>
        `inet:${egressTableName(entry.sandboxId)}`
      ),
      dnsmasq: entries.map((entry) => `dns:${entry.slot}`),
      overlay: entries.map((entry) => `ov-${entry.executionId}.ext4`),
      jailRoot: entries.map((entry) => join(firecracker, entry.executionId)),
      journalPhase: entries.map((entry) =>
        journalPhaseIdentity(entry.sandboxId, "ready")
      ),
    };
  }

  /**
   * Cmdline identity tokens for the orphan-VMM scan: the exec-file basenames
   * (which catch EVERY studiobox VMM, including an orphan with no journal
   * record) plus each live execution id.
   */
  #identityTokens(): string[] {
    const tokens = [
      basename(this.#config.firecrackerBin),
      basename(this.#config.jailerBin),
    ];
    for (const entry of this.#live.values()) tokens.push(entry.executionId);
    return tokens;
  }
}

/** Read the `SBX_VM_*` contract and carve a fresh temp run tree. */
async function readRealVmConfig(): Promise<RealVmSoakConfig> {
  const cacheRoot = requireEnv("SBX_VM_CACHE");
  const manifestHash = requireEnv("SBX_VM_MANIFEST_HASH");
  const workBase = requireEnv("SBX_VM_WORK");
  const jailerBin = Deno.env.get("SBX_VM_JAILER_BIN") ??
    "/usr/local/bin/jailer";
  const firecrackerBin = Deno.env.get("SBX_VM_FIRECRACKER_BIN") ??
    "/usr/local/bin/firecracker";
  const arch: ArtifactReference["arch"] = Deno.build.arch === "aarch64"
    ? "aarch64"
    : "x86_64";
  const upstreamDns = Deno.env.get("SBX_SOAK_UPSTREAM_DNS") || "1.1.1.1";
  // Short run root: the chroot base prefixes the guest vsock sun_path
  // (~104-byte sockaddr_un), so keep every segment terse.
  const workDir = await Deno.makeTempDir({ dir: workBase, prefix: "sv" });
  const overlayDir = join(workDir, "o");
  const chrootBaseDir = join(workDir, "j");
  await Deno.mkdir(overlayDir, { recursive: true });
  return {
    workDir,
    cacheRoot,
    manifestHash,
    arch,
    jailerBin,
    firecrackerBin,
    chrootBaseDir,
    overlayDir,
    journalPath: join(workDir, "state.json"),
    upstreamDns,
  };
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new Error(`soak:vm requires ${name}`);
  }
  return value;
}
