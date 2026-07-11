// Copyright 2025-2026 the Deno authors. MIT license.

import type { ConnectOptions, Sandbox, SandboxOptions } from "./sandbox.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Volume } from "./volume.ts";

/** The unique identifier for the app. */
export type AppId = string;
/** Human readable identifier for the app. */
export type AppSlug = string;
/** The cursor for pagination */
export type Cursor = string;
/** The unique identifier for a layer. */
export type LayerId = string;
/** Human readable identifier for a layer. */
export type LayerSlug = string;
/** The region where the sandbox is running */
export type Region = "ord" | "ams";

/** The initialization options for creating an app */
export interface AppInit {
  /** The slug of the app. If left blank, a random slug will be generated */
  slug?: string;
  /** Key-value labels for filtering and grouping (max 5) */
  labels?: Record<string, string>;
  /** App-specific environment variables */
  env_vars?: EnvVarInit[];
  /** Default build and runtime configuration */
  config?: AppConfig;
  /** Layers to reference for inherited configuration */
  layers?: string[];
}

/** The app information returned from {@linkcode Apps.get} */
export interface App {
  /** The unique identifier for the app. */
  id: AppId;
  /** Human readable identifier for the app. */
  slug: AppSlug;
  /** Key-value labels for filtering and grouping (max 5) */
  labels: Record<string, string>;
  /** Environment variables for the app */
  env_vars: EnvVar[];
  /** The app config */
  config: AppConfig;
  /** The layers associated with the app */
  layers: LayerRef[];
  /** The time the app was created. ISO 8601 timestamp */
  created_at: string;
  /** The last time the app was updated. ISO 8601 timestamp */
  updated_at: string;
}

/** The environment variable information associated with an app or a layer */
export interface EnvVar {
  /** The unique identifier for the environment variable. */
  id: string;
  /** The key of the environment variable. */
  key: string;
  /** The value of the environment variable. This will be `undefined` if the variable is a secret. */
  value: string | undefined;
  /** Whether the environment variable is a secret. */
  secret: boolean;
  /** The contexts where the environment variable is available. Can be "all" or an array of specific contexts like ["build", "production"]. */
  contexts: "all" | string[];
}

/** The initialization options for creating an environment variable */
export interface EnvVarInit {
  /** The key of the environment variable. */
  key: string;
  /** The value of the environment variable. */
  value: string;
  /** Whether the environment variable is a secret. */
  secret?: boolean;
  /** The contexts where the environment variable is available. Can be "all" or an array of specific contexts like ["build", "production"]. */
  contexts?: "all" | string[];
}

/** The framework preset for an app */
export type Framework =
  | ""
  | "nextjs"
  | "astro"
  | "nuxt"
  | "remix"
  | "solidstart"
  | "tanstackstart"
  | "sveltekit"
  | "fresh"
  | "lume";

/** The base part of {@linkcode AppConfig} */
export type AppConfigBase = {
  /** Custom install command. Omit to skip the install step */
  install?: string | null;
  /** Custom build command. Omit to skip the build step */
  build?: string | null;
  /** Command to run before each deployment (e.g. database migrations). Omit to skip */
  predeploy?: string | null;
  /** Whether cron jobs are enabled for revisions of the app. When false, revisions that register cron jobs using Deno.cron fail to build. Defaults to true */
  crons?: boolean;
};

/** The configuration options for an app */
export type AppConfig =
  | AppConfigBase
  | (AppConfigBase & {
    /** Framework preset. Mutually exclusive with `runtime` option */
    framework: Framework;
  })
  | (AppConfigBase & {
    /** Runtime configuration. Mutually exclusive with `framework` */
    runtime: RuntimeConfig;
  });

/**
 * The runtime configuration for an app
 *
 * type: `dynamic` - runs a Deno process with a specified entrypoint and arguments
 * type: `static` - serves pre-built static files from a specified directory, with optional SPA mode
 */
