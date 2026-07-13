import { UnsupportedFeatureError } from "./errors.ts";
import { resolveSandboxProvider } from "./provider.ts";
import { Sandbox } from "./sandbox.ts";
import type {
  Apps,
  Layers,
  Revisions,
  Sandboxes,
  Snapshots,
  Timelines,
  Volumes,
} from "./types.ts";

/**
 * Options shared by every client entry point, mirroring `@deno/sandbox`'s
 * client config. Studiobox is local, so most fields diverge from the cloud SDK
 * (see PARITY.md, auth row).
 */
export interface BaseClientOptions {
  /**
   * Bearer token (Tier B). Locally this is `STUDIOBOX_TOKEN` (or
   * `~/.studiobox/token`) authenticating you to your own host — not a Deno
   * Deploy cloud token.
   */
  token?: string;
  /**
   * Org slug (Tier B). Accepted for source compatibility and ignored —
   * studiobox has no org concept.
   */
  org?: string;
  /** Upstream cloud control-plane URL. Unused by the local backend. */
  apiEndpoint?: string;
}

/** Local client entry point. Only the `sandboxes` namespace is Tier A in 1.0. */
export class Client {
  /** Constructs a client. Options are accepted for upstream parity; the local
   * backend needs none of them. */
  constructor(_options: BaseClientOptions = {}) {}

  /** Apps namespace (Tier C). Deno Deploy PaaS; throws
   * {@linkcode UnsupportedFeatureError}. */
  get apps(): Apps {
    throw new UnsupportedFeatureError("Client.apps");
  }

  /** Volumes namespace (Tier C). Persistent volumes; throws
   * {@linkcode UnsupportedFeatureError}. */
  get volumes(): Volumes {
    throw new UnsupportedFeatureError("Client.volumes");
  }

  /** Snapshots namespace (Tier C). Volume snapshots; throws
   * {@linkcode UnsupportedFeatureError}. */
  get snapshots(): Snapshots {
    throw new UnsupportedFeatureError("Client.snapshots");
  }

  /** Revisions namespace (Tier C). App revisions; throws
   * {@linkcode UnsupportedFeatureError}. */
  get revisions(): Revisions {
    throw new UnsupportedFeatureError("Client.revisions");
  }

  /** Timelines namespace (Tier C). Deploy timelines; throws
   * {@linkcode UnsupportedFeatureError}. */
  get timelines(): Timelines {
    throw new UnsupportedFeatureError("Client.timelines");
  }

  /** Sandboxes namespace (Tier A). Create, connect to, and list local
   * microVM sandboxes. */
  get sandboxes(): Sandboxes {
    return {
      create: (options) => Sandbox.create(options),
      connect: (id, options) => Sandbox.connect(id, options),
      list: (options) =>
        resolveSandboxProvider().then((provider) => provider.list(options)),
    };
  }

  /** Layers namespace (Tier C). App layers; throws
   * {@linkcode UnsupportedFeatureError}. */
  get layers(): Layers {
    throw new UnsupportedFeatureError("Client.layers");
  }
}
