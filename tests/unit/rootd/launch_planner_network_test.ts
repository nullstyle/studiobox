/**
 * Host-safe coverage of the M10 §W4 network-dataplane wiring in
 * {@link GoldenArtifactLaunchPlanner}: TAP allocation, egress seal, dnsmasq,
 * the `eth0` NIC + `ip=` / `studiobox.*` cmdline, the journaled `resources`,
 * and — critically — that every failure path fully unwinds (no TAP / dnsmasq /
 * nft / slot leak, and no window where a NIC is committed without an egress
 * filter).
 *
 * The dataplane is built from the REAL W1 controllers, each with its own fake
 * {@link CommandRunner} (network = `ip`/`sysctl`, egress = `nft`, dnsmasq =
 * `dnsmasq`), so provision / apply / install / reclaim / teardown are asserted
 * by the exact argv they emit — no host mutation, no DNS, no real dnsmasq.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

import { ArtifactCache } from "../../../images/cache.ts";
import { GoldenArtifactLaunchPlanner } from "../../../src/rootd/launch_planner.ts";
import type { SupervisorLaunchRequest } from "../../../src/rootd/supervisor_core_api.ts";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../src/rootd/network/apply.ts";
import { EgressController } from "../../../src/rootd/network/apply.ts";
import { BitmapSubnetAllocator } from "../../../src/rootd/network/allocator.ts";
import { NetworkController } from "../../../src/rootd/network/dataplane.ts";
import { DnsmasqController } from "../../../src/rootd/network/dnsmasq.ts";
import type { HostResolver } from "../../../src/rootd/network/resolver.ts";

const HASH = "b".repeat(64);

interface RecordedCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

/** Records every call; drains a preloaded result queue, else succeeds. */
class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  #results: EgressCommandResult[];
  constructor(results: EgressCommandResult[] = []) {
    this.#results = results;
  }
  run(
    bin: string,
    args: readonly string[],
    stdin: string,
  ): Promise<EgressCommandResult> {
    this.calls.push({ bin, args: [...args], stdin });
    const result = this.#results.shift() ??
      { success: true, code: 0, stderr: "" };
    return Promise.resolve(result);
  }
}

/** Never invoked for IP-only / unrestricted specs; guards against real DNS. */
const NO_RESOLVE: HostResolver = {
  resolve: () => Promise.resolve({ v4: [], v6: [] }),
};

interface Dataplane {
  readonly networkRunner: FakeRunner;
  readonly egressRunner: FakeRunner;
  readonly dnsmasqRunner: FakeRunner;
  readonly allocator: BitmapSubnetAllocator;
  readonly dataplane: {
    allocator: BitmapSubnetAllocator;
    network: NetworkController;
    dnsmasq: DnsmasqController;
    egress: EgressController;
    upstreamDns: string;
  };
}

function makeDataplane(
  results: {
    egress?: EgressCommandResult[];
    dnsmasq?: EgressCommandResult[];
  } = {},
): Dataplane {
  const networkRunner = new FakeRunner();
  const egressRunner = new FakeRunner(results.egress ?? []);
  const dnsmasqRunner = new FakeRunner(results.dnsmasq ?? []);
  const allocator = new BitmapSubnetAllocator();
  return {
    networkRunner,
    egressRunner,
    dnsmasqRunner,
    allocator,
    dataplane: {
      allocator,
      network: new NetworkController({ runner: networkRunner }),
      dnsmasq: new DnsmasqController({ runner: dnsmasqRunner }),
      egress: new EgressController({
        runner: egressRunner,
        resolver: NO_RESOLVE,
      }),
      upstreamDns: "1.1.1.1",
    },
  };
}

function request(
  overrides: Partial<SupervisorLaunchRequest> = {},
): SupervisorLaunchRequest {
  return {
    sandboxId: "sbx-net",
    executionId: "e-net-1",
    artifactId: "artifact-golden",
    allocationId: "alloc-1",
    bootNonce: new Uint8Array(32),
    idempotencyKey: new Uint8Array(16),
    ...overrides,
  };
}

async function seedCache(root: string): Promise<void> {
  const dir = join(root, HASH);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "refcount.json"),
    JSON.stringify({ schemaVersion: 1, count: 0 }) + "\n",
  );
}