export type RuntimeConfig = {
  /** `dynamic` runs a Deno process. */
  type: "dynamic";
  /** Main module path. Required when `type` is `dynamic` */
  entrypoint?: string;
  /** Additional CLI arguments passed to the entrypoint */
  args?: string[];
} | {
  /** `static` serves pre-built files. */
  type: "static";
  /** Working directory or static file root. Required when `type` is `static` */
  cwd?: string;
  /** Enable single-page application mode (fallback to index.html). Only for `static` type */
  spa?: boolean;
};

/** The status of a revision */
export type RevisionStatus =
  | "skipped"
  | "queued"
  | "building"
  | "succeeded"
  | "failed";

/** The reason a revision failed */
export type RevisionFailureReason =
  | "error"
  | "cancelled"
  | "timed_out"
  | "skipped";

/** The revision information returned from {@linkcode Revisions.get} */
export interface Revision {
  /** The unique identifier for the revision */
  id: string;
  /** Current revision status */
  status: RevisionStatus;
  /** Reason for failure, or null if not failed */
  failure_reason: RevisionFailureReason | null;
  /** Metadata labels attached to this revision */
  labels?: Record<string, string>;
  /** Layers referenced by this revision */
  layers: LayerRef[];
  /** Revision-specific environment variables (immutable once created) */
  env_vars: RevisionEnvVar[];
  /** Build and runtime configuration used for this revision */
  config: RevisionConfig;
  /** ISO 8601 timestamp of creation */
  created_at: string;
  /** ISO 8601 timestamp when cancellation was requested, or null */
  cancellation_requested_at: string | null;
  /** ISO 8601 timestamp when the build completed, or null if still building */
  build_finished_at: string | null;
  /** ISO 8601 timestamp of deletion, or null if active */
  deleted_at: string | null;
}

/** Build and runtime configuration for a revision */
export interface RevisionConfig {
  /** Framework preset used for the build */
  framework?: string;
  /** Install command. Null if skipped */
  install?: string | null;
  /** Build command. Null if skipped */
  build?: string | null;
  /** Pre-deploy command. Null if skipped */
  predeploy?: string | null;
  /** Whether cron jobs are enabled for the revision. When false, the build of the revision fails if the revision registers cron jobs using Deno.cron. Defaults to true */
  crons?: boolean;
  /** Runtime configuration */
  runtime?: RuntimeConfig;
}

/** The timeline information returned from {@linkcode Timelines.list} */
export interface Timeline {
  /** The unique identifier for the timeline */
  slug: string;
  /** The partition of the timeline */
  partition: Record<string, string>;
  /** The app associated with the timeline */
  app: { id: AppId; slug: AppSlug };
  /** The context of the timeline */
  context: { slug: string };

  // TODO(kt3k): Implement this
  // active_revision: Omit<Revision, "timelines"> | null;
  /** The domains associated with the timeline */
  domains: { domain: string }[];
}

/** The unique identifier for the snapshot. */
export type SnapshotId = string;
/** Human readable identifier for the snapshot. */
export type SnapshotSlug = string;

/** The initialization options for creating a snapshot */
export interface SnapshotInit {
  /**
   * Human readable identifier for the snapshot. This is a shared namespace
   * with volumes, so snapshot slugs must be unique among both snapshots and
   * volumes.
   *
   * Slugs must be 2-32 characters long and can only contain lowercase
   * letters (`a-z`), digits (`0-9`), and hyphens (`-`). They must not start
   * or end with a hyphen, and must not contain consecutive hyphens at
   * positions 3 and 4 (e.g. `ab--cd`).
   */
  slug: string;
}

/** The common options for listing resources */
export interface ListOptions {
  /** The cursor for pagination. */
  cursor?: Cursor;
  /** The limit for the number of items to return */
  limit?: number;
}

/** The options for listing apps */
export interface AppListOptions extends ListOptions {
  /** Filter by labels */
  labels?: Record<string, string>;
  /** Filter by layer ID or slug */
  layer?: string;
}

