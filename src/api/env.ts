/**
 * Environment-variable accessor for a running sandbox (`sandbox.env`).
 *
 * Mirrors `@deno/sandbox`'s `SandboxEnv`: reads and writes the guest process
 * environment. Tier A — `SandboxOptions.env` is applied post-create through
 * `set`, matching upstream, rather than injected at boot.
 */
export interface SandboxEnv {
  /** Read the value of `key`, or `undefined` if it is not set. */
  get(key: string): Promise<string | undefined>;
  /** Set `key` to `value` in the guest environment. */
  set(key: string, value: string): Promise<void>;
  /** Snapshot the full guest environment as a plain object. */
  toObject(): Promise<Record<string, string>>;
  /** Remove `key` from the guest environment. */
  delete(key: string): Promise<void>;
}
