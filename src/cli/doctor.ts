/**
 * `host doctor` — end-to-end health of a provisioned studiobox host
 * (DESIGN.md §11; PLAN.md §M9).
 *
 * The doctor drives a {@linkcode HostProbe} through the same sequence a real
 * client would: open a HostControl session (negotiate + authenticate), read the
 * capacity ledger, prove the whole hostd -> rootd path by creating and killing a
 * throwaway canary sandbox, and list any quarantined records so a wedged reclaim
 * surfaces instead of hiding (DESIGN.md §6). {@linkcode runDoctor} is pure logic
 * over the seam, so it is tested against a FAKE hostd; the real seam
 * ({@linkcode import("./host_client.ts").createHostProbe}) dials the forwarded
 * control port.
 *
 * A failing stage does not abort the run: every remaining check that can still
 * be attempted is, so the report pinpoints WHICH stage is wedged (the M9 demo:
 * "doctor detects and reports a deliberately wedged daemon"). Once the session
 * itself cannot be established, downstream checks are recorded as failed with
 * that cause rather than retried.
 *
 * @module
 */

/** Capacity ledger snapshot as the doctor reads it over the wire. */
export interface HostCapacitySnapshot {
  readonly memoryTotalMiB: number;
  readonly memoryCommittedMiB: number;
  readonly vcpusTotal: number;
  readonly vcpusCommitted: number;
  readonly sandboxLimit: number;
  readonly sandboxCount: number;
}

/** One quarantined sandbox record (DESIGN.md §6). */
export interface QuarantinedRecord {
  readonly id: string;
  readonly reason: string;
}

/**
 * The hostd-facing seam the doctor drives. The real implementation dials the
 * forwarded control port; the test fake answers in-process.
 */
export interface HostProbe {
  /** Open the session: negotiate + authenticate against hostd. */
  negotiate(): Promise<void>;
  /** Read the host capacity ledger. */
  capacity(): Promise<HostCapacitySnapshot>;
  /** Create a throwaway canary sandbox; resolves with its id. */
  createCanary(): Promise<string>;
  /** Kill the canary by id. */
  killCanary(id: string): Promise<void>;
  /** List quarantined records (best-effort; derived from `list()`). */
  listQuarantined(): Promise<readonly QuarantinedRecord[]>;
  /** Release the session (idempotent). */
  close(): Promise<void>;
}

/** One diagnostic check. */
export interface DoctorCheck {
  readonly name: DoctorCheckName;
  readonly ok: boolean;
  readonly detail: string;
}

export type DoctorCheckName =
  | "negotiate"
  | "capacity"
  | "canary"
  | "quarantine";

/** Aggregate doctor verdict. */
export interface DoctorReport {
  readonly healthy: boolean;
  readonly checks: readonly DoctorCheck[];
  /** Capacity snapshot when the capacity check ran, else undefined. */
  readonly capacity?: HostCapacitySnapshot;
  /** Quarantined records the quarantine check found (possibly empty). */
  readonly quarantined: readonly QuarantinedRecord[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the doctor sequence against a probe, always closing it. */
export async function runDoctor(probe: HostProbe): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let capacity: HostCapacitySnapshot | undefined;
  let quarantined: readonly QuarantinedRecord[] = [];

  try {
    // 1) Session: negotiate + authenticate. A failure here wedges everything
    // downstream — record them as failed with the cause and stop probing.
    try {
      await probe.negotiate();
      checks.push({
        name: "negotiate",
        ok: true,
        detail: "negotiated + authenticated",
      });
    } catch (error) {
      const detail = `hostd session failed: ${errorText(error)}`;
      checks.push({ name: "negotiate", ok: false, detail });
      for (const name of ["capacity", "canary", "quarantine"] as const) {
        checks.push({ name, ok: false, detail: "skipped: no hostd session" });
      }
      return { healthy: false, checks, quarantined };
    }

    // 2) Capacity ledger.
    try {
      capacity = await probe.capacity();
      checks.push({
        name: "capacity",
        ok: true,
        detail:
          `${capacity.sandboxCount}/${capacity.sandboxLimit} sandboxes, ` +
          `${capacity.memoryCommittedMiB}/${capacity.memoryTotalMiB} MiB, ` +
          `${capacity.vcpusCommitted}/${capacity.vcpusTotal} vCPU committed`,
      });
    } catch (error) {
      checks.push({
        name: "capacity",
        ok: false,
        detail: `capacity() failed: ${errorText(error)}`,
      });
    }

    // 3) Canary: create + kill, proving the hostd -> rootd launch path.
    try {
      const id = await probe.createCanary();
      try {
        await probe.killCanary(id);
        checks.push({
          name: "canary",
          ok: true,
          detail: `created + killed ${id}`,
        });
      } catch (error) {
        checks.push({
          name: "canary",
          ok: false,
          detail: `canary ${id} created but kill failed: ${errorText(error)}`,
        });
      }
    } catch (error) {
      checks.push({
        name: "canary",
        ok: false,
        detail: `canary create failed: ${errorText(error)}`,
      });
    }

    // 4) Quarantine listing. Listing succeeding is the check; the presence of
    // records is informational (surfaced, not a health failure by itself).
    try {
      quarantined = await probe.listQuarantined();
      checks.push({
        name: "quarantine",
        ok: true,
        detail: quarantined.length === 0
          ? "no quarantined records"
          : `${quarantined.length} quarantined: ${
            quarantined.map((r) => r.id).join(", ")
          }`,
      });
    } catch (error) {
      checks.push({
        name: "quarantine",
        ok: false,
        detail: `list() failed: ${errorText(error)}`,
      });
    }
  } finally {
    await probe.close().catch(() => {});
  }

  const healthy = checks.every((check) => check.ok);
  return {
    healthy,
    checks,
    ...(capacity === undefined ? {} : { capacity }),
    quarantined,
  };
}

/** Render a doctor report as human-readable lines. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    report.healthy ? "host doctor: HEALTHY" : "host doctor: UNHEALTHY",
  );
  for (const check of report.checks) {
    lines.push(
      `  [${check.ok ? "ok" : "FAIL"}] ${check.name}: ${check.detail}`,
    );
  }
  if (report.quarantined.length > 0) {
    lines.push("  quarantined records (host doctor surfaced these):");
    for (const record of report.quarantined) {
      lines.push(`    - ${record.id}: ${record.reason}`);
    }
  }
  return lines.join("\n");
}
