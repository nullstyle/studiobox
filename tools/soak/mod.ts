/**
 * `tools/soak` — the studiobox no-leak SOAK HARNESS + LeakAudit framework
 * (PLAN.md §M11, the drill that DEFINES studiobox 1.0).
 *
 * - {@linkcode LeakAudit} + the host-safe enumerator factories (`leak_audit.ts`)
 *   — enumerate and assert-zero every leak class, independently reportable.
 * - The Linux / in-guest enumerators (`enumerators_linux.ts`) — real `/proc`,
 *   `ip`, `nft` for the classes host-safe code cannot see.
 * - {@linkcode SoakRunner} (`soak_runner.ts`) — drives N create→use→terminate
 *   cycles + periodic kill-9-mid-fleet + reconcile against an injected
 *   {@linkcode SoakBackend}, auditing after every phase and enforcing budgets.
 * - {@linkcode FakeVmmSoakBackend} (`fake_backend.ts`) — the host-safe backend
 *   over fake VMM/jailer shims + a temp journal.
 * - {@linkcode RealMicrovmSoakBackend} (`real_backend.ts`) — the real-microVM
 *   backend over the golden launch stack + M10 dataplane, run by `soak:vm`
 *   inside fc-smoke.
 * - {@linkcode buildInGuestAudit} (`soak_vm_main.ts`) — the concrete in-guest
 *   audit wiring `soak:vm` uses.
 *
 * Any milestone can self-check for leaks by pointing a {@linkcode LeakAudit}
 * at its state-dir / jail-base / artifact-cache. See docs/soak.md.
 *
 * @module
 */

export * from "./leak_audit.ts";
export * from "./enumerators_linux.ts";
export * from "./soak_runner.ts";
export * from "./fake_backend.ts";
export { RealMicrovmSoakBackend } from "./real_backend.ts";
export { runFakeSoak } from "./soak_main.ts";
export { buildInGuestAudit, type InGuestAuditOptions } from "./soak_vm_main.ts";
