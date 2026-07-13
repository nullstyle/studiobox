/**
 * Bake a warm-template snapshot for one golden manifest hash and publish it to
 * the template store (`docs/snapshot-restore.md` §1.5, §7 step 1, WI-5). This
 * is the `template:build` task — the explicit prewarm entrypoint; the lazy
 * on-first-restore trigger (WI-6) calls the same {@linkcode buildWarmTemplate}
 * primitive.
 *
 * End to end it cold-boots ONE template microVM (studioboxd `--template`, a
 * placeholder NIC, no credential), waits until template-mode studioboxd answers
 * on the guest vsock, pauses + snapshots it, copies `{snapshot, mem,
 * overlay.ext4}` out into `<template-root>/<hash>/`, and writes + validates
 * `template.json`. The heavy lifting is the {@linkcode MachineTemplateBaker}
 * (VM-only); this file wires the real collaborators and owns the throwaway
 * placeholder TAP's lifecycle.
 *
 * Linux + KVM + root required (jailer, real microVM). Runs inside the fc-smoke
 * Lima VM or any Linux+KVM CI runner. The store/paths/validation/refcount it
 * feeds are host-safe and unit-tested; this tool is proven by WI-8.
 *
 * Machine-readable contract: the FINAL stdout line is a JSON object
 * `{ "hash", "dir", "created", "reused", "arch", "templateRoot" }`. All human
 * logs go to stderr.
 *
 * Usage:
 *   deno task template:build --hash <manifestHash> \
 *     [--arch aarch64|x86_64] [--cache-root DIR] [--template-root DIR]
 *     [--work DIR] [--jailer-bin PATH] [--firecracker-bin PATH]
 *     [--uid N] [--gid N] [--chroot-base-dir DIR] [--tap NAME]
 *     [--vcpu N] [--mem-mib N] [--vsock-port N]
 *
 * @module
 */

import { fromFileUrl, join } from "@std/path";
import { DirRegistry, type Machine } from "@nullstyle/firecracker";
import { RpcWireClient, TcpTransport } from "@nullstyle/capnp";
import wireCompat from "../compat/wire.json" with { type: "json" };
import { ArtifactCache } from "../images/cache.ts";
import type { ArtifactArch } from "../images/pins.ts";
import {
  AGENT_PLANE_FEATURES,
  identityToWire,
  limitsToWire,
  m3AgentContractIdentity,
} from "../src/agent/service.ts";
import { DEFAULT_TRANSPORT_LIMITS } from "../src/wire/contract.ts";
import * as wire from "../src/wire/generated/sandbox_agent_types.ts";
import { buildWarmTemplate } from "../src/rootd/template/builder.ts";
import {
  MachineTemplateBaker,
  type TemplateReadinessProbe,
} from "../src/rootd/template/machine_baker.ts";
import { TemplateStore } from "../src/rootd/template/store.ts";

const REPO_ROOT = fromFileUrl(new URL("../", import.meta.url));

function log(message: string): void {
  console.error(`[template:build] ${message}`);
}

function fail(message: string): never {
  console.error(`[template:build] ✗ ${message}`);
  Deno.exit(1);
}

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    if (!arg.startsWith("--")) continue;
    const next = Deno.args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(arg, next);
      i++;
    } else {
      args.set(arg, "true");
    }
  }
  return args;
}

/** Run a subprocess to completion; throw on non-zero exit. */
async function run(cmd: string[]): Promise<void> {
  const status = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`command failed (${status.code}): ${cmd.join(" ")}`);
  }
}

/**
 * Readiness = template-mode studioboxd answers `negotiate` on the guest vsock
 * (§1.5 step 3: run only `negotiate`, do NOT authenticate — there is no
 * credential yet). The vsock connect retries until the guest listener is up;
 * a successful `negotiate` proves the schema/firecracker pin match.
 */
