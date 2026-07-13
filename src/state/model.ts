/** Durable, host-owned sandbox lifecycle state. */

export const SANDBOX_RECORD_VERSION = 2 as const;

/**
 * Versions {@link validateSandboxRecord} accepts. Version 1 predates the
 * artifact reference: a version-1 record is still valid but may never carry
 * `artifact` — it is treated as referencing no artifact set.
 */
export type SandboxRecordSchemaVersion = 1 | typeof SANDBOX_RECORD_VERSION;

export type SandboxPhase =
  | "allocating"
  | "staging"
  | "booting"
  | "ready"
  | "terminating"
  | "terminated"
  | "reconciling"
  | "quarantined";

export type MachineJournalPhase =
  | "reserved"
  | "launching"
  | "running"
  | "reclaiming";

/**
 * Serializable shape of the low-level Firecracker registry record.
 *
 * It is intentionally structural: the adapter validates it against the exact
 * pinned package's `JailRecord`, while the state store remains dependency-free.
 */
export interface JailRecordState {
  version: 1;
  vmId: string;
  pid: number | null;
  apiSocketPath: string;
  stateDir: string;
  ownsStateDir: boolean;
  vsockUdsPath?: string;
  vsockListenerPaths: string[];
  pidfilePath?: string;
  chrootDir?: string;
  createdAt: string;
  metadata?: Record<string, string>;
}

/** Low-level state nested in the one authoritative sandbox record. */
export interface MachineJournalState {
  /** New for every boot attempt and safe for use as the jailer id. */
  executionId: string;
  phase: MachineJournalPhase;
  jailRecord?: JailRecordState;
  cgroupPath?: string;
  updatedAt: string;
}

/**
 * Journal reference to the artifact set an execution boots from: the
 * manifest hash (the `images/` cache key) plus the architecture the set was
 * built for. Intentionally structural — the state layer never imports the
 * artifact pipeline; `images/pins.ts` `ArtifactArch` is mirrored here the
 * same way {@link JailRecordState} mirrors the package `JailRecord`.
 *
 * The reference is journaled BEFORE any spawn so that artifact GC
 * (`images/cache.ts`) can refuse to delete a set a not-yet-terminated
 * record still cites, even across a supervisor crash.
 */
export interface ArtifactReference {
  /** sha256 hex over the manifest input pins (`images/manifest.ts`). */
  manifestHash: string;
  /** Guest architecture the set was built for. */
  arch: "aarch64" | "x86_64";
}

/** One host→guest forward installed by `exposeHttp` (M10). */
export interface ExposedPort {
  /** Reserved forward-range host port (40100..40199) dialed on 127.0.0.1. */
  readonly hostPort: number;
  /** Guest port the forward DNATs to (1..65535). */
  readonly guestPort: number;
}

/** Studiobox-owned resources that the Firecracker package cannot reclaim. */
export interface SandboxResources {
  uid?: number;
  gid?: number;
  overlayPath?: string;
  /** Host-side TAP device name (`sbxtap<slot>`); written by the M10 planner. */
  tapName?: string;
  /** Reserved for a future netns model; unused in the M10 host-namespace path. */
  netnsPath?: string;
  /** Host gateway address on the TAP (`10.201.<t>.<b+1>`). */
  hostIp?: string;
  /** Guest source address (`10.201.<t>.<b+2>`); the egress anti-spoof source. */
  guestIp?: string;
  /** The sandbox's /30 subnet (`10.201.<t>.<b>/30`). */
  subnet?: string;
  /** Pidfile of the per-sandbox dnsmasq (`/run/studiobox/dns/<slot>.pid`). */
  dnsmasqPidfile?: string;
  exposedPorts: ExposedPort[];
}

/** The single durable authority for one public sandbox id. */
export interface SandboxRecord {
  schemaVersion: SandboxRecordSchemaVersion;
  id: string;
  revision: number;
  generation: number;
  phase: SandboxPhase;
  createdAt: string;
  updatedAt: string;
  machine?: MachineJournalState;
  /** Requires schema version 2; absent means "references no artifact set". */
  artifact?: ArtifactReference;
  /**
   * Durable warm-template pin marker (snapshot-restore §1.2). `true` on a record
   * whose execution restored from (and pinned) a warm template keyed by
   * {@link ArtifactReference.manifestHash}; absent/false on a cold record, which
   * pinned no template. It is journaled BEFORE the restore spawns so
   * `TemplateReclaimHook` can release the template refcount from the SURVIVING
   * record after a rootd crash + destructive reconcile — when the in-process pin
   * map is empty — exactly as the artifact refcount survives via
   * {@link ArtifactReference}. Requires schema version 2.
   */
  templatePinned?: boolean;
  resources: SandboxResources;
  terminationReason?: string;
}