async function withDirs(
  fn: (cacheRoot: string, workDir: string) => Promise<void>,
): Promise<void> {
  const cacheRoot = await Deno.makeTempDir({ prefix: "sbx-netplan-cache-" });
  const workDir = await Deno.makeTempDir({ prefix: "sbx-netplan-work-" });
  try {
    await fn(cacheRoot, workDir);
  } finally {
    await Deno.remove(cacheRoot, { recursive: true }).catch(() => {});
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

function plannerWith(
  cacheRoot: string,
  workDir: string,
  dataplane: Dataplane["dataplane"] | undefined,
): GoldenArtifactLaunchPlanner {
  return new GoldenArtifactLaunchPlanner({
    cache: new ArtifactCache({ root: cacheRoot }),
    manifestHash: HASH,
    arch: "aarch64",
    jailerBin: "/usr/local/bin/jailer",
    firecrackerBin: "/usr/local/bin/firecracker",
    uid: 10_001,
    gid: 10_002,
    chrootBaseDir: join(workDir, "jail"),
    overlayDir: join(workDir, "ov"),
    ...(dataplane === undefined ? {} : { dataplane }),
  });
}

Deno.test("resolve(restricted): adds one eth0 NIC, the ip=/studiobox cmdline, and journals resources", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const dp = makeDataplane();
    const planner = plannerWith(cacheRoot, workDir, dp.dataplane);

    const plan = await planner.resolve(request({ allowNet: ["1.2.3.4"] }));

    // Exactly one TAP-backed NIC, slot 0 → sbxtap0 / MAC.
    assertEquals(plan.config.network_interfaces, [
      {
        iface_id: "eth0",
        host_dev_name: "sbxtap0",
        guest_mac: "02:00:0a:c9:00:02",
      },
    ]);

    // The kernel ip= belt + the studiobox.* tokens W5 configures eth0 from.
    const bootArgs = plan.config.boot_source?.boot_args ?? "";
    assert(
      bootArgs.includes("ip=10.201.0.2::10.201.0.1:255.255.255.252::eth0:off"),
      bootArgs,
    );
    assert(bootArgs.includes("studiobox.ip=10.201.0.2/30"), bootArgs);
    assert(bootArgs.includes("studiobox.gw=10.201.0.1"), bootArgs);
    assert(bootArgs.includes("studiobox.dns=10.201.0.1"), bootArgs);

    // The journaled resources a cold-reconcile reclaim keys off.
    assertEquals(plan.resources, {
      tapName: "sbxtap0",
      hostIp: "10.201.0.1",
      guestIp: "10.201.0.2",
      subnet: "10.201.0.0/30",
      dnsmasqPidfile: "/run/studiobox/dns/0.pid",
    });

    // provision(): the ordered TAP setup, owned by the jailer uid/gid.
    assertEquals(dp.networkRunner.calls[0], {
      bin: "ip",
      args: [
        "tuntap",
        "add",
        "dev",
        "sbxtap0",
        "mode",
        "tap",
        "user",
        "10001",
        "group",
        "10002",
      ],
      stdin: "",
    });
    assertEquals(dp.networkRunner.calls[1].args, [
      "addr",
      "add",
      "10.201.0.1/30",
      "dev",
      "sbxtap0",
    ]);

    // egress.apply(restricted): one nft table with the guest anti-spoof + the
    // 1.2.3.4 allow — NOT the empty unrestricted body.
    assertEquals(dp.egressRunner.calls.length, 1);
    const egressScript = dp.egressRunner.calls[0].stdin;
    assert(egressScript.includes("ip saddr != 10.201.0.2 drop"), egressScript);
    assert(egressScript.includes("1.2.3.4"), egressScript);

    // dnsmasq.install(): bound to the gateway on the slot's TAP, upstream 1.1.1.1.
    assertEquals(dp.dnsmasqRunner.calls.length, 1);
    assertEquals(dp.dnsmasqRunner.calls[0].bin, "dnsmasq");
    assertEquals(dp.dnsmasqRunner.calls[0].args, [
      "--keep-in-foreground=false",
      "--pid-file=/run/studiobox/dns/0.pid",
      "--listen-address=10.201.0.1",
      "--bind-interfaces",
      "--interface=sbxtap0",
      "--except-interface=lo",
      "--no-resolv",
      "--server=1.1.1.1",
    ]);

    assertEquals(dp.allocator.inUse, 1);
  });
});

Deno.test("resolve(allowNet unset): egress.apply is called with an UNRESTRICTED spec (still a sealed table)", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const dp = makeDataplane();
    const planner = plannerWith(cacheRoot, workDir, dp.dataplane);

    // No allowNet key ⇒ unrestricted (full internet), the upstream default.
    const plan = await planner.resolve(request());

    // A NIC + resources are still provisioned (unrestricted != netless).
    assertEquals(plan.config.network_interfaces?.length, 1);
    assertEquals(plan.resources?.tapName, "sbxtap0");

    // The egress table is still installed (unrestricted is NOT "no table"): its
    // chain body is empty (allow-all), so it carries the guest's TAP but no
    // anti-spoof / drop rules.
    assertEquals(dp.egressRunner.calls.length, 1);
    const script = dp.egressRunner.calls[0].stdin;
    assert(script.includes("table inet sbx_eg_"), script);
    assert(!script.includes("ip saddr != 10.201.0.2 drop"), script);
    assert(dp.dnsmasqRunner.calls.length === 1, "dnsmasq still runs");
  });
});

