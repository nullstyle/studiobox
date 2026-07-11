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
  static create(
    _idOrSlug: VolumeId | VolumeSlug,
    _options: SnapshotInit & BaseClientOptions,
  ): Promise<Snapshot> {
    return Promise.reject(new UnsupportedFeatureError("Snapshot.create"));
  }

  static get(
    _idOrSlug: SnapshotId | SnapshotSlug,
    _options?: BaseClientOptions,
  ): Promise<Snapshot | null> {
    return Promise.reject(new UnsupportedFeatureError("Snapshot.get"));
  }

  abstract get id(): string;
  abstract get slug(): string;
  abstract get region(): string;
  abstract get allocatedSize(): number;
  abstract get flattenedSize(): number;
  abstract get isBootable(): boolean;
  abstract get volume(): { id: VolumeId; slug: VolumeSlug };

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