export interface NewSandboxRecordOptions {
  id: string;
  createdAt?: string;
  generation?: number;
}

const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SANDBOX_PHASES: readonly SandboxPhase[] = [
  "allocating",
  "staging",
  "booting",
  "ready",
  "terminating",
  "terminated",
  "reconciling",
  "quarantined",
];
const MACHINE_PHASES: readonly MachineJournalPhase[] = [
  "reserved",
  "launching",
  "running",
  "reclaiming",
];
const ARTIFACT_REFERENCE_ARCHES: readonly ArtifactReference["arch"][] = [
  "aarch64",
  "x86_64",
];
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function assertSandboxId(id: string): void {
  if (!SANDBOX_ID.test(id)) {
    throw new TypeError(
      "sandbox id must be 1-128 ASCII alphanumeric, underscore, or hyphen characters",
    );
  }
}

export function newSandboxRecord(
  options: NewSandboxRecordOptions,
): SandboxRecord {
  assertSandboxId(options.id);
  const timestamp = options.createdAt ?? new Date().toISOString();
  assertTimestamp(timestamp, "createdAt");
  assertNonNegativeInteger(options.generation ?? 0, "generation");
  return {
    schemaVersion: SANDBOX_RECORD_VERSION,
    id: options.id,
    revision: 0,
    generation: options.generation ?? 0,
    phase: "allocating",
    createdAt: timestamp,
    updatedAt: timestamp,
    resources: { exposedPorts: [] },
  };
}

export function validateSandboxRecord(value: unknown): SandboxRecord {
  const record = assertRecord(value, "sandbox record") as Partial<
    SandboxRecord
  >;
  assertKeys(record, [
    "schemaVersion",
    "id",
    "revision",
    "generation",
    "phase",
    "createdAt",
    "updatedAt",
    "machine",
    "artifact",
    "templatePinned",
    "resources",
    "terminationReason",
  ], "sandbox record");
  if (
    record.schemaVersion !== SANDBOX_RECORD_VERSION &&
    record.schemaVersion !== 1
  ) {
    throw new TypeError("unsupported sandbox record schema version");
  }
  if (typeof record.id !== "string") {
    throw new TypeError("sandbox record id must be a string");
  }
  assertSandboxId(record.id);
  assertNonNegativeInteger(record.revision, "revision");
  assertNonNegativeInteger(record.generation, "generation");
  if (!SANDBOX_PHASES.includes(record.phase as SandboxPhase)) {
    throw new TypeError("sandbox record phase is invalid");
  }
  assertTimestamp(record.createdAt, "createdAt");
  assertTimestamp(record.updatedAt, "updatedAt");
  if (record.terminationReason !== undefined) {
    assertText(record.terminationReason, "terminationReason", 512);
  }
  validateResources(record.resources);
  if (record.machine !== undefined) {
    validateMachine(record.machine);
  }
  if (record.artifact !== undefined) {
    if (record.schemaVersion === 1) {
      throw new TypeError(
        "sandbox record artifact requires schema version 2",
      );
    }
    validateArtifactReference(record.artifact);
  }
  if (record.templatePinned !== undefined) {
    if (record.schemaVersion === 1) {
      throw new TypeError(
        "sandbox record templatePinned requires schema version 2",
      );
    }
    if (typeof record.templatePinned !== "boolean") {
      throw new TypeError("sandbox record templatePinned must be a boolean");
    }
  }
  return structuredClone(record as SandboxRecord);
}

function validateArtifactReference(
  value: unknown,
): asserts value is ArtifactReference {
  const artifact = assertRecord(value, "artifact reference") as Partial<
    ArtifactReference
  >;
  assertKeys(artifact, ["manifestHash", "arch"], "artifact reference");
  if (
    typeof artifact.manifestHash !== "string" ||
    !SHA256_HEX.test(artifact.manifestHash)
  ) {
    throw new TypeError(
      "artifact manifestHash must be a lowercase sha256 hex hash",
    );
  }
  if (
    !ARTIFACT_REFERENCE_ARCHES.includes(
      artifact.arch as ArtifactReference["arch"],
    )
  ) {
    throw new TypeError("artifact arch is invalid");
  }
}

