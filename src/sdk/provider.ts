/**
 * {@linkcode StudioboxProvider}: the real `@deno/sandbox` drop-in backend.
 * It implements the {@linkcode SandboxProvider} seam
 * (`create`/`connect`/`list`) by speaking the `host_control.capnp` control
 * plane over a UDS/TCP endpoint, opening a ticketed tunnel to the guest, and
 * binding the carried {@linkcode Sandbox} façade to the
 * `sandbox_agent.capnp` plane over that tunnel.
 *
 * The pure-wire flow (proven end-to-end by the M8 part-2b gate,
 * `tests/fake/hostd/tunnel_wire_e2e_test.ts`):
 *
 *   connect host control (negotiate + authenticate) → HostControl.create
 *   → HostControl.sandbox(id).openTunnel (grant carries a ticket +
 *   agentCredential, NO endpoint) → dial the STATIC tunnel endpoint with the
 *   ticket → SandboxAgent bootstrap authenticate(grant.agentCredential) →
 *   live agent session → {@linkcode AgentBackedSandbox}.
 *
 * @module
 */

import { type RpcStub, RpcWireClient, TcpTransport } from "@nullstyle/capnp";

import type {
  ConnectOptions,
  Sandbox,
  SandboxOptions,
} from "../api/sandbox.ts";
import {
  ConnectionEstablishmentError,
  InvalidTimeoutError,
  MissingTokenError,
  SandboxKillError,
  UnsupportedFeatureError,
} from "../api/errors.ts";
import { parseMemory } from "../api/memory.ts";
import type { SandboxProvider } from "../api/provider.ts";
import type {
  Region,
  SandboxesListOptions,
  SandboxMetadata,
} from "../api/types.ts";

