import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../../src/rootd/network/apply.ts";
import { subnetForSlot } from "../../../../src/rootd/network/allocator.ts";
import { egressTableName } from "../../../../src/rootd/network/ruleset.ts";
import {
  PortForwardController,
  PortForwardError,
  PortForwardReclaimError,
  portForwardTableName,
} from "../../../../src/rootd/network/port_forward.ts";

interface RecordedCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

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

Deno.test("portForwardTableName reuses egressTableName's injective encoding", () => {
  // Same injective encoding as the egress table, only the prefix differs.
  assertEquals(
    portForwardTableName("sbx-audit"),
    "sbx_pf_" + egressTableName("sbx-audit").slice("sbx_eg_".length),
  );
  assertEquals(portForwardTableName("sbx-audit"), "sbx_pf_sbx_2daudit");

  // Injectivity carries over: case/separator variants never collide.
  assertNotEquals(
    portForwardTableName("sbx-audit"),
    portForwardTableName("sbx-AUDIT"),
  );
  assertNotEquals(
    portForwardTableName("sbx-a-b"),
    portForwardTableName("sbx-a_b"),
  );
});

const EXPECTED_APPLY = [
  "add table ip sbx_pf_sbx_2daudit",
  "delete table ip sbx_pf_sbx_2daudit",
  "table ip sbx_pf_sbx_2daudit {",
  "\tchain output {",
  "\t\ttype nat hook output priority -100; policy accept;",
  "\t\tip daddr 127.0.0.1 tcp dport 40100 dnat to 10.201.0.2:8080",
  "\t}",
  "\tchain postrouting {",
  "\t\ttype nat hook postrouting priority 100; policy accept;",
  "\t\tip daddr 10.201.0.2 tcp dport 8080 snat to 10.201.0.1",
  "\t}",
  "}",
  "",
].join("\n");

Deno.test("expose installs the per-sandbox sbx_pf_ table with the exact nft script", async () => {
  const runner = new FakeRunner();
  const controller = new PortForwardController({ runner });
  const tableName = await controller.expose(subnetForSlot(0), {
    sandboxId: "sbx-audit",
    hostPort: 40100,
    guestPort: 8080,
  });

  assertEquals(tableName, "sbx_pf_sbx_2daudit");
  assertEquals(runner.calls.length, 1);
  assertEquals(runner.calls[0].bin, "nft");
  assertEquals(runner.calls[0].args, ["-f", "-"]);
  assertEquals(runner.calls[0].stdin, EXPECTED_APPLY);
});

Deno.test("expose surfaces an nft failure as PortForwardError", async () => {
  const runner = new FakeRunner([
    { success: false, code: 1, stderr: "boom" },
  ]);
  const controller = new PortForwardController({ runner });
  await assertRejects(
    () =>
      controller.expose(subnetForSlot(0), {
        sandboxId: "sbx-audit",
        hostPort: 40100,
        guestPort: 8080,
      }),
    PortForwardError,
  );
});

Deno.test("reclaim deletes exactly the sandbox's forward table by name", async () => {
  const runner = new FakeRunner();
  const controller = new PortForwardController({ runner });
  await controller.reclaim("sbx-audit");

  assertEquals(runner.calls.length, 1);
  assertEquals(
    runner.calls[0].stdin,
    "add table ip sbx_pf_sbx_2daudit\ndelete table ip sbx_pf_sbx_2daudit\n",
  );
  // Never a wildcard sweep / flush of shared state.
  const deletes = runner.calls[0].stdin.split("\n").filter((l) =>
    l.startsWith("delete table")
  );
  assertEquals(deletes, ["delete table ip sbx_pf_sbx_2daudit"]);
});

Deno.test("reclaim surfaces an unexpected nft failure as PortForwardReclaimError", async () => {
  const runner = new FakeRunner([
    { success: false, code: 1, stderr: "denied" },
  ]);
  const controller = new PortForwardController({ runner });
  await assertRejects(
    () => controller.reclaim("sbx-audit"),
    PortForwardReclaimError,
  );
});
