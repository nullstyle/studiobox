import util from "node:util";

import type { BaseClientOptions } from "./client.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import type {
  SnapshotId,
  SnapshotInit,
  SnapshotSlug,
  VolumeId,
  VolumeSlug,
} from "./types.ts";

/** Tier C upstream-compatible snapshot value. */
export abstract class Snapshot {
  /** Snapshots a volume (Tier C). Rejects with
   * {@linkcode UnsupportedFeatureError}; post-1.0 maps onto Firecracker
   * snapshots + overlay images. */
  static create(
    _idOrSlug: VolumeId | VolumeSlug,
    _options: SnapshotInit & BaseClientOptions,
  ): Promise<Snapshot> {
    return Promise.reject(new UnsupportedFeatureError("Snapshot.create"));
  }

  /** Fetches a snapshot by id or slug (Tier C). Rejects with
   * {@linkcode UnsupportedFeatureError}. */
  static get(
    _idOrSlug: SnapshotId | SnapshotSlug,
    _options?: BaseClientOptions,
  ): Promise<Snapshot | null> {
    return Promise.reject(new UnsupportedFeatureError("Snapshot.get"));
  }

  /** The snapshot's unique id. */
  abstract get id(): string;
  /** The snapshot's human-readable slug. */
  abstract get slug(): string;
  /** The region the snapshot lives in. */
  abstract get region(): string;
  /** Bytes currently allocated by the snapshot. */
  abstract get allocatedSize(): number;
  /** Bytes of the snapshot when flattened. */
  abstract get flattenedSize(): number;
  /** Whether a sandbox can boot from this snapshot. */
  abstract get isBootable(): boolean;
  /** The volume this snapshot was taken from. */
  abstract get volume(): { id: VolumeId; slug: VolumeSlug };

  /** Node's custom-inspect hook: renders a compact `Snapshot { … }` summary. */
  [util.inspect.custom](
    depth: number,
    options: util.InspectOptionsStylized,
  ): string {
    if (depth < 0) return options.stylize("[Snapshot]", "special");
    const next = options.depth === null ? null : depth - 1;
    return `Snapshot ${
      util.inspect({
        id: this.id,
        slug: this.slug,
        region: this.region,
        allocatedSize: this.allocatedSize,
        flattenedSize: this.flattenedSize,
      }, { ...options, depth: next })
    }`;
  }
}