/** The options for updating an app */
export interface AppUpdate {
  /** New app slug */
  slug?: string;
  /** Replace all labels */
  labels?: Record<string, string>;
  /** Deep merge with existing environment variables */
  env_vars?: EnvVarUpdate[];
  /** Replace the entire deploy config */
  config?: AppConfig;
  /** Replace all layer references */
  layers?: string[];
}

/** The options for updating an environment variable */
export interface EnvVarUpdate {
  /** ID of the existing variable to update or delete */
  id?: string;
  /** Variable name. Used for matching when `id` is not provided */
  key?: string;
  /** New value for the variable */
  value?: string;
  /** Whether to mask the value in API responses */
  secret?: boolean;
  /** Deployment contexts this variable applies to */
  contexts?: "all" | string[];
  /** Set to true to remove this variable */
  delete?: boolean;
}

/** The options for listing revisions */
export interface RevisionListOptions extends ListOptions {
  /** Filter revisions by status */
  status?: RevisionStatus;
}

/** The options for listing timelines */
export interface TimelineListOptions extends ListOptions {}

/** The unique identifier for the volume. */
export type VolumeId = string;
/** Human readable identifier for the volume. */
export type VolumeSlug = string;

/** The initialization options for creating a volume */
export interface VolumeInit {
  /** Human readable identifier for the volume. This is a shared namespace with
   * snapshots, so volume slugs must be unique among both volumes and
   * snapshots.
   *
   * Slugs must be 2-32 characters long and can only contain lowercase
   * letters (`a-z`), digits (`0-9`), and hyphens (`-`). They must not start
   * or end with a hyphen, and must not contain consecutive hyphens at
   * positions 3 and 4 (e.g. `ab--cd`).
   */
  slug: string;
  /** The region to create the volume in. */
  region: string;
  /** Volume size in bytes */
  capacity:
    | number
    | `${number}GB`
    | `${number}MB`
    | `${number}kB`
    | `${number}GiB`
    | `${number}MiB`
    | `${number}KiB`;
  /**
   * A base snapshot or image to create the volume from. This can either be a
   * snapshot ID or snapshot slug in the same region, or the special string
   * "builtin:debian-13" to create the volume from the built-in Debian 13 image
   * that volumes usually use as their base.
   *
   * Volumes created from snapshots are "copy-on-write", meaning that they
   * initially share data with the snapshot to save space. Changes to the volume
   * do not affect the snapshot, and vice versa. The volume will only "consume"
   * space for the data that is different from the snapshot.
   */
  from?: "builtin:debian-13" | SnapshotId | SnapshotSlug;
}

/** The options for listing volumes */
export interface VolumeListOptions extends ListOptions {
  /** The search query to filter volumes by. */
  search?: string;
}

/** The options for listing snapshots */
export interface SnapshotListOptions extends ListOptions {
  /** The search query to filter snapshots by. */
  search?: string;
}

/** The log level for runtime logs */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A runtime log entry */
export interface RuntimeLog {
  /** ISO 8601 timestamp of the log entry */
  timestamp: string;
  /** Log severity level */
  level: LogLevel;
  /** Log message content */
  message: string;
  /** Revision that produced this log entry */
  revision_id?: string;
  /** Region where the isolate was running */
  region?: string;
  /** OpenTelemetry trace ID for request correlation */
  trace_id?: string;
  /** OpenTelemetry span ID */
  span_id?: string;
}

/** The options for querying app logs */
export interface AppLogsOptions {
  /** Start of the time range (ISO 8601) */
  start: string;
  /** End of the time range (ISO 8601). Defaults to now */
  end?: string;
  /** Filter logs by revision ID */
  revision_id?: string;
  /** Minimum log severity level */
  level?: LogLevel;
  /** Full-text search query */
  query?: string;
  /** Cursor for pagination */
  cursor?: Cursor;
  /** Number of log entries to return (1-1000, default 100) */
  limit?: number;
}

