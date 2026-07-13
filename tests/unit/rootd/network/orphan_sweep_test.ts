/**
 * Host-safe coverage of the cold-start reconcile helpers
 * ({@link reserveLiveSlots}, {@link sweepNetworkOrphans}) — the network side of
 * the destructive restart reconcile (DESIGN networking-dataplane.md §6, §8).
 *
 * Everything is driven through fakes: a fake enumerator returns canned
 * `ip -o link show` / `nft list tables` output, a fake pidfile lister returns
 * canned `<slot>.pid` paths, and the REAL controllers run against fake runners /
 * signallers — so the sweep reaps exactly the unowned names (and leaves owned
 * ones) with no host access.
 */

import { assert, assertEquals } from "@std/assert";

import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../../src/rootd/network/apply.ts";
import { BitmapSubnetAllocator } from "../../../../src/rootd/network/allocator.ts";
import { NetworkController } from "../../../../src/rootd/network/dataplane.ts";
import {
  DnsmasqController,
  type FileReader,
  type FileRemover,
  type ProcessSignaller,
} from "../../../../src/rootd/network/dnsmasq.ts";
import { egressTableName } from "../../../../src/rootd/network/ruleset.ts";
import { portForwardTableName } from "../../../../src/rootd/network/port_forward.ts";
import {
  type CommandEnumerator,
  type EnumerationResult,
  type PidfileLister,
  reserveLiveSlots,
  sweepNetworkOrphans,
} from "../../../../src/rootd/network/orphan_sweep.ts";
import type {
  SandboxPhase,
  SandboxRecord,
} from "../../../../src/state/model.ts";

interface RecordedCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

/** Records every call and always succeeds (the reap controllers never fail here). */
class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  run(
    bin: string,
    args: readonly string[],
    stdin: string,
  ): Promise<EgressCommandResult> {
    this.calls.push({ bin, args: [...args], stdin });
    return Promise.resolve({ success: true, code: 0, stderr: "" });
  }
}

/** Returns canned stdout keyed by binary (`ip` vs `nft`). */
class FakeEnumerator implements CommandEnumerator {
  readonly calls: Array<{ bin: string; args: readonly string[] }> = [];
  #ipOut: string;
  #nftOut: string;
  constructor(ipOut: string, nftOut: string) {
    this.#ipOut = ipOut;
    this.#nftOut = nftOut;
  }
  run(bin: string, args: readonly string[]): Promise<EnumerationResult> {
    this.calls.push({ bin, args: [...args] });
    return Promise.resolve({
      success: true,
      stdout: bin === "ip" ? this.#ipOut : this.#nftOut,
    });
  }
}

