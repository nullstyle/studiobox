/**
 * M10 §W5 real-hardware networking validation — the exit proof that the Tier-B
 * dataplane (per-sandbox TAP + host NAT + egress nftables + dnsmasq) works
 * end-to-end against REAL Firecracker microVMs inside the `fc-smoke` guest.
 *
 * Armed only in-guest (`SBX_VM=1`, Linux + KVM + root); off-guest every case is
 * ignored so the file still imports/typechecks on macOS. Driven by
 * `deno task test:vm:network` (which syncs the tree, bakes/reuses the golden
 * set with `iproute2` + the network overlay-init, compiles the daemons, and
 * runs this file as root with the `SBX_VM_*` contract).
 *
 * Unlike the M8 parity gate (which boots sandboxes vsock-only), this stands the
 * real stack up with `network.upstreamDns` set, so rootd runs the dataplane and
 * a created sandbox boots with a real NIC. It asserts (design §11): the guest
 * NIC comes up with its assigned address; an unrestricted sandbox reaches the
 * internet (raw IP + DNS); a restricted `allowNet` sandbox reaches an allowed
 * host but is blocked from a denied one; and reclaim leaves zero per-sandbox
 * residue (no `sbxtap*` link, no `sbx_eg_*` table) while the shared tables stay.
 *
 * @module
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { inGuest, readVmConfig } from "./support.ts";
import { startRealStack } from "./real_stack.ts";
import { installSandboxProvider } from "../../src/api/provider.ts";
import { Sandbox } from "../../src/api/sandbox.ts";

/** dnsmasq upstream — a public resolver reachable via the guest's NAT'd uplink. */
const UPSTREAM_DNS = "1.1.1.1";
/** A stable HTTPS host reachable by name (exercises DNS via the dnsmasq) + IP. */
const REACH_HOST = "one.one.one.one";
const REACH_IP = "1.1.1.1";
/** A host that must be BLOCKED for a sandbox restricted to REACH_HOST only. */
const DENIED_HOST = "example.com";

/** Run a host (fc-smoke) command and return trimmed stdout. */
async function hostStdout(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "null",
  })
    .output();
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test({
  name: "M10 network: unrestricted sandbox reaches the internet (IP + DNS)",
  ignore: !inGuest,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await using stack = await startRealStack(readVmConfig(), {
      network: { upstreamDns: UPSTREAM_DNS },
    });
    const restore = installSandboxProvider(stack.provider);
    try {
      const sandbox = await Sandbox.create();
      try {
        // The guest NIC came up with its assigned address (overlay-init §W5).
        const ifshow = await sandbox.sh`ip -4 addr show eth0`.text();
        assertStringIncludes(ifshow, "10.201.", "eth0 has a pool address");
        assertStringIncludes(ifshow, "eth0");

        // Raw egress + NAT: reach an IP with no DNS in the path. The eval
        // source must PRODUCE a promise (an async IIFE) — the agent awaits the
        // produced value, but the eval context has no top-level await.
        const ipStatus = await sandbox.deno.eval<number>(
          `(async () => (await fetch("https://${REACH_IP}", ` +
            `{ signal: AbortSignal.timeout(10000) })).status)()`,
        );
        assert(ipStatus > 0, `IP fetch returned HTTP ${ipStatus}`);

        // DNS via the per-sandbox dnsmasq + egress: reach a host by NAME.
        const dnsStatus = await sandbox.deno.eval<number>(
          `(async () => (await fetch("https://${REACH_HOST}", ` +
            `{ signal: AbortSignal.timeout(10000) })).status)()`,
        );
        assert(dnsStatus > 0, `DNS fetch returned HTTP ${dnsStatus}`);
      } finally {
        await sandbox.close();
      }
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "M10 network: restricted allowNet reaches allowed, blocks denied",
  ignore: !inGuest,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await using stack = await startRealStack(readVmConfig(), {
      network: { upstreamDns: UPSTREAM_DNS },
    });
    const restore = installSandboxProvider(stack.provider);
    try {
      const sandbox = await Sandbox.create({ allowNet: [REACH_HOST] });
      try {
        // Allowed host resolves + egresses.
        const allowed = await sandbox.deno.eval<number>(
          `(async () => (await fetch("https://${REACH_HOST}", ` +
            `{ signal: AbortSignal.timeout(10000) })).status)()`,
        );
        assert(allowed > 0, `allowed host returned HTTP ${allowed}`);

        // Denied host is dropped by the egress filter — the fetch never
        // completes (connection blackholed) and the timeout aborts it.
        let blocked = false;
        try {
          await sandbox.deno.eval(
            `(async () => { await fetch("https://${DENIED_HOST}", ` +
              `{ signal: AbortSignal.timeout(6000) }); return 0; })()`,
          );
        } catch {
          blocked = true;
        }
        assert(
          blocked,
          `${DENIED_HOST} must be blocked for a restricted sandbox`,
        );
      } finally {
        await sandbox.close();
      }
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "M10 network: reclaim leaves zero per-sandbox residue",
  ignore: !inGuest,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await using stack = await startRealStack(readVmConfig(), {
      network: { upstreamDns: UPSTREAM_DNS },
    });
    const restore = installSandboxProvider(stack.provider);
    let sandboxId = "";
    try {
      const sandbox = await Sandbox.create();
      sandboxId = sandbox.id;
      assertEquals(await sandbox.sh`echo up`.text(), "up\n");
      // While live, the TAP + egress table exist.
      const linksLive = await hostStdout("ip", ["-o", "link", "show"]);
      assertStringIncludes(linksLive, "sbxtap", "a TAP exists while live");
      await sandbox.close();
    } finally {
      restore();
    }

    // Reclaim is ASYNC on the daemon side (close → session death → terminate →
    // NetworkReclaimHook), so poll for the per-sandbox residue to clear rather
    // than racing it. The shared tables (nat/isolation/hostguard) must stay.
    let cleared = false;
    let lastLinks = "";
    let lastTables = "";
    for (let i = 0; i < 40; i++) {
      lastLinks = await hostStdout("ip", ["-o", "link", "show"]);
      lastTables = await hostStdout("nft", ["list", "tables"]);
      const noTap = !lastLinks.includes("sbxtap");
      const noTables = !lastTables.includes("sbx_eg_") &&
        !lastTables.includes("sbx_pf_");
      if (noTap && noTables) {
        cleared = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(
      cleared,
      `per-sandbox residue must clear after close:\n${lastLinks}\n${lastTables}`,
    );
    assertStringIncludes(lastTables, "studiobox_nat", "shared NAT table stays");
    assert(sandboxId.startsWith("sbx_loc_"));
  },
});
