import util from "node:util";

import type { BaseClientOptions } from "./client.ts";
import { UnsupportedFeatureError } from "./errors.ts";
import type {
  SnapshotId,
  SnapshotSlug,
  VolumeId,
  VolumeInit,
  VolumeSlug,
} from "./types.ts";

/** Tier C upstream-compatible volume value. */
export abstract class Volume {
  /** Creates a persistent volume (Tier C). Rejects with
   * {@linkcode UnsupportedFeatureError}; post-1.0 maps onto Firecracker
   * snapshots + overlay images. */
  static create(
    _options: VolumeInit & BaseClientOptions,
  ): Promise<Volume> {
    return Promise.reject(new UnsupportedFeatureError("Volume.create"));
  }

  /** Fetches a volume by id or slug (Tier C). Rejects with
   * {@linkcode UnsupportedFeatureError}. */
  static get(
    _idOrSlug: VolumeId | VolumeSlug,
    _options?: BaseClientOptions,
  ): Promise<Volume | null> {
    return Promise.reject(new UnsupportedFeatureError("Volume.get"));
  }

  /** The volume's unique id. */
  abstract get id(): string;
  /** The volume's human-readable slug. */
  abstract get slug(): string;
  /** The region the volume lives in. */
  abstract get region(): string;
  /** The provisioned capacity, in bytes. */
  abstract get capacity(): number;
  /** Estimated bytes currently allocated by the volume. */
  abstract get estimatedAllocatedSize(): number;
  /** Estimated bytes of the volume when flattened. */
  abstract get estimatedFlattenedSize(): number;
  /** Whether a sandbox can boot from this volume. */
  abstract get isBootable(): boolean;
  /** The snapshot this volume was created from, or `null` if none. */
  abstract get baseSnapshot(): { id: SnapshotId; slug: SnapshotSlug } | null;

  /** Node's custom-inspect hook: renders a compact `Volume { … }` summary. */
  [util.inspect.custom](
    depth: number,
    options: util.InspectOptionsStylized,
  ): string {
    if (depth < 0) return options.stylize("[Volume]", "special");
    const next = options.depth === null ? null : depth - 1;
    return `Volume ${
      util.inspect({
        id: this.id,
        slug: this.slug,
        region: this.region,
        capacity: this.capacity,
        estimatedAllocatedSize: this.estimatedAllocatedSize,
        estimatedFlattenedSize: this.estimatedFlattenedSize,
      }, { ...options, depth: next })
    }`;
  }
}
