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

export interface BaseClientOptions {
  token?: string;
  org?: string;
  apiEndpoint?: string;
}

/** Local client entry point. Only the `sandboxes` namespace is Tier A in 1.0. */
export class Client {
  constructor(_options: BaseClientOptions = {}) {}

  get apps(): Apps {
    throw new UnsupportedFeatureError("Client.apps");
  }

  get volumes(): Volumes {
    throw new UnsupportedFeatureError("Client.volumes");
  }

  get snapshots(): Snapshots {
    throw new UnsupportedFeatureError("Client.snapshots");
  }

  get revisions(): Revisions {
    throw new UnsupportedFeatureError("Client.revisions");
  }

  get timelines(): Timelines {
    throw new UnsupportedFeatureError("Client.timelines");
  }

  get sandboxes(): Sandboxes {
    return {
      create: (options) => Sandbox.create(options),
      connect: (id, options) => Sandbox.connect(id, options),
      list: (options) =>
        resolveSandboxProvider().then((provider) => provider.list(options)),
    };
  }

  get layers(): Layers {
    throw new UnsupportedFeatureError("Client.layers");
  }
}
