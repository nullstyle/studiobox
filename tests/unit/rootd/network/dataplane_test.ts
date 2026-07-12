import { assertEquals, assertRejects } from "@std/assert";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../../src/rootd/network/apply.ts";
import { subnetForSlot } from "../../../../src/rootd/network/allocator.ts";
import {
  NetworkController,
  NetworkControllerError,
} from "../../../../src/rootd/network/dataplane.ts";

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

const NAT_SCRIPT = [
  "add table ip studiobox_nat",
  "delete table ip studiobox_nat",
  "table ip studiobox_nat {",
  "\tchain postrouting {",
  "\t\ttype nat hook postrouting priority srcnat; policy accept;",
  '\t\tip saddr 10.201.0.0/16 oifname != "sbxtap*" masquerade',
  "\t}",
  "}",
  "",
].join("\n");

const ISOLATION_SCRIPT = [
  "add table inet studiobox_isolation",
  "delete table inet studiobox_isolation",
  "table inet studiobox_isolation {",
  "\tchain forward {",
  "\t\ttype filter hook forward priority -10; policy accept;",
  "\t\tip saddr 10.201.0.0/16 ip daddr 10.201.0.0/16 drop",
  "\t}",
  "}",
  "",
].join("\n");

Deno.test("ensureGlobal enables forwarding then installs the two shared nft tables", async () => {
  const runner = new FakeRunner();
  const controller = new NetworkController({ runner });
  await controller.ensureGlobal();

  assertEquals(runner.calls.length, 3);
  // 1. Enable IPv4 forwarding.
  assertEquals(runner.calls[0], {
    bin: "sysctl",
    args: ["-w", "net.ipv4.ip_forward=1"],
    stdin: "",
  });
  // 2. Shared masquerade table (byte-exact add;delete;add script).
  assertEquals(runner.calls[1].bin, "nft");
  assertEquals(runner.calls[1].args, ["-f", "-"]);
  assertEquals(runner.calls[1].stdin, NAT_SCRIPT);
  // 3. Shared inter-sandbox isolation table (byte-exact).
  assertEquals(runner.calls[2].bin, "nft");
  assertEquals(runner.calls[2].args, ["-f", "-"]);
  assertEquals(runner.calls[2].stdin, ISOLATION_SCRIPT);
});

Deno.test("ensureGlobal honours an overridden pool CIDR in both shared scripts", async () => {
  const runner = new FakeRunner();
  const controller = new NetworkController({
    runner,
    poolCidr: "10.50.0.0/16",
  });
  await controller.ensureGlobal();
  assertEquals(
    runner.calls[1].stdin.includes(
      'ip saddr 10.50.0.0/16 oifname != "sbxtap*" masquerade',
    ),
    true,
  );
  assertEquals(
    runner.calls[2].stdin.includes(
      "ip saddr 10.50.0.0/16 ip daddr 10.50.0.0/16 drop",
    ),
    true,
  );
});

Deno.test("provision runs the ordered TAP setup sequence with the exact argv", async () => {
  const runner = new FakeRunner();
  const controller = new NetworkController({ runner });
  await controller.provision(subnetForSlot(0), { uid: 123, gid: 456 });

  assertEquals(runner.calls, [
    {
      bin: "ip",
      args: [
        "tuntap",
        "add",
        "dev",
        "sbxtap0",
        "mode",
        "tap",
        "user",
        "123",
        "group",
        "456",
      ],
      stdin: "",
    },
    {
      bin: "ip",
      args: ["addr", "add", "10.201.0.1/30", "dev", "sbxtap0"],
      stdin: "",
    },
    {
      bin: "ip",
      args: ["link", "set", "dev", "sbxtap0", "up"],
      stdin: "",
    },
    {
      bin: "sysctl",
      args: ["-w", "net.ipv4.conf.sbxtap0.route_localnet=1"],
      stdin: "",
    },
  ]);
});

Deno.test("provision uses the slot's real gateway address for a non-zero slot", async () => {
  const runner = new FakeRunner();
  const controller = new NetworkController({ runner });
  await controller.provision(subnetForSlot(64), { uid: 1, gid: 1 });
  assertEquals(runner.calls[1].args, [
    "addr",
    "add",
    "10.201.1.1/30",
    "dev",
    "sbxtap64",
  ]);
});

Deno.test("provision tolerates a File-exists TAP for crash-restart idempotency", async () => {
  // The tuntap add races an existing TAP (crash-restart); provision continues.
  const runner = new FakeRunner([
    { success: false, code: 2, stderr: "ioctl(TUNSETIFF): File exists" },
  ]);
  const controller = new NetworkController({ runner });
  await controller.provision(subnetForSlot(0), { uid: 1, gid: 1 });
  assertEquals(runner.calls.length, 4);
});

Deno.test("provision surfaces an unexpected failure as NetworkControllerError", async () => {
  const runner = new FakeRunner([
    { success: false, code: 1, stderr: "Operation not permitted" },
  ]);
  const controller = new NetworkController({ runner });
  await assertRejects(
    () => controller.provision(subnetForSlot(0), { uid: 1, gid: 1 }),
    NetworkControllerError,
  );
});

Deno.test("teardown removes exactly the slot's TAP", async () => {
  const runner = new FakeRunner();
  const controller = new NetworkController({ runner });
  await controller.teardown(subnetForSlot(0));
  assertEquals(runner.calls, [
    { bin: "ip", args: ["link", "del", "dev", "sbxtap0"], stdin: "" },
  ]);
});

Deno.test("teardown is gone-tolerant: 'Cannot find device' is success", async () => {
  const runner = new FakeRunner([
    { success: false, code: 1, stderr: 'Cannot find device "sbxtap0"' },
  ]);
  const controller = new NetworkController({ runner });
  await controller.teardown(subnetForSlot(0)); // must not throw
  assertEquals(runner.calls.length, 1);
});

Deno.test("teardown is gone-tolerant: 'No such file' is success", async () => {
  const runner = new FakeRunner([
    {
      success: false,
      code: 1,
      stderr: "RTNETLINK answers: No such file or directory",
    },
  ]);
  const controller = new NetworkController({ runner });
  await controller.teardown(subnetForSlot(0)); // must not throw
});

Deno.test("teardown surfaces a genuinely unexpected failure", async () => {
  const runner = new FakeRunner([
    { success: false, code: 1, stderr: "Operation not permitted" },
  ]);
  const controller = new NetworkController({ runner });
  await assertRejects(
    () => controller.teardown(subnetForSlot(0)),
    NetworkControllerError,
  );
});