class FakePidfileLister implements PidfileLister {
  #paths: readonly string[];
  constructor(paths: readonly string[]) {
    this.#paths = paths;
  }
  list(): Promise<readonly string[]> {
    return Promise.resolve(this.#paths);
  }
}

class RecordingSignaller implements ProcessSignaller {
  readonly kills: Array<{ pid: number; signal: string }> = [];
  signal(pid: number, signal: string): void {
    this.kills.push({ pid, signal });
  }
}

function record(
  id: string,
  phase: SandboxPhase,
  resources: Partial<SandboxRecord["resources"]> = {},
): SandboxRecord {
  return {
    id,
    phase,
    resources: { exposedPorts: [], ...resources },
  } as unknown as SandboxRecord;
}

Deno.test("reserveLiveSlots reserves every surviving record's slot and skips terminated", () => {
  const allocator = new BitmapSubnetAllocator();
  reserveLiveSlots(allocator, [
    record("sbx-a", "ready", { tapName: "sbxtap0" }),
    record("sbx-b", "quarantined", { tapName: "sbxtap2" }), // reclaim FAILED ⇒ live
    record("sbx-c", "terminated", { tapName: "sbxtap1" }), // reclaimed ⇒ freed
    record("sbx-d", "booting", { tapName: "sbxtap3" }),
    record("sbx-e", "ready"), // netless: no tapName ⇒ no slot
  ]);

  // Slots 0, 2, 3 reserved; slot 1 (terminated) stays free; netless holds none.
  assertEquals(allocator.inUse, 3);
  // The lowest FREE slot is 1 (the terminated record's), so a fresh launch reuses
  // exactly that — never a slot a surviving record still owns.
  assertEquals(allocator.allocate("exec-new").slot, 1);
});

Deno.test("sweepNetworkOrphans reaps exactly the unowned TAPs / tables / dnsmasq, leaving owned ones", async () => {
  // Ownership: `sbx-live` (ready) and `sbx-quar` (quarantined ⇒ reclaim failed,
  // still live) own their dataplane; `sbx-dead` (terminated) does not.
  const records = [
    record("sbx-live", "ready", {
      tapName: "sbxtap0",
      dnsmasqPidfile: "/run/studiobox/dns/0.pid",
    }),
    record("sbx-quar", "quarantined", {
      tapName: "sbxtap2",
      dnsmasqPidfile: "/run/studiobox/dns/2.pid",
    }),
    record("sbx-dead", "terminated", {
      tapName: "sbxtap1",
      dnsmasqPidfile: "/run/studiobox/dns/1.pid",
    }),
  ];

  const deadEg = egressTableName("sbx-dead"); // terminated ⇒ orphan
  const ghostPf = portForwardTableName("sbx-ghost"); // no record ⇒ orphan
  const liveEg = egressTableName("sbx-live"); // owned ⇒ kept
  const quarEg = egressTableName("sbx-quar"); // owned ⇒ kept

  const ipOut = [
    "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT",
    "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT",
    "3: sbxtap0: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT", // owned
    "4: sbxtap1: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT", // orphan
    "5: sbxtap2: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT", // owned
    "6: sbxtap5: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT", // orphan
    "",
  ].join("\n");
  const nftOut = [
    "table ip studiobox_nat", // shared ⇒ never a candidate
    "table inet studiobox_isolation",
    "table inet studiobox_hostguard",
    `table inet ${liveEg}`, // owned
    `table inet ${quarEg}`, // owned
    `table inet ${deadEg}`, // orphan (inet)
    `table ip ${ghostPf}`, // orphan (ip)
    "",
  ].join("\n");

  const networkRunner = new FakeRunner();
  const network = new NetworkController({ runner: networkRunner });
  const signaller = new RecordingSignaller();
  const reader: FileReader = { read: () => Promise.resolve("4321\n") };
  const remover: FileRemover = { remove: () => Promise.resolve() };
  const dnsmasq = new DnsmasqController({ reader, remover, signaller });

  const result = await sweepNetworkOrphans({
    records,
    enumerator: new FakeEnumerator(ipOut, nftOut),
    pidfiles: new FakePidfileLister([
      "/run/studiobox/dns/0.pid", // owned live
      "/run/studiobox/dns/2.pid", // owned quar
      "/run/studiobox/dns/1.pid", // orphan (terminated)
      "/run/studiobox/dns/9.pid", // orphan (no record)
    ]),
    network,
    dnsmasq,
  });

  // Exactly the unowned names, in enumeration order.
  assertEquals(result.taps, ["sbxtap1", "sbxtap5"]);
  assertEquals(result.tables, [deadEg, ghostPf]);
  assertEquals(result.pidfiles, [
    "/run/studiobox/dns/1.pid",
    "/run/studiobox/dns/9.pid",
  ]);

  // The controllers actually ran: TAP teardowns then table deletes, by exact name.
  assertEquals(networkRunner.calls[0].args, ["link", "del", "dev", "sbxtap1"]);
  assertEquals(networkRunner.calls[1].args, ["link", "del", "dev", "sbxtap5"]);
  assertEquals(
    networkRunner.calls[2].stdin,
    `add table inet ${deadEg}\ndelete table inet ${deadEg}\n`,
  );
  assertEquals(
    networkRunner.calls[3].stdin,
    `add table ip ${ghostPf}\ndelete table ip ${ghostPf}\n`,
  );
  assertEquals(networkRunner.calls.length, 4, "no owned TAP / table touched");

  // dnsmasq.reap ran for exactly the two orphan pidfiles (one SIGKILL each) —
  // never the owned `/run/studiobox/dns/0.pid` or `/2.pid`.
  assertEquals(signaller.kills.length, 2);
  assert(signaller.kills.every((k) => k.signal === "SIGKILL"));
});

Deno.test("sweepNetworkOrphans on a fresh host (no studiobox state) is a clean no-op", async () => {
  const networkRunner = new FakeRunner();
  const result = await sweepNetworkOrphans({
    records: [],
    enumerator: new FakeEnumerator(
      "1: lo: <LOOPBACK,UP>\n2: eth0: <BROADCAST,UP>\n",
      "table ip studiobox_nat\ntable inet studiobox_isolation\n",
    ),
    pidfiles: new FakePidfileLister([]),
    network: new NetworkController({ runner: networkRunner }),
    dnsmasq: new DnsmasqController({
      reader: { read: () => Promise.reject(new Error("gone")) },
      remover: { remove: () => Promise.resolve() },
      signaller: { signal: () => {} },
    }),
  });

  assertEquals(result, { taps: [], tables: [], pidfiles: [] });
  assertEquals(networkRunner.calls, []);
});