Deno.test("resolve(netless): no NIC, no network/egress/dnsmasq calls, no resources (vsock-only)", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const dp = makeDataplane();
    const planner = plannerWith(cacheRoot, workDir, dp.dataplane);

    const plan = await planner.resolve(request({ netless: true }));

    assertEquals(plan.config.network_interfaces, undefined);
    assertEquals(plan.resources, undefined);
    const bootArgs = plan.config.boot_source?.boot_args ?? "";
    assert(!bootArgs.includes("ip="), bootArgs);
    assert(!bootArgs.includes("studiobox.ip="), bootArgs);
    assert(!bootArgs.includes("studiobox.gw="), bootArgs);

    assertEquals(dp.networkRunner.calls, []);
    assertEquals(dp.egressRunner.calls, []);
    assertEquals(dp.dnsmasqRunner.calls, []);
    assertEquals(dp.allocator.inUse, 0);
  });
});

Deno.test("resolve: an EgressApplyError reclaims the seal + TAP + slot, and never commits a NIC", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const cache = new ArtifactCache({ root: cacheRoot });
    // The nft apply FAILS but its deny-all seal SUCCEEDS: EgressController.apply
    // installs the live `sbx_eg_<id>` seal table and THEN throws EgressApplyError.
    // The seal is now live even though apply never "returned" — the exact leak
    // the unconditional #unwindNetwork egress.reclaim closes.
    const dp = makeDataplane({
      egress: [
        { success: false, code: 1, stderr: "nft apply boom" }, // apply fails
        { success: true, code: 0, stderr: "" }, // seal SUCCEEDS ⇒ live table
      ],
    });
    const planner = plannerWith(cacheRoot, workDir, dp.dataplane);

    await assertRejects(() =>
      planner.resolve(request({ allowNet: ["1.2.3.4"] }))
    );

    // apply(0) + seal(1) + reclaim(2): the seal left a LIVE table, so the unwind
    // MUST reclaim it unconditionally or the deny-all seal leaks forever.
    assertEquals(dp.egressRunner.calls.length, 3);
    assert(dp.egressRunner.calls[0].stdin.includes("chain"), "call 0 is apply");
    assert(dp.egressRunner.calls[1].stdin.includes("chain"), "call 1 is seal");
    // The reclaim is the bare add;delete table script (no chain body).
    assert(
      !dp.egressRunner.calls[2].stdin.includes("chain"),
      "call 2 is reclaim",
    );
    // The TAP was torn down (ip link del) — the fatal-egress unwind.
    const teardown = dp.networkRunner.calls.at(-1);
    assertEquals(teardown?.args, ["link", "del", "dev", "sbxtap0"]);
    // dnsmasq was never reached, the slot is freed, and the artifact belt undone.
    assertEquals(dp.dnsmasqRunner.calls, []);
    assertEquals(dp.allocator.inUse, 0, "slot released — no leak");
    assertEquals(await cache.refcount(HASH), 0, "artifact belt undone");
  });
});

Deno.test("resolve: a dnsmasq.install failure best-effort reclaims egress + TAP + slot, then rethrows", async () => {
  await withDirs(async (cacheRoot, workDir) => {
    await seedCache(cacheRoot);
    const cache = new ArtifactCache({ root: cacheRoot });
    // egress.apply succeeds; the dnsmasq spawn fails.
    const dp = makeDataplane({
      dnsmasq: [{ success: false, code: 1, stderr: "dnsmasq bind failed" }],
    });
    const planner = plannerWith(cacheRoot, workDir, dp.dataplane);

    await assertRejects(() =>
      planner.resolve(request({ allowNet: ["1.2.3.4"] }))
    );

    // egress: apply(call 0) THEN reclaim(call 1) — the reclaim is the bare
    // add;delete table script (no chain body), unlike the apply.
    assertEquals(dp.egressRunner.calls.length, 2);
    assert(dp.egressRunner.calls[0].stdin.includes("chain"), "call 0 is apply");
    assert(
      !dp.egressRunner.calls[1].stdin.includes("chain"),
      "call 1 is reclaim",
    );
    // The TAP was torn down and the slot released.
    const teardown = dp.networkRunner.calls.at(-1);
    assertEquals(teardown?.args, ["link", "del", "dev", "sbxtap0"]);
    assertEquals(dp.allocator.inUse, 0, "slot released — no leak");
    assertEquals(await cache.refcount(HASH), 0, "artifact belt undone");
  });
});