function validateResources(value: unknown): asserts value is SandboxResources {
  const resources = assertRecord(value, "sandbox resources") as Partial<
    SandboxResources
  >;
  assertKeys(resources, [
    "uid",
    "gid",
    "overlayPath",
    "tapName",
    "netnsPath",
    "hostIp",
    "guestIp",
    "subnet",
    "dnsmasqPidfile",
    "exposedPorts",
  ], "sandbox resources");
  for (const field of ["uid", "gid"] as const) {
    if (resources[field] !== undefined) {
      assertUnsignedInteger(resources[field], field, 0xffff_ffff);
    }
  }
  for (
    const field of [
      "overlayPath",
      "tapName",
      "netnsPath",
      "hostIp",
      "guestIp",
      "subnet",
      "dnsmasqPidfile",
    ] as const
  ) {
    if (resources[field] !== undefined) {
      assertText(resources[field], field, 4_096);
    }
  }
  if (!Array.isArray(resources.exposedPorts)) {
    throw new TypeError("sandbox exposedPorts must be an array");
  }
  // Each forward is a {hostPort (40100..40199), guestPort (1..65535)} pair;
  // the host port is the leased forward-range slot and is unique per record.
  const hostPorts = new Set<number>();
  for (const entry of resources.exposedPorts) {
    const port = assertRecord(entry, "exposed port") as Partial<ExposedPort>;
    assertKeys(port, ["hostPort", "guestPort"], "exposed port");
    assertUnsignedInteger(port.hostPort, "exposed hostPort", 40_199, 40_100);
    assertUnsignedInteger(port.guestPort, "exposed guestPort", 65_535, 1);
    const hostPort = port.hostPort as number;
    if (hostPorts.has(hostPort)) {
      throw new TypeError("sandbox exposedPorts hostPort must be unique");
    }
    hostPorts.add(hostPort);
  }
}

function validateMachine(value: unknown): asserts value is MachineJournalState {
  const machine = assertRecord(value, "machine journal") as Partial<
    MachineJournalState
  >;
  assertKeys(machine, [
    "executionId",
    "phase",
    "jailRecord",
    "cgroupPath",
    "updatedAt",
  ], "machine journal");
  if (
    typeof machine.executionId !== "string" ||
    !EXECUTION_ID.test(machine.executionId)
  ) {
    throw new TypeError("machine executionId is invalid");
  }
  if (!MACHINE_PHASES.includes(machine.phase as MachineJournalPhase)) {
    throw new TypeError("machine journal phase is invalid");
  }
  assertTimestamp(machine.updatedAt, "machine.updatedAt");
  if (machine.cgroupPath !== undefined) {
    assertText(machine.cgroupPath, "machine.cgroupPath", 4_096);
  }
  if (machine.jailRecord !== undefined) {
    validateJailRecord(machine.jailRecord, machine.executionId);
  }
}

function validateJailRecord(value: unknown, executionId: string): void {
  const jail = assertRecord(value, "jail record") as Partial<JailRecordState>;
  assertKeys(jail, [
    "version",
    "vmId",
    "pid",
    "apiSocketPath",
    "stateDir",
    "ownsStateDir",
    "vsockUdsPath",
    "vsockListenerPaths",
    "pidfilePath",
    "chrootDir",
    "createdAt",
    "metadata",
  ], "jail record");
  if (jail.version !== 1 || jail.vmId !== executionId) {
    throw new TypeError("jail record identity does not match its execution");
  }
  if (jail.pid !== null) {
    assertUnsignedInteger(jail.pid, "jail pid", 0x7fff_ffff, 1);
  }
  for (const field of ["apiSocketPath", "stateDir"] as const) {
    assertText(jail[field], `jail.${field}`, 4_096);
  }
  if (typeof jail.ownsStateDir !== "boolean") {
    throw new TypeError("jail.ownsStateDir must be a boolean");
  }
  for (const field of ["vsockUdsPath", "pidfilePath", "chrootDir"] as const) {
    if (jail[field] !== undefined) {
      assertText(jail[field], `jail.${field}`, 4_096);
    }
  }
  if (!Array.isArray(jail.vsockListenerPaths)) {
    throw new TypeError("jail.vsockListenerPaths must be an array");
  }
  jail.vsockListenerPaths.forEach((path) =>
    assertText(path, "jail.vsockListenerPath", 4_096)
  );
  assertTimestamp(jail.createdAt, "jail.createdAt");
  if (jail.metadata !== undefined) {
    const metadata = assertRecord(jail.metadata, "jail metadata");
    if (Object.keys(metadata).length > 64) {
      throw new TypeError("jail metadata exceeds 64 entries");
    }
    for (const [key, entry] of Object.entries(metadata)) {
      assertText(key, "jail metadata key", 128);
      assertText(entry, "jail metadata value", 1_024, true);
    }
  }
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: object,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${field} contains unknown field ${key}`);
    }
  }
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  assertUnsignedInteger(value, field, Number.MAX_SAFE_INTEGER);
}

function assertUnsignedInteger(
  value: unknown,
  field: string,
  maximum: number,
  minimum = 0,
): void {
  if (
    !Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

function assertTimestamp(value: unknown, field: string): void {
  if (
    typeof value !== "string" || value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a bounded timestamp`);
  }
}

function assertText(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = false,
): void {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new TypeError(`${field} must be bounded text`);
  }
}
