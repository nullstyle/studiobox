/**
 * Host-safe coverage of the composed {@link NetworkReclaimHook} (M10 §8): from
 * the JOURNAL alone (no live in-memory state) it reaps dnsmasq, removes the
 * egress table, tears the TAP down, and releases the slot — in that order, each
 * by exact name — so a cold reconcile after a crash reclaims fully. A record
 * with no journaled TAP is a clean no-op (netless / never-provisioned).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../../src/rootd/network/apply.ts";
import { EgressController } from "../../../../src/rootd/network/apply.ts";
import { BitmapSubnetAllocator } from "../../../../src/rootd/network/allocator.ts";
import { NetworkController } from "../../../../src/rootd/network/dataplane.ts";
import {
  DnsmasqController,
  type FileReader,
  type FileRemover,
  type ProcessSignaller,
} from "../../../../src/rootd/network/dnsmasq.ts";
import {
  NetworkReclaimHook,
  slotOfTapName,
} from "../../../../src/rootd/network/reclaim_hook.ts";
import { egressTableName } from "../../../../src/rootd/network/ruleset.ts";
import type { SandboxRecord } from "../../../../src/state/model.ts";

interface RecordedCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

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

class FakeReader implements FileReader {
  constructor(private readonly byPath: Record<string, string>) {}
  read(path: string): Promise<string> {
    const value = this.byPath[path];
    if (value === undefined) {
      return Promise.reject(new Deno.errors.NotFound(path));
    }
    return Promise.resolve(value);
  }
}

class FakeRemover implements FileRemover {
  readonly removes: string[] = [];
  remove(path: string): Promise<void> {
    this.removes.push(path);
    return Promise.resolve();
  }
}

class FakeSignaller implements ProcessSignaller {
  readonly calls: { pid: number; signal: string }[] = [];
  signal(pid: number, signal: string): void {
    this.calls.push({ pid, signal });
  }
}

function record(
  overrides: Partial<SandboxRecord["resources"]> = {},
  hasTap = true,
): SandboxRecord {
  return {
    id: "sbx-reclaim",
    resources: {
      exposedPorts: [],
      ...(hasTap
        ? {
          tapName: "sbxtap5",
          hostIp: "10.201.0.21",
          guestIp: "10.201.0.22",
          subnet: "10.201.0.20/30",
          dnsmasqPidfile: "/run/studiobox/dns/5.pid",
        }
        : {}),
      ...overrides,
    },
  } as unknown as SandboxRecord;
}

function makeHook(): {
  hook: NetworkReclaimHook;
  networkRunner: FakeRunner;
  egressRunner: FakeRunner;
  reader: FakeReader;
  remover: FakeRemover;
  signaller: FakeSignaller;
  allocator: BitmapSubnetAllocator;
} {
  const networkRunner = new FakeRunner();
  const egressRunner = new FakeRunner();
  const reader = new FakeReader({ "/run/studiobox/dns/5.pid": "9182\n" });
  const remover = new FakeRemover();
  const signaller = new FakeSignaller();
  const allocator = new BitmapSubnetAllocator();
  const hook = new NetworkReclaimHook({
    allocator,
    network: new NetworkController({ runner: networkRunner }),
    dnsmasq: new DnsmasqController({ reader, remover, signaller }),
    egress: new EgressController({ runner: egressRunner }),
  });
  return {
    hook,
    networkRunner,
    egressRunner,
    reader,
    remover,
    signaller,
    allocator,
  };
}

Deno.test("NetworkReclaimHook.reclaim reaps dnsmasq, egress, TAP, and slot from the journal", async () => {
  const h = makeHook();
  // The slot the journal cites is currently reserved (the cold-start rebuild).
  h.allocator.reserve(5);
  assertEquals(h.allocator.inUse, 1);

  await h.hook.reclaim(record());

  // 1. dnsmasq: SIGKILL the journaled pid, unlink pid + conf.
  assertEquals(h.signaller.calls, [{ pid: 9182, signal: "SIGKILL" }]);
  assertEquals(h.remover.removes, [
    "/run/studiobox/dns/5.pid",
    "/run/studiobox/dns/5.conf",
  ]);
  // 2. egress: delete the id-derived table by exact name.
  assertEquals(h.egressRunner.calls.length, 1);
  assert(
    h.egressRunner.calls[0].stdin.includes(egressTableName("sbx-reclaim")),
    h.egressRunner.calls[0].stdin,
  );
  // 3. TAP: ip link del dev sbxtap5.
  assertEquals(h.networkRunner.calls, [
    { bin: "ip", args: ["link", "del", "dev", "sbxtap5"], stdin: "" },
  ]);
  // 4. slot: released back to the pool.
  assertEquals(h.allocator.inUse, 0);
});

Deno.test("NetworkReclaimHook.reclaim is a clean no-op when no TAP is journaled", async () => {
  const h = makeHook();
  await h.hook.reclaim(record({}, false));
  assertEquals(h.signaller.calls, []);
  assertEquals(h.remover.removes, []);
  assertEquals(h.egressRunner.calls, []);
  assertEquals(h.networkRunner.calls, []);
});

Deno.test("NetworkReclaimHook.reclaim tolerates a record with a TAP but no dnsmasq pidfile", async () => {
  const h = makeHook();
  h.allocator.reserve(5);
  // A TAP was journaled but the dnsmasq pidfile was not (e.g. install never
  // reached): the reap step is skipped, the rest still runs.
  await h.hook.reclaim(record({ dnsmasqPidfile: undefined }));
  assertEquals(h.signaller.calls, []);
  assertEquals(h.egressRunner.calls.length, 1);
  assertEquals(h.networkRunner.calls.length, 1);
  assertEquals(h.allocator.inUse, 0);
});

Deno.test("slotOfTapName parses the slot and rejects malformed names", () => {
  assertEquals(slotOfTapName("sbxtap0"), 0);
  assertEquals(slotOfTapName("sbxtap5"), 5);
  assertEquals(slotOfTapName("sbxtap16383"), 16383);
  assertThrows(() => slotOfTapName("eth0"), RangeError);
  assertThrows(() => slotOfTapName("sbxtap"), RangeError);
  assertThrows(() => slotOfTapName("sbxtapx"), RangeError);
});