import {
  type CreateOptions,
  type CreateParams,
  HostBootstrap,
  type HostControl,
  type HostSandbox,
  type TunnelGrant,
} from "../wire/generated/host_control_types.ts";
import type { EmptyResult } from "../wire/generated/common_types.ts";
import * as agentWire from "../wire/generated/sandbox_agent_types.ts";
import {
  buildHostContractIdentity,
  HOST_FEATURE_BITS,
  type HostCompatIdentitySource,
} from "../hostd/service.ts";
import { protocolOfferToWire } from "../rootd/service.ts";
import type { ContractIdentity } from "../wire/contract.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../wire/contract.ts";
import {
  AGENT_PLANE_FEATURES,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../agent/service.ts";
import {
  dialTunnel,
  type TunnelEndpoint,
} from "../transports/tunnel_client.ts";

import { AgentBackedSandbox, parseDurationMs } from "./sandbox.ts";
import { resolveWireBackend } from "./wire_agent.ts";
import { expectArm, normalizeThrown } from "./wire_errors.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_MIB = 1280;
const DEFAULT_VCPUS = 2;
const MAX_LABELS = 5;

/** Studiobox-facing sandbox id grammar (`sbx_loc_` + 20 of the alphabet). */
const SANDBOX_ID_RE = /^sbx_loc_[0-9a-hjkmnp-z]{20}$/;

/** Where a control / tunnel endpoint lives. Same shape as {@link TunnelEndpoint}. */
export type ProviderEndpoint = TunnelEndpoint;

/** Construction options for {@linkcode StudioboxProvider}. */
export interface StudioboxProviderOptions {
  /** hostd `HostControl` endpoint (the forwarded control port). */
  readonly control: ProviderEndpoint;
  /** Static tunnel router endpoint (the forwarded tunnel port). */
  readonly tunnel: TunnelEndpoint;
  /**
   * Host authentication credential. A hex string or raw bytes. Falls back to
   * `STUDIOBOX_TOKEN` at `create`/`connect` time; absent ⇒ {@link
   * MissingTokenError}.
   */
  readonly token?: string | Uint8Array;
  /** Client build id declared in the handshake. */
  readonly buildId?: string;
  /** Per-call timeout (ms). @default 30000 */
  readonly callTimeoutMs?: number;
  /**
   * Contract identity override for the host handshake. When absent it is
   * built from the bundled `compat/wire.json`.
   */
  readonly identity?: ContractIdentity;
}

// ---------------------------------------------------------------------------
// Endpoint / token / grammar helpers
// ---------------------------------------------------------------------------

function parseEndpoint(spec: string): ProviderEndpoint {
  // `unix:/path/to.sock` or `tcp:host:port` (or `host:port`).
  if (spec.startsWith("unix:")) {
    return { transport: "unix", path: spec.slice("unix:".length) };
  }
  const tcp = spec.startsWith("tcp:") ? spec.slice("tcp:".length) : spec;
  const colon = tcp.lastIndexOf(":");
  if (colon <= 0) {
    throw new TypeError(`invalid endpoint: ${spec}`);
  }
  return {
    transport: "tcp",
    hostname: tcp.slice(0, colon),
    port: Number(tcp.slice(colon + 1)),
  };
}

function toCredentialBytes(token: string | Uint8Array): Uint8Array {
  if (token instanceof Uint8Array) return token;
  if (/^(?:[0-9a-fA-F]{2})+$/.test(token)) {
    const out = new Uint8Array(token.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(token.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new TextEncoder().encode(token);
}

function connectEndpoint(endpoint: ProviderEndpoint): Promise<Deno.Conn> {
  return endpoint.transport === "unix"
    ? Deno.connect({ transport: "unix", path: endpoint.path })
    : Deno.connect({
      transport: "tcp",
      hostname: endpoint.hostname,
      port: endpoint.port,
    });
}

// ---------------------------------------------------------------------------
// SandboxOptions -> wire CreateOptions
// ---------------------------------------------------------------------------

function toTimeoutSpec(
  timeout: SandboxOptions["timeout"],
): CreateOptions["timeout"] {
  if (timeout === undefined || timeout === "session") {
    return { which: "session", session: undefined };
  }
  if (!/^\d+(?:\.\d+)?[sm]$/.test(timeout)) {
    throw new InvalidTimeoutError(`Invalid timeout format: ${timeout}`);
  }
  return {
    which: "durationMs",
    durationMs: BigInt(parseDurationMs(timeout as `${number}s` | `${number}m`)),
  };
}

function toCreateOptions(options: SandboxOptions): CreateOptions {
  const labels = Object.entries(options.labels ?? {});
  if (labels.length > MAX_LABELS) {
    throw new UnsupportedFeatureError(
      `SandboxOptions.labels (max ${MAX_LABELS})`,
    );
  }
  const memoryMiB = options.memory === undefined
    ? DEFAULT_MEMORY_MIB
    : parseMemory(options.memory);
  return {
    timeout: toTimeoutSpec(options.timeout),
    memoryMiB,
    vcpus: DEFAULT_VCPUS,
    // Presence-correct egress policy: an unset `allowNet` (allowNetSet=false)
    // means UNRESTRICTED (full internet, the upstream default); a set `allowNet`
    // (allowNetSet=true, even `[]`) means RESTRICTED. hostd/rootd decode this
    // pair back into the undefined/[]/list distinction (see wire/supervisor.ts).
    allowNet: options.allowNet ?? [],
    allowNetSet: options.allowNet !== undefined,
    labels: labels.map(([key, value]) => ({ key, value })),
    region: (options.region ?? "loc") as CreateOptions["region"],
    netless: false,
    kernelArgs: [],
  };
}

// ---------------------------------------------------------------------------
// Live wire connections (host control + agent session)
// ---------------------------------------------------------------------------

interface WireConnection {
  readonly wireClient: RpcWireClient;
  close(): Promise<void>;
}

function openWireConnection(
  conn: Deno.Conn,
  timeoutMs: number,
): WireConnection {
  let wireClient: RpcWireClient | null = null;
  const transport = new TcpTransport(conn, {
    closeTimeoutMs: timeoutMs,
    onClose: () => void wireClient?.close().catch(() => {}),
    onError: () => {},
  });
  wireClient = new RpcWireClient(transport, { defaultTimeoutMs: timeoutMs });
  const client = wireClient;
  return {
    wireClient: client,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** The real `@deno/sandbox` provider over Firecracker/hostd. */
export class StudioboxProvider implements SandboxProvider {
  readonly #control: ProviderEndpoint;
  readonly #tunnel: TunnelEndpoint;
  readonly #configToken: Uint8Array | undefined;
  readonly #buildId: string;
  readonly #timeoutMs: number;
  readonly #identityOverride: ContractIdentity | undefined;
  #identity: ContractIdentity | undefined;

  /** Construct with explicit control/tunnel endpoints and optional token. */
  constructor(options: StudioboxProviderOptions) {
    this.#control = options.control;
    this.#tunnel = options.tunnel;
    this.#configToken = options.token === undefined
      ? undefined
      : toCredentialBytes(options.token);
    this.#buildId = options.buildId ?? "studiobox/sdk";
    this.#timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#identityOverride = options.identity;
  }

  /**
   * Build a provider from the environment: `STUDIOBOX_HOST` (control
   * endpoint), `STUDIOBOX_TUNNEL` (tunnel endpoint), optional
   * `STUDIOBOX_TOKEN`.
   */
  static fromEnv(
    overrides: Partial<StudioboxProviderOptions> = {},
  ): StudioboxProvider {
    const control = overrides.control ??
      parseEndpoint(requireEnv("STUDIOBOX_HOST"));
    const tunnel = overrides.tunnel ??
      parseEndpoint(requireEnv("STUDIOBOX_TUNNEL"));
    return new StudioboxProvider({ ...overrides, control, tunnel });
  }

  async #resolveIdentity(): Promise<ContractIdentity> {
    if (this.#identityOverride !== undefined) return this.#identityOverride;
    this.#identity ??= await buildHostContractIdentity(await loadCompat(), {
      buildId: this.#buildId,
    });
    return this.#identity;
  }

  #resolveToken(options: { token?: string }): Uint8Array {
    if (options.token !== undefined) return toCredentialBytes(options.token);
    if (this.#configToken !== undefined) return this.#configToken;
    const env = Deno.env.get("STUDIOBOX_TOKEN");
    if (env !== undefined && env !== "") return toCredentialBytes(env);
    throw new MissingTokenError();
  }

  /** Connect + handshake the host control plane. */
  async #connectHostControl(
    credential: Uint8Array,
  ): Promise<{ control: RpcStub<HostControl>; connection: WireConnection }> {
    const identity = await this.#resolveIdentity();
    let conn: Deno.Conn;
    try {
      conn = await connectEndpoint(this.#control);
    } catch (error) {
      throw new ConnectionEstablishmentError(
        503,
        "host_unreachable",
        `hostd control endpoint is unreachable: ${errorText(error)}`,
      );
    }
    const connection = openWireConnection(conn, this.#timeoutMs);
    try {
      const bootstrap = await HostBootstrap.bootstrapClient(
        connection.wireClient,
        { timeoutMs: this.#timeoutMs },
      );
      const negotiated = await bootstrap.negotiate(
        protocolOfferToWire({
          identity,
          limits: DEFAULT_TRANSPORT_LIMITS,
          requiredFeatureBits: HOST_FEATURE_BITS,
        }),
        { timeoutMs: this.#timeoutMs },
      );
      if (negotiated.which !== "accepted") {
        throw new ConnectionEstablishmentError(
          426,
          "handshake_rejected",
          negotiated.error?.message ?? "host handshake was rejected",
        );
      }
      const authed = await bootstrap.authenticate(credential.slice(), {
        timeoutMs: this.#timeoutMs,
      });
      if (authed.which !== "accepted") {
        throw new ConnectionEstablishmentError(
          401,
          "unauthenticated",
          authed.error?.message ?? "host rejected the credential",
        );
      }
      const control = await bootstrap.host({
        timeoutMs: this.#timeoutMs,
        finish: { releaseResultCaps: false },
      });
      return { control, connection };
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  /**
   * From a live HostControl + a sandbox id, open the tunnel, dial it, run the
   * agent bootstrap, and assemble the {@link AgentBackedSandbox}. The host
   * connection stays open (owned by the returned sandbox for kill /
   * extendTimeout).
   */
  async #attachSandbox(
    control: RpcStub<HostControl>,
    hostConnection: WireConnection,
    id: string,
  ): Promise<Sandbox> {
    let sandboxStub: RpcStub<HostSandbox>;
    let grant: TunnelGrant;
    try {
      sandboxStub = await control.sandbox(id, {
        timeoutMs: this.#timeoutMs,
        finish: { releaseResultCaps: false },
      });
      const opened = expectArm(
        await sandboxStub.openTunnel({
          timeoutMs: this.#timeoutMs,
          finish: { releaseResultCaps: false },
        }),
        "grant",
      );
      grant = opened.grant!;
    } catch (error) {
      await hostConnection.close();
      throw normalizeThrown(error);
    }

    // Dial the static tunnel endpoint with the grant's ticket.
    let tunnelConn: Deno.Conn;
    try {
      tunnelConn = await dialTunnel(this.#tunnel, grant.ticket, {
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      await hostConnection.close();
      throw new ConnectionEstablishmentError(
        502,
        "tunnel_dial_failed",
        `tunnel dial failed: ${errorText(error)}`,
      );
    }

    // Agent bootstrap over the spliced tunnel conn.
    const agentConnection = openWireConnection(tunnelConn, this.#timeoutMs);
    let agent: RpcStub<agentWire.SandboxAgent>;
    try {
      const bootstrap = await agentWire.AgentBootstrap.bootstrapClient(
        agentConnection.wireClient,
        { timeoutMs: this.#timeoutMs },
      );
      const handshake = await bootstrap.negotiate({
        identity: identityToWire(m3AgentContractIdentity(this.#buildId)),
        limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
        requiredFeatureBits: AGENT_PLANE_FEATURES,
      }, { timeoutMs: this.#timeoutMs });
      if (handshake.which !== "accepted") {
        throw new ConnectionEstablishmentError(
          426,
          "agent_handshake_rejected",
          handshake.error?.message ?? "agent handshake was rejected",
        );
      }
      const auth = await bootstrap.authenticate({
        credential: grant.agentCredential,
        sandboxId: grant.sandboxId,
        bootNonce: grant.bootNonce,
      }, { timeoutMs: this.#timeoutMs });
      if (auth.which !== "accepted") {
        throw new ConnectionEstablishmentError(
          401,
          "agent_unauthenticated",
          auth.error?.message ?? "agent rejected the credential",
        );
      }
      agent = await bootstrap.agent({
        timeoutMs: this.#timeoutMs,
        finish: { releaseResultCaps: false },
      });
    } catch (error) {
      await agentConnection.close();
      await hostConnection.close();
      throw normalizeThrown(error);
    }

    const { backend } = await resolveWireBackend(
      agent,
      agentConnection.wireClient,
      this.#timeoutMs,
    );

    const timeoutMs = this.#timeoutMs;
    return new AgentBackedSandbox(backend, {
      id,
      teardown: async () => {
        await agentConnection.close();
        await hostConnection.close();
      },
      kill: async () => {
        // The authoritative terminate must SURFACE failure — a swallowed
        // error here (or an unchecked `error` result arm) reports the VM dead
        // when it may still be live. Both map to SandboxKillError.
        let result: EmptyResult;
        try {
          result = await sandboxStub.kill({ timeoutMs });
        } catch (error) {
          const mapped = normalizeThrown(error);
          throw new SandboxKillError(
            0,
            mapped instanceof Error ? mapped.message : String(mapped),
          );
        }
        if (result.which !== "ok") {
          const err = result.error;
          throw new SandboxKillError(
            0,
            err?.message || `host refused to kill sandbox (${err?.code ?? ""})`,
          );
        }
      },
      extendTimeout: async (ms: number): Promise<Date> => {
        const result = expectArm(
          await sandboxStub.extendTimeout(BigInt(ms), { timeoutMs }),
          "deadline",
        );
        return new Date(Number(result.deadline!.deadlineUnixMs));
      },
      exposeHttp: async (guestPort: number): Promise<string> => {
        // hostd leases a host port and asks rootd to install the DNAT; the
        // `exposure` arm carries the loopback URL to dial (M10 §6).
        const result = expectArm(
          await sandboxStub.exposeHttp(guestPort, { timeoutMs }),
          "exposure",
        );
        return result.exposure!.url;
      },
    });
  }

  /**
   * Back `Sandbox.create`: boot a microVM over hostd and return the façade
   * (upstream semantics). Tier C options (`secrets`/`volumes`/`root`/`ssh`/
   * `port`) throw `UnsupportedFeatureError`; `env` is applied post-create.
   */
  async create(options: SandboxOptions = {}): Promise<Sandbox> {
    for (const key of ["secrets", "volumes", "root", "ssh", "port"] as const) {
      if (options[key] !== undefined) {
        throw new UnsupportedFeatureError(`SandboxOptions.${key}`);
      }
    }
    const credential = this.#resolveToken(options);
    const createOptions = toCreateOptions(options);
    const { control, connection } = await this.#connectHostControl(credential);

    let id: string;
    try {
      const params: CreateParams = {
        options: createOptions,
        idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
      };
      const created = expectArm(
        await control.create(params, { timeoutMs: this.#timeoutMs }),
        "success",
      );
      id = created.success!.sandbox.id;
    } catch (error) {
      await connection.close();
      throw normalizeThrown(error);
    }

    const sandbox = await this.#attachSandbox(control, connection, id);

    // Apply SandboxOptions.env post-create (upstream semantics).
    if (options.env !== undefined) {
      try {
        for (const [key, value] of Object.entries(options.env)) {
          await sandbox.env.set(key, value);
        }
      } catch (error) {
        await sandbox.close().catch(() => {});
        throw error;
      }
    }
    return sandbox;
  }

  /** Back `Sandbox.connect`: re-attach to a running sandbox by its id. */
  async connect(id: string, options: ConnectOptions = {}): Promise<Sandbox> {
    if (!SANDBOX_ID_RE.test(id)) {
      throw new ConnectionEstablishmentError(
        400,
        "invalid_id",
        `not a Studiobox sandbox id: ${id}`,
      );
    }
    const credential = this.#resolveToken(options);
    const { control, connection } = await this.#connectHostControl(credential);
    return await this.#attachSandbox(control, connection, id);
  }

  /** Back `Client.sandboxes.list` (Tier A): running sandboxes, label-filtered. */
  async list(options?: SandboxesListOptions): Promise<SandboxMetadata[]> {
    const credential = this.#resolveToken({});
    const { control, connection } = await this.#connectHostControl(credential);
    try {
      const listed = expectArm(
        await control.list({ timeoutMs: this.#timeoutMs }),
        "success",
      );
      const wanted = Object.entries(options?.labels ?? {});
      const out: SandboxMetadata[] = [];
      for (const meta of listed.success!.sandboxes) {
        const labels: Record<string, string> = {};
        for (const kv of meta.labels) labels[kv.key] = kv.value;
        if (wanted.some(([key, value]) => labels[key] !== value)) continue;
        out.push({
          id: meta.id,
          createdAt: new Date(Number(meta.createdAtUnixMs)),
          stoppedAt: meta.state === "terminated" ? new Date() : null,
          region: meta.region as Region,
          status: meta.state === "running" ? "running" : "stopped",
          labels,
        });
      }
      return out;
    } catch (error) {
      throw normalizeThrown(error);
    } finally {
      await connection.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new Error(`StudioboxProvider requires ${name}`);
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let compatCache: Promise<HostCompatIdentitySource> | undefined;

/** Load the bundled `compat/wire.json` (the real schema-bundle hash). */
function loadCompat(): Promise<HostCompatIdentitySource> {
  compatCache ??= (async () => {
    const text = await Deno.readTextFile(
      new URL("../../compat/wire.json", import.meta.url),
    );
    return JSON.parse(text) as HostCompatIdentitySource;
  })();
  return compatCache;
}