/** The namespace for app management methods */
export interface Apps {
  /** Gets the app of the given id or slug */
  get(idOrSlug: AppId | AppSlug): Promise<App | null>;
  /** Lists the apps in the org */
  list(opts?: AppListOptions): Promise<PaginatedList<App>>;
  /** Creates an app in the org */
  create(init?: AppInit): Promise<App>;
  /** Updates the app of the given id or slug */
  update(idOrSlug: AppId | AppSlug, updates: AppUpdate): Promise<App>;
  /** Deletes the app of the given id or slug */
  delete(idOrSlug: AppId | AppSlug): Promise<void>;
  /** Deploys assets to the app, creating a new revision */
  deploy(idOrSlug: AppId | AppSlug, init: DeployInit): Promise<DeployRevision>;
  /** Query historical runtime logs for the app */
  logs(
    idOrSlug: AppId | AppSlug,
    opts: AppLogsOptions,
  ): Promise<PaginatedList<RuntimeLog>>;
}

/** The steps of a build process */
export type BuildStep = "preparing" | "installing" | "building" | "deploying";

/** The build log of the app deployment */
export interface BuildLog {
  /** The timestamp of the build log */
  timestamp: string;
  /** The level of the build log */
  level: "info" | "error";
  /** The message of the build log */
  message: string;
  /** The build step */
  step: BuildStep;
  /** The timeline name, present only for "deploying" steps */
  timeline?: string;
}

/** The options for filtering build logs */
export interface BuildLogsOptions {
  /** The build step to filter logs by. If not provided, logs from all steps will be returned. */
  step?: BuildStep;
  /** The timeline slug to filter logs by. Only applicable for "deploying" steps. */
  timeline?: string;
}

/** The status of a revision progress stage */
export type RevisionProgressStageStatus =
  | "pending"
  | "skipped"
  | "running"
  | "succeeded"
  | "timed_out"
  | "cancelled"
  | "errored";

/** A pending progress stage */
export interface RevisionProgressPendingStage {
  /** Stage has not started yet */
  status: "pending";
}

/** A skipped progress stage */
export interface RevisionProgressSkippedStage {
  /** Stage was skipped */
  status: "skipped";
}

/** A running progress stage */
export interface RevisionProgressRunningStage {
  /** Stage is currently running */
  status: "running";
  /** ISO 8601 timestamp when the stage started */
  start: string;
}

/** A completed progress stage */
export interface RevisionProgressCompletedStage {
  /** Terminal stage status */
  status: "succeeded" | "timed_out" | "cancelled" | "errored";
  /** ISO 8601 timestamp when the stage started */
  start: string;
  /** ISO 8601 timestamp when the stage ended */
  end: string;
}

/** A revision progress stage */
export type RevisionProgressStage =
  | RevisionProgressPendingStage
  | RevisionProgressSkippedStage
  | RevisionProgressRunningStage
  | RevisionProgressCompletedStage;

/** A revision progress stage with a command */
export type RevisionProgressStageWithCommand = RevisionProgressStage & {
  /** The command being executed, or null if not applicable */
  command: string | null;
};

/** A timeline reference in revision progress */
export interface RevisionProgressTimelineRef {
  /** Timeline slug */
  slug: string;
  /** Partition key-value pairs identifying this timeline */
  partition: Record<string, string>;
}

/** A timeline-blocked routing stage */
export interface RevisionProgressTimelineBlockedStage {
  /** Routing is blocked waiting for other timelines */
  status: "timeline_blocked";
  /** Timelines that are blocking this stage */
  timelines: RevisionProgressTimelineRef[];
  /** The stage that is blocked */
  stage: "warmup";
}

/** A routing stage in revision progress */
export type RevisionProgressRoutingStage =
  | RevisionProgressStage
  | RevisionProgressTimelineBlockedStage;

