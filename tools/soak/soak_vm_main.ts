/**
 * `deno task soak:vm` — the REAL-microVM 1.0 soak drill (PLAN.md §M11).
 *
 * When `SBX_VM=1` this boots real jailed Firecracker microVMs through the real
 * launch stack + M10 dataplane and drives {@linkcode SoakRunner} against
 * {@linkcode RealMicrovmSoakBackend}: N `create → use → terminate` cycles with
 * periodic kill-9-mid-fleet + destructive reconcile, auditing the full 10-class
 * (now 11-class) {@linkcode buildInGuestAudit} after every phase and enforcing
 * real-VM budgets. It must run inside the `fc-smoke` Lima VM (or a KVM CI
 * runner) as root — the jailer needs root to chroot / mknod / drop privilege —
 * so absent `SBX_VM=1` it prints the deferral notice and does nothing (the
 * host-safe drill is `deno task soak`, `soak_main.ts`).
 *
 * It reuses the M5 `test:vm` provisioning + environment contract (`SBX_VM`,
 * `SBX_VM_CACHE`, `SBX_VM_MANIFEST_HASH`, `SBX_VM_WORK`, `SBX_VM_JAILER_BIN`,
 * `SBX_VM_FIRECRACKER_BIN` — see `tests/vm/support.ts`) and honours the same
 * `SBX_SOAK_*` knobs as the host-safe drill (cycles / crashes / batch / seed).
 *
 * @module
 */

import { ArtifactCache } from "../../images/cache.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { JournalArtifactReferenceReader } from "../../src/rootd/artifact_refs.ts";
import { TAP_NAME_PREFIX } from "../../src/rootd/network/allocator.ts";
import {
  artifactRefcountEnumerator,
  jailRootEnumerator,
  journalPhaseEnumerator,
  LeakAudit,
  overlayFileEnumerator,
  portReservationEnumerator,
} from "./leak_audit.ts";
import {
  dnsmasqEnumerator,
  mountEnumerator,
  netnsEnumerator,
  nftablesEnumerator,
  procCmdlineOrphanEnumerator,
  tapEnumerator,
} from "./enumerators_linux.ts";
import {
  type SoakBudgets,
  SoakRunner,
  type SoakRunOptions,
} from "./soak_runner.ts";
import { RealMicrovmSoakBackend } from "./real_backend.ts";

/** Inputs for the concrete in-guest audit wiring. */
export interface InGuestAuditOptions {
  /** Artifact cache root holding the golden set (`SBX_VM_CACHE`). */
  readonly cacheRoot: string;
  /** Journal state file the real rootd writes. */
  readonly journalPath: string;
  /** Per-boot overlay directory. */
  readonly overlayDir: string;
  /** Jailer `--chroot-base-dir`. */
  readonly chrootBaseDir: string;
  /** Jail base whose mounts are studiobox-owned (usually `chrootBaseDir`). */
  readonly mountScope: string;
  /**
   * Owned TAP interface prefix. TAP devices are `sbxtap<slot>`, so this MUST be
   * `sbxtap` (not the broader `sbx`) or the audit would also flag unrelated
   * `sbx`-prefixed host interfaces. @default {@link TAP_NAME_PREFIX} (`sbxtap`)
   */
  readonly ownedTapPrefix?: string;
  /**
   * Owned network-namespace prefix. The M10 host-namespace dataplane creates no
   * netns, so this enumerator is normally empty; the prefix stays `sbx` for a
   * future netns model. @default "sbx"
   */
  readonly ownedNetnsPrefix?: string;
  /** Cmdline identity tokens for the orphan-VMM scan (exec-file basenames + live `--id`s). */
  readonly identityTokens: () => Iterable<string>;
}

