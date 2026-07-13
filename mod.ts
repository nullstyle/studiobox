/**
 * `@nullstyle/studiobox` — a Deno-native, source-compatible substitute for
 * [`@deno/sandbox`](https://jsr.io/@deno/sandbox), backed by Firecracker
 * microVMs on hosts you control.
 *
 * This root export is the **client SDK surface**: the same shape as
 * `@deno/sandbox` (`Sandbox.create`/`connect`, `sh`, `spawn`, `fs`, `env`,
 * `deno`, `exposeHttp`, …) plus the studiobox error taxonomy. Swap the import
 * and existing `@deno/sandbox` code runs against local microVMs unchanged:
 *
 * ```ts
 * // import { Sandbox } from "@deno/sandbox";
 * import { Sandbox } from "@nullstyle/studiobox";
 *
 * await using sandbox = await Sandbox.create();
 * await sandbox.sh`echo hello`;
 * ```
 *
 * Two companion exports sit beside this one:
 * - [`@nullstyle/studiobox/testing`](./testing/mod.ts) — `FakeSandboxHost`, to
 *   test a studiobox-consuming app with no VM;
 * - `@nullstyle/studiobox/unstable-host` — the (pre-1.0, unstable) daemon
 *   assembly seams for embedders that stand up a local host.
 *
 * @module
 */

// The client SDK surface — the `@deno/sandbox` parity barrel.
export * from "./src/mod.ts";