/** Per-timeline deployment progress */
export type RevisionProgressTimelineStage = RevisionProgressStage & {
  /** Timeline slug */
  slug: string;
  /** Partition key-value pairs identifying this timeline */
  partition: Record<string, string>;
  /** Database migration stage progress */
  database: RevisionProgressStage;
  /** Pre-deploy command stage progress */
  predeploy: RevisionProgressStageWithCommand;
  /** Isolate warmup stage progress */
  warmup?: RevisionProgressStage;
  /** Domain routing stage progress */
  routing: RevisionProgressRoutingStage;
};

/** The deploying stage of revision progress */
export type RevisionProgressDeployingStage = RevisionProgressStage & {
  /** Per-timeline deployment progress */
  timelines: RevisionProgressTimelineStage[];
};

/** The revision progress object streamed from {@linkcode Revisions.progress} */
export interface RevisionProgress {
  /** Queue stage — waiting for a build slot */
  queued: RevisionProgressStage;
  /** Prepare stage — cloning source code and restoring caches */
  preparing: RevisionProgressStage;
  /** Install stage — installing dependencies */
  installing: RevisionProgressStageWithCommand;
  /** Build stage — running the build command */
  building: RevisionProgressStageWithCommand;
  /** Deploy stage — uploading artifacts and routing traffic */
  deploying: RevisionProgressDeployingStage;
}

/** The namespace for revision management methods */
export interface Revisions {
  /** Gets the revision of the given id */
  get(id: string): Promise<Revision | null>;
  /** Lists the revisions for the given app */
  list(
    app: AppId | AppSlug,
    opts?: RevisionListOptions,
  ): Promise<PaginatedList<Omit<Revision, "timelines">>>;
  /** Stream revision build progress. */
  progress(id: string): AsyncIterable<RevisionProgress>;
  /** Stream build logs. */
  buildLogs(id: string, opts?: BuildLogsOptions): AsyncIterable<BuildLog>;
  /** Cancel a revision build. Returns the revision with cancellation requested. */
  cancel(id: string): Promise<Revision>;
  /** Get the timelines where this revision is active. */
  timelines(id: string): Promise<Timeline[]>;
  /** Deletes the revision of the given id */
  delete(id: string): Promise<void>;
}

/** The namespace for timeline management methods */
export interface Timelines {
  /** Lists the timeline in the given app */
  list(
    app: AppId | AppSlug,
    opts?: TimelineListOptions,
  ): Promise<PaginatedList<Timeline>>;
}