/**
 * Assemble the full in-guest {@linkcode LeakAudit}: the host-safe journal /
 * refcount / overlay / jail-root / port enumerators over the real state dir +
 * cache, plus the Linux enumerators over real `/proc`, `ip`, `nft`, and
 * `pgrep` — the `nftables` enumerator now covers BOTH `inet sbx_eg_*` egress
 * tables and `ip sbx_pf_*` port-forward tables, and the new `dnsmasq`
 * enumerator covers the per-sandbox forwarders. This is the audit `soak:vm`
 * runs after every phase.
 *
 * TAP names (`sbxtap<slot>`) and netns names use DIFFERENT prefixes, so each
 * enumerator gets its own (`sbxtap` vs `sbx`); the mount / jail scopes come
 * from the real jail base.
 */
export function buildInGuestAudit(options: InGuestAuditOptions): LeakAudit {
  const store = new JsonFileSandboxStore(options.journalPath);
  const cache = new ArtifactCache({ root: options.cacheRoot });
  const references = new JournalArtifactReferenceReader(store);
  const tapPrefix = options.ownedTapPrefix ?? TAP_NAME_PREFIX;
  const netnsPrefix = options.ownedNetnsPrefix ?? "sbx";
  return new LeakAudit([
    procCmdlineOrphanEnumerator({ identityTokens: options.identityTokens }),
    tapEnumerator({ ownedPrefix: tapPrefix }),
    netnsEnumerator({ ownedPrefix: netnsPrefix }),
    nftablesEnumerator({}),
    dnsmasqEnumerator({}),
    mountEnumerator({ scopePrefix: options.mountScope }),
    overlayFileEnumerator(options.overlayDir),
    jailRootEnumerator(options.chrootBaseDir),
    portReservationEnumerator(store),
    journalPhaseEnumerator(store),
    artifactRefcountEnumerator(cache, references),
  ]);
}

/** Real-VM budgets: a cold jailed microVM boot is a few seconds, not ms. */
const REAL_VM_BUDGETS: Partial<SoakBudgets> = Object.freeze({
  createP95Ms: 12_000,
});

function deferralNotice(): string {
  return [
    "soak:vm requires SBX_VM=1 and a Linux+KVM+root host (the fc-smoke Lima VM",
    "or a KVM CI runner); the jailer needs root to chroot / mknod / drop privs.",
    "On any other host run the host-safe drill instead: `deno task soak`.",
    "",
    "To run the real 1.0 soak, inside fc-smoke with the M5 provisioning in place,",
    "export the test:vm contract and re-invoke:",
    "",
    "  SBX_VM=1 SBX_VM_CACHE=... SBX_VM_MANIFEST_HASH=... SBX_VM_WORK=... \\",
    "    deno task soak:vm",
    "",
    "It drives SoakRunner against a real SupervisorCore + GoldenArtifactLaunch",
    "Planner + the M10 dataplane, auditing with buildInGuestAudit() after every",
    "phase. See docs/soak.md.",
  ].join("\n");
}

function intFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  if (Deno.env.get("SBX_VM") !== "1") {
    console.log(deferralNotice());
    return;
  }

  const options: SoakRunOptions = {
    cycles: intFromEnv("SBX_SOAK_CYCLES", 200),
    batchSize: intFromEnv("SBX_SOAK_BATCH", 2),
    seed: intFromEnv("SBX_SOAK_SEED", 1),
    budgets: REAL_VM_BUDGETS,
  };
  const crashes = Deno.env.get("SBX_SOAK_CRASHES");
  if (crashes !== undefined && crashes !== "") {
    (options as { crashes?: number }).crashes = intFromEnv(
      "SBX_SOAK_CRASHES",
      12,
    );
  }

  const backend = await RealMicrovmSoakBackend.provision();
  try {
    const result = await new SoakRunner(backend).run(options);
    console.log(
      `SOAK:VM PASS — ${result.cycles} cycles / ${result.crashes} reconciles clean; no leaks across ${result.audits} audits`,
    );
  } catch (error) {
    console.error(
      `SOAK:VM FAIL — ${
        error instanceof Error ? error.stack ?? error.message : error
      }`,
    );
    Deno.exit(1);
  } finally {
    await backend.close();
  }
}

if (import.meta.main) await main();
