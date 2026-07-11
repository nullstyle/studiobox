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
  static create(
    _options: VolumeInit & BaseClientOptions,
  ): Promise<Volume> {
    return Promise.reject(new UnsupportedFeatureError("Volume.create"));
  }

  static get(
    _idOrSlug: VolumeId | VolumeSlug,
    _options?: BaseClientOptions,
  ): Promise<Volume | null> {
    return Promise.reject(new UnsupportedFeatureError("Volume.get"));
  }

  abstract get id(): string;
  abstract get slug(): string;
  abstract get region(): string;
  abstract get capacity(): number;
  abstract get estimatedAllocatedSize(): number;
  abstract get estimatedFlattenedSize(): number;
  abstract get isBootable(): boolean;
  abstract get baseSnapshot(): { id: SnapshotId; slug: SnapshotSlug } | null;

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
