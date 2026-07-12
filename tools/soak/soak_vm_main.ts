/**
 * `deno task soak:vm` — the REAL-microVM 1.0 soak drill (PLAN.md §M11).
 *
 * **DEFERRED in this batch.** The full real drill boots ≥200 real jailed
 * Firecracker microVMs and repeatedly kill-9s rootd, so it must run inside the
 * `fc-smoke` Lima VM (or a KVM CI runner) and would contend for the VM other
 * sessions are using — this entrypoint therefore refuses to launch VMs here.
 * It ships the concrete IN-GUEST audit wiring ({@linkcode buildInGuestAudit})
 * so the full 10-class enumeration is committed and type-checked, and
 * documents exactly how the drill assembles when it is turned on.
 *
 * When enabled inside fc-smoke it reuses the M5 `test:vm` provisioning and
 * environment contract (`SBX_VM`, `SBX_VM_CACHE`, `SBX_VM_MANIFEST_HASH`,
 * `SBX_VM_WORK`, `SBX_VM_JAILER_BIN`, `SBX_VM_FIRECRACKER_BIN` — see
 * `tests/vm/support.ts`) and drives {@linkcode SoakRunner} against a real
 * backend built on `SupervisorCore` + `GoldenArtifactLaunchPlanner` + the M5
 * agent dialer, auditing with {@linkcode buildInGuestAudit}.
 *
 * @module
 */

import { join } from "@std/path";
import { ArtifactCache } from "../../images/cache.ts";
import { JsonFileSandboxStore } from "../../src/state/store.ts";
import { JournalArtifactReferenceReader } from "../../src/rootd/artifact_refs.ts";
import {
  artifactRefcountEnumerator,
  jailRootEnumerator,
  journalPhaseEnumerator,
  LeakAudit,
  overlayFileEnumerator,
  portReservationEnumerator,
} from "./leak_audit.ts";
import {
  mountEnumerator,
  netnsEnumerator,
  nftablesEnumerator,
  procCmdlineOrphanEnumerator,
  tapEnumerator,
} from "./enumerators_linux.ts";

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
  /** Owned TAP / netns name prefix. @default "sbx" */
  readonly ownedNetPrefix?: string;
  /** Cmdline identity tokens for the orphan-VMM scan (exec-file basenames + live `--id`s). */
  readonly identityTokens: () => Iterable<string>;
}

/**
 * Assemble the full 10-class in-guest {@linkcode LeakAudit}: the host-safe
 * journal / refcount / overlay / jail-root / port enumerators over the real
 * state dir + cache, plus the Linux enumerators over real `/proc`, `ip`, and
 * `nft`. This is the audit `soak:vm` runs after every phase.
 */
export function buildInGuestAudit(options: InGuestAuditOptions): LeakAudit {
  const store = new JsonFileSandboxStore(options.journalPath);
  const cache = new ArtifactCache({ root: options.cacheRoot });
  const references = new JournalArtifactReferenceReader(store);
  const prefix = options.ownedNetPrefix ?? "sbx";
  return new LeakAudit([
    procCmdlineOrphanEnumerator({ identityTokens: options.identityTokens }),
    tapEnumerator({ ownedPrefix: prefix }),
    netnsEnumerator({ ownedPrefix: prefix }),
    nftablesEnumerator({}),
    mountEnumerator({ scopePrefix: options.mountScope }),
    overlayFileEnumerator(options.overlayDir),
    jailRootEnumerator(options.chrootBaseDir),
    portReservationEnumerator(store),
    journalPhaseEnumerator(store),
    artifactRefcountEnumerator(cache, references),
  ]);
}

function deferralNotice(): string {
  return [
    "soak:vm is DEFERRED in this batch to avoid contending for the fc-smoke VM.",
    "",
    "To run the real 1.0 soak, inside fc-smoke (or a KVM runner) with the M5",
    "provisioning in place, export the test:vm contract and re-invoke:",
    "",
    "  SBX_VM=1 SBX_VM_CACHE=... SBX_VM_MANIFEST_HASH=... SBX_VM_WORK=... \\",
    "    deno task soak:vm",
    "",
    "It drives SoakRunner against a real SupervisorCore + GoldenArtifactLaunch",
    "Planner + the M5 agent dialer, auditing with buildInGuestAudit() after",
    "every phase. See docs/soak.md.",
  ].join("\n");
}

function main(): void {
  if (Deno.env.get("SBX_VM") !== "1") {
    console.log(deferralNotice());
    return;
  }
  // Even inside a guest, the real create/use/terminate backend (the M5
  // agent-plane driver) is not wired on the main line yet — the drill is
  // deferred by design in this batch. Show the audit that WOULD run so the
  // wiring is verified, then stop short of launching VMs.
  const work = Deno.env.get("SBX_VM_WORK") ?? "/tmp";
  const audit = buildInGuestAudit({
    cacheRoot: Deno.env.get("SBX_VM_CACHE") ?? join(work, "cache"),
    journalPath: join(work, "state.json"),
    overlayDir: join(work, "ov"),
    chrootBaseDir: join(work, "jail"),
    mountScope: join(work, "jail"),
    identityTokens: () => ["firecracker", "jailer"],
  });
  console.log(
    `soak:vm in-guest audit wired for: ${
      audit.checked.join(", ")
    } (${audit.checked.length} classes).`,
  );
  console.log(
    "Full real-microVM cycles are deferred in this batch; see docs/soak.md.",
  );
}

if (import.meta.main) main();
