/**
 * `AgentEnvironment` implementation (Track A of the M3 agent plane).
 *
 * {@linkcode AgentEnv} is the in-memory environment store of the agent —
 * the mirror of `sandbox_agent.capnp` `Environment` with upstream
 * `env.*` semantics: it is the base layer every spawn inherits.
 * {@linkcode layerSpawnEnv} implements the layering rule shared with the
 * spawner: per-spawn `env` wins over the agent env on conflict, and
 * `clearEnv` drops the agent env entirely for that spawn.
 *
 * The store deliberately does NOT default to the host process
 * environment: the fake host seeds it explicitly per sandbox, and the
 * real agent seeds it from the guest environment at boot. That keeps the
 * fake from leaking the test host's environment into sandboxes.
 *
 * @module
 */

import { type AgentEnvironment, AgentError } from "./api.ts";

/**
 * Validate an environment variable name. Names must be non-empty and
 * must not contain `=` or NUL (the two characters no POSIX environment
 * can represent). Throws {@linkcode AgentError} `SBX_AGENT_VALIDATION`.
 */
export function validateEnvName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "environment variable name must be a non-empty string",
    );
  }
  if (name.includes("=") || name.includes("\0")) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      `environment variable name must not contain "=" or NUL: ${
        JSON.stringify(name)
      }`,
    );
  }
}

/**
 * Validate an environment variable value (must be a NUL-free string).
 * Throws {@linkcode AgentError} `SBX_AGENT_VALIDATION`.
 */
export function validateEnvValue(value: string): void {
  if (typeof value !== "string") {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "environment variable value must be a string",
    );
  }
  if (value.includes("\0")) {
    throw new AgentError(
      "SBX_AGENT_VALIDATION",
      "environment variable value must not contain NUL",
    );
  }
}

/**
 * Default search PATH a real guest sandbox exposes. `overlay-init` execs
 * studioboxd as pid 1 with the kernel's bare init environment (no PATH, no
 * HOME), so without this a bare-name spawn (`bash`, `sleep`, …) fails in the
 * guest with "no path to search". The value mirrors the golden rootfs's Debian
 * layout and matches an upstream `@deno/sandbox` guest.
 */
export const DEFAULT_GUEST_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Seed the guest's base environment. A default `PATH` sits UNDER the boot
 * environment (a boot-provided `PATH` wins; absent it, bare-name spawns still
 * resolve). `HOME`, by contrast, is FORCED to the sandbox home OVER the boot
 * value: `overlay-init` execs studioboxd as pid 1, whose init `HOME` is `/`
 * (or `/root`), which is NOT the sandbox's home — so `$HOME/.bashrc` (bash's
 * `BASH_ENV`) and `~` must resolve to `/home/app`, exactly as upstream. Pure.
 */
export function guestBaseEnvironment(
  home: string,
  bootEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  return { PATH: DEFAULT_GUEST_PATH, ...bootEnv, HOME: home };
}

/**
 * Compute the environment of one spawn from the agent base environment
 * and the per-spawn overlay: `clearEnv` drops the base; `env` entries
 * win over base entries on conflict. Pure — neither input is mutated.
 */
export function layerSpawnEnv(
  base: Readonly<Record<string, string>>,
  overlay: {
    readonly env?: Readonly<Record<string, string>>;
    readonly clearEnv?: boolean;
  },
): Record<string, string> {
  const merged: Record<string, string> = overlay.clearEnv ? {} : { ...base };
  for (const [name, value] of Object.entries(overlay.env ?? {})) {
    merged[name] = value;
  }
  return merged;
}

/**
 * In-memory {@linkcode AgentEnvironment}: `get`/`set`/`delete`/`toObject`
 * over a plain map, plus the synchronous {@linkcode AgentEnv.snapshot}
 * the spawner uses as the base layer of every spawn.
 */
export class AgentEnv implements AgentEnvironment {
  readonly #vars = new Map<string, string>();

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      validateEnvName(name);
      validateEnvValue(value);
      this.#vars.set(name, value);
    }
  }

  /** Value of `key`, or `undefined` when unset (never rejects for missing). */
  get(key: string): Promise<string | undefined> {
    try {
      validateEnvName(key);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve(this.#vars.get(key));
  }

  /** Set `key` for the agent and all future spawns. */
  set(key: string, value: string): Promise<void> {
    try {
      validateEnvName(key);
      validateEnvValue(value);
    } catch (err) {
      return Promise.reject(err);
    }
    this.#vars.set(key, value);
    return Promise.resolve();
  }

  /** Unset `key`; a no-op when already unset. */
  delete(key: string): Promise<void> {
    try {
      validateEnvName(key);
    } catch (err) {
      return Promise.reject(err);
    }
    this.#vars.delete(key);
    return Promise.resolve();
  }

  /** Snapshot of the entire agent environment. */
  toObject(): Promise<Record<string, string>> {
    return Promise.resolve(this.snapshot());
  }

  /**
   * Synchronous snapshot for the spawner's base layer. The returned
   * object is a copy — mutating it does not affect the store.
   */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#vars);
  }
}
