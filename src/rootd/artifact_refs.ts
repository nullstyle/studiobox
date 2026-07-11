/**
 * Journal-backed artifact references (the M2 journal feeding the M4 GC).
 *
 * `images/cache.ts` `gc()` refuses to delete an artifact set the journal
 * still references; this adapter is the journal side of that contract. A
 * manifest hash is referenced iff some {@linkcode SandboxRecord} that has
 * not reached `terminated` cites it in its `artifact` field — the field
 * {@linkcode SupervisorCore.launch} journals BEFORE any spawn, so a
 * booting execution's artifact set survives GC even across a supervisor
 * crash. Records without the field (including schema-version-1 records
 * from before it existed) are valid but reference nothing.
 *
 * `quarantined` keeps its reference on purpose (fail closed, matching the
 * cache's own corrupt-refcount stance): quarantine means reclaim did not
 * finish, so the inputs the execution booted from stay available to the
 * operator until the record is resolved.
 *
 * @module
 */

import type { ArtifactReferenceReader } from "../../images/cache.ts";
import type { SandboxRecord } from "../state/model.ts";

/**
 * The read-only slice of {@linkcode SandboxStateStore} the reader needs.
 * Any journal owner (hostd, tests) can hand in its own view.
 */
export interface SandboxRecordSource {
  list(): Promise<SandboxRecord[]>;
}

/** The single phase whose records no longer pin their artifact set. */
const RELEASING_PHASE = "terminated";

/**
 * {@linkcode ArtifactReferenceReader} over the authoritative sandbox
 * journal. Pass it to `ArtifactCache#gc` so the cache never deletes a set
 * a live (or quarantined) record still boots from.
 */
export class JournalArtifactReferenceReader implements ArtifactReferenceReader {
  readonly #source: SandboxRecordSource;

  constructor(source: SandboxRecordSource) {
    this.#source = source;
  }

  /** Sorted, deduplicated manifest hashes of every referencing record. */
  async listReferencedManifestHashes(): Promise<string[]> {
    const hashes = new Set<string>();
    for (const record of await this.#source.list()) {
      if (record.artifact === undefined) continue;
      if (record.phase === RELEASING_PHASE) continue;
      hashes.add(record.artifact.manifestHash);
    }
    return [...hashes].sort();
  }
}