export const negotiateTemplateReadiness: TemplateReadinessProbe = {
  async waitReady(
    machine: Machine,
    options: {
      readonly vsockPort: number;
      readonly timeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<void> {
    const conn = await machine.vsock.connect(options.vsockPort, {
      retryTimeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let wireClient: RpcWireClient | null = null;
    const transport = new TcpTransport(conn, {
      closeTimeoutMs: options.timeoutMs,
      frameLimits: { maxFrameBytes: DEFAULT_TRANSPORT_LIMITS.maxFrameBytes },
      onClose: () => void wireClient?.close().catch(() => {}),
      onError: () => void wireClient?.close().catch(() => {}),
    });
    wireClient = new RpcWireClient(transport, {
      defaultTimeoutMs: options.timeoutMs,
    });
    const client = wireClient;
    try {
      const bootstrap = await wire.AgentBootstrap.bootstrapClient(client, {
        timeoutMs: options.timeoutMs,
      });
      const handshake = await bootstrap.negotiate({
        identity: identityToWire(
          m3AgentContractIdentity("studiobox-template-build"),
        ),
        limits: limitsToWire(DEFAULT_TRANSPORT_LIMITS),
        requiredFeatureBits: AGENT_PLANE_FEATURES,
      }, { timeoutMs: options.timeoutMs });
      if (handshake.which !== "accepted") {
        throw new Error(
          `template-mode studioboxd rejected negotiate: ${
            handshake.error?.message ?? "unknown"
          }`,
        );
      }
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  },
};

async function main(): Promise<void> {
  const args = parseArgs();
  if (Deno.build.os !== "linux") {
    fail("template:build only runs on Linux (jailer + real microVM)");
  }
  const arch = (args.get("--arch") ??
    (Deno.build.arch === "aarch64" ? "aarch64" : "x86_64")) as ArtifactArch;
  if (arch !== "aarch64" && arch !== "x86_64") {
    fail(`unsupported --arch ${arch}`);
  }

  const hash = args.get("--hash");
  if (hash === undefined || hash === "true") {
    fail("--hash <manifestHash> is required");
  }

  const cacheRoot = args.get("--cache-root") ??
    join(REPO_ROOT, ".build", "vm-cache");
  const templateRoot = args.get("--template-root") ??
    join(cacheRoot, "templates");
  const work = args.get("--work") ??
    join(REPO_ROOT, ".build", "vm-template-build", hash);
  const jailerBin = args.get("--jailer-bin") ?? "/usr/local/bin/jailer";
  const firecrackerBin = args.get("--firecracker-bin") ??
    "/usr/local/bin/firecracker";
  const uid = Number(args.get("--uid") ?? "10000");
  const gid = Number(args.get("--gid") ?? "10000");
  const chrootBaseDir = args.get("--chroot-base-dir") ?? "/srv/jailer";
  const tap = args.get("--tap") ?? "sbxtap-tmpl";
  const vcpuCount = Number(args.get("--vcpu") ?? "1");
  const memSizeMib = Number(args.get("--mem-mib") ?? "512");
  const vsockPort = Number(args.get("--vsock-port") ?? "1024");

  const cache = new ArtifactCache({ root: cacheRoot });
  if (!(await cache.has(hash))) {
    fail(`golden set ${hash} is not cached under ${cacheRoot}`);
  }
  const setDir = cache.setPath(hash);
  const store = new TemplateStore({ root: templateRoot });
  const registry = new DirRegistry(join(work, "registry"));

  await Deno.mkdir(work, { recursive: true });

  // Provision a throwaway placeholder TAP so the template's virtio-net has a
  // backend at boot (§1.4); restores never use it. Torn down in `finally`.
  log(`provisioning placeholder TAP ${tap}`);
  await run([
    "ip",
    "tuntap",
    "add",
    "dev",
    tap,
    "mode",
    "tap",
    "user",
    String(uid),
    "group",
    String(gid),
  ]);
  try {
    await run(["ip", "link", "set", tap, "up"]);

    const baker = new MachineTemplateBaker({
      jailer: { jailerBin, firecrackerBin, uid, gid, chrootBaseDir },
      registry,
      readiness: negotiateTemplateReadiness,
      placeholderTapName: tap,
    });

    log(`baking warm template for golden set ${hash} (${arch})…`);
    const result = await buildWarmTemplate({
      store,
      baker,
      manifestHash: hash,
      arch,
      setDir,
      workDir: work,
      schemaSha256: wireCompat.schemaSha256,
      vcpuCount,
      memSizeMib,
      vsockPort,
    });
    log(
      `${
        result.replaced ? "replaced" : result.created ? "baked" : "reused"
      } template ${result.hash} in ${templateRoot}`,
    );
    // Machine-readable final line.
    console.log(JSON.stringify({
      hash: result.hash,
      dir: result.dir,
      created: result.created,
      replaced: result.replaced,
      reused: result.reused,
      arch,
      templateRoot,
    }));
  } finally {
    await run(["ip", "link", "set", tap, "down"]).catch(() => {});
    await run(["ip", "tuntap", "del", "dev", tap, "mode", "tap"]).catch(
      () => {},
    );
  }
}

if (import.meta.main) {
  await main();
}