/** A paginated list of items of type T. */
export interface PaginatedList<T> {
  /** The items in the current page of the paginated list. */
  items: T[];
  /** Whether there are more items to fetch. */
  hasMore: boolean;
  /** The cursor for pagination. */
  nextCursor: Cursor | null;
  /** Returns the next page of items in the paginated list. */
  getNextPage(): Promise<PaginatedList<T> | null>;
  /** Returns an async iterator for the items in the paginated list. */
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

/** The namespace for volume management methods */
export interface Volumes {
  /** Gets volume info by ID or slug */
  get(idOrSlug: VolumeId | VolumeSlug): Promise<Volume | null>;
  /** Lists the volumes in the org */
  list(opts?: VolumeListOptions): Promise<PaginatedList<Volume>>;
  /** Creates a new volume */
  create(init: VolumeInit): Promise<Volume>;
  /** Deletes a volume */
  delete(idOrSlug: VolumeId | VolumeSlug): Promise<void>;
  /**
   * Create a snapshot from a volume, passing in the volume ID or volume slug,
   * and the options for the new snapshot, such as the snapshot slug.
   *
   * The snapshot will be created in the same region as the volume.
   *
   * Snapshots can not be created while a volume is attached to a sandbox.
   */
  snapshot(
    idOrSlug: VolumeId | VolumeSlug,
    init: SnapshotInit,
  ): Promise<Snapshot>;
}

/** The namespace for snapshot management methods */
export interface Snapshots {
  /** Gets snapshot info by ID or slug */
  get(idOrSlug: SnapshotId | SnapshotSlug): Promise<Snapshot | null>;
  /** Lists the snapshots in the org */
  list(opts?: SnapshotListOptions): Promise<PaginatedList<Snapshot>>;
  /** Delete a snapshot */
  delete(idOrSlug: SnapshotId | SnapshotSlug): Promise<void>;
}

/** The metadata for a sandbox returned from {@linkcode Sandbox.list} */
export interface SandboxMetadata {
  /** The ID of the sandbox. */
  id: string;
  /** The creation time of the sandbox. */
  createdAt: Date;
  /** The time the sandbox stopped. */
  stoppedAt: Date | null;
  /** The region where the sandbox is running. */
  region: Region;
  /** The status of the sandbox. */
  status: "running" | "stopped";
  /** The labels assigned to the sandbox. */
  labels: Record<string, string>;
}

/** The options for listing sandboxes */
export interface SandboxesListOptions {
  /** The labels to filter sandboxes by. */
  labels?: Record<string, string>;
}

/** The namespace for sandbox management methods */
export interface Sandboxes {
  /**
   * Create a new sandbox with the given options.
   *
   * Alias for {@linkcode Sandbox.create}.
   */
  create(options?: SandboxOptions): Promise<Sandbox>;
  /**
   * Connect to an existing sandbox with the given options.
   *
   * Alias for {@linkcode Sandbox.connect}.
   */
  connect(id: string, options: ConnectOptions): Promise<Sandbox>;
  /** Returns the list of sandboxes. */
  list(options?: SandboxesListOptions): Promise<SandboxMetadata[]>;
}

/** A reference to a layer by ID and slug */
export interface LayerRef {
  /** The unique identifier for the layer. */
  id: LayerId;
  /** Human readable identifier for the layer. */
  slug: LayerSlug;
}

/** The layer information returned from {@linkcode Layers.get} */
export interface Layer {
  /** The unique identifier for the layer */
  id: LayerId;
  /** Human readable identifier for the layer */
  slug: LayerSlug;
  /** Description of the layer's purpose */
  description?: string;
  /** Other layers included by this layer */
  layers: LayerRef[];
  /** Environment variables defined on this layer */
  env_vars: EnvVar[];
  /** Number of apps referencing this layer */
  app_count: number;
  /** The time the layer was created. ISO 8601 timestamp */
  created_at: string;
  /** The last time the layer was updated. ISO 8601 timestamp */
  updated_at: string;
}

/** The initialization options for creating a layer */
export interface LayerInit {
  /** Human readable identifier for the layer */
  slug: string;
  /** Description of the layer's purpose */
  description?: string;
  /** Other layers to include (IDs or slugs) */
  layers?: string[];
  /** Environment variables to set on the layer */
  env_vars?: EnvVarInit[];
}

/** The options for updating a layer */
export interface LayerUpdate {
  /** New slug for the layer */
  slug?: string;
  /** New description */
  description?: string;
  /** Replace the list of included layers (IDs or slugs) */
  layers?: string[];
  /** Environment variable updates */
  env_vars?: EnvVarUpdate[];
}

/** The options for listing layers */
export interface LayerListOptions extends ListOptions {
  /** The search query to filter layers by */
  search?: string;
}

/** The options for listing apps that reference a layer */
export interface LayerAppsListOptions extends ListOptions {}

/** A reference to an app that uses a layer */
export interface LayerAppRef {
  /** The unique identifier for the app */
  id: AppId;
  /** Human readable identifier for the app */
  slug: AppSlug;
  /** The index of this layer in the app's `layers` array */
  layer_position: number;
}

/** The namespace for layer management methods */
export interface Layers {
  /** Gets a layer by ID or slug */
  get(idOrSlug: LayerId | LayerSlug): Promise<Layer | null>;
  /** Lists the layers in the org */
  list(opts?: LayerListOptions): Promise<PaginatedList<Layer>>;
  /** Creates a new layer */
  create(init: LayerInit): Promise<Layer>;
  /** Updates a layer */
  update(idOrSlug: LayerId | LayerSlug, updates: LayerUpdate): Promise<Layer>;
  /** Deletes a layer */
  delete(idOrSlug: LayerId | LayerSlug): Promise<void>;
  /** Lists apps that reference this layer */
  apps(
    idOrSlug: LayerId | LayerSlug,
    opts?: LayerAppsListOptions,
  ): Promise<PaginatedList<LayerAppRef>>;
}

/** A deploy asset: either a file or a symlink */
export type DeployAsset =
  | { kind?: "file"; encoding?: "utf-8" | "base64"; content: string }
  | { kind: "symlink"; target: string };

/** Build and runtime configuration for a deployment */
export interface DeployConfig {
  /** Framework preset */
  framework?: string;
  /** Custom install command, or null to skip */
  install?: string | null;
  /** Custom build command, or null to skip */
  build?: string | null;
  /** Pre-deploy command, or null to skip */
  predeploy?: string | null;
  /** Whether cron jobs are enabled for the revision. When false, the build of the revision fails if the revision registers cron jobs using Deno.cron. Defaults to true */
  crons?: boolean;
  /** Runtime configuration */
  runtime?: {
    type: "dynamic" | "static";
    entrypoint?: string;
    args?: string[];
    cwd?: string;
    spa?: boolean;
  };
}

/** An environment variable to set on a revision */
export interface RevisionEnvVar {
  /** The environment variable name */
  key: string;
  /** The environment variable value */
  value: string;
}

/** The initialization options for deploying to an app */
export interface DeployInit {
  /** Source files to deploy. Keys are paths relative to `/app/src` */
  assets: Record<string, DeployAsset>;
  /** Build and runtime config. If omitted, inherited from the app */
  config?: DeployConfig;
  /** Layers to reference for this revision (IDs or slugs) */
  layers?: string[];
  /** Revision-specific environment variables (immutable once created) */
  env_vars?: RevisionEnvVar[];
  /** Metadata labels (e.g. git branch, commit SHA) */
  labels?: Record<string, string>;
  /**
   * Whether to deploy to the production timeline.
   *
   * @default {true}
   */
  production?: boolean;
  /**
   * Whether to deploy as a preview deployment.
   *
   * @default {false}
   */
  preview?: boolean;
}

/** The revision information returned from a deploy operation */
export interface DeployRevision {
  /** The unique identifier for the revision */
  id: string;
  /** The status of the revision */
  status: "skipped" | "queued" | "building" | "succeeded" | "failed";
  /** The reason for failure, if the revision failed */
  failure_reason: string | null;
  /** Metadata labels attached to this revision (e.g. git info) */
  labels?: Record<string, string>;
  /** Layers referenced by this revision, in priority order */
  layers?: LayerRef[];
  /** Revision-specific environment variables (immutable once created) */
  env_vars?: RevisionEnvVar[];
  /** Build and runtime configuration used for this revision */
  config?: DeployConfig;
  /** The time the revision was created. ISO 8601 timestamp */
  created_at: string;
  /** The time cancellation was requested, if applicable. ISO 8601 timestamp */
  cancellation_requested_at: string | null;
  /** The time the build finished, if applicable. ISO 8601 timestamp */
  build_finished_at: string | null;
  /** The time the revision was deleted, if applicable. ISO 8601 timestamp */
  deleted_at: string | null;
}

/**
 * Configuration for a secret environment variable.
 */
export interface SecretConfig {
  /**
   * List of hostnames where this secret can be used.
   * Must have at least one host.
   *
   * @example ["api.openai.com"]
   * @example ["api.anthropic.com"]
   * @example ["api.github.com", "github.com"]
   */
  hosts: string[];

  /**
   * The actual secret value.
   */
  value: string;
}
