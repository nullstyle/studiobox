import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type CommandRunner,
  EgressApplyError,
  type EgressCommandResult,
  EgressController,
  EgressReclaimError,
  EgressSpecError,
  type HostResolver,
  parseAllowNet,
  type ResolvedAddresses,
  type SandboxNetworkHandle,
} from "../../../../src/rootd/network/mod.ts";

const HANDLE: SandboxNetworkHandle = {
  sandboxId: "sbxa",
  tapDevice: "tap-a",
  guestIp: "10.0.0.2",
};
const RESOLVERS = ["10.0.0.1"];

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

const staticResolver = (answers: ResolvedAddresses): HostResolver => ({
  resolve: () => Promise.resolve(answers),
});

Deno.test("apply installs the ruleset with a single nft -f transaction", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({ runner, resolvers: RESOLVERS });
  const applied = await controller.apply({ mode: "unrestricted" }, HANDLE);

  assertEquals(runner.calls.length, 1);
  assertEquals(runner.calls[0].bin, "nft");
  assertEquals(runner.calls[0].args, ["-f", "-"]);
  assertEquals(applied.tableName, "sbx_eg_sbxa");
  assertStringIncludes(runner.calls[0].stdin, "table inet sbx_eg_sbxa {");
  assertStringIncludes(
    runner.calls[0].stdin,
    "add table inet sbx_eg_sbxa\ndelete table inet sbx_eg_sbxa\n",
  );
});

Deno.test("apply runs inside the network namespace when the handle has one", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({ runner, resolvers: RESOLVERS });
  await controller.apply({ mode: "unrestricted" }, {
    ...HANDLE,
    netns: "sbx-ns",
  });
  assertEquals(runner.calls[0].bin, "ip");
  assertEquals(runner.calls[0].args, [
    "netns",
    "exec",
    "sbx-ns",
    "nft",
    "-f",
    "-",
  ]);
});

Deno.test("apply resolves exact hostnames at apply time and bakes the IPs in", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({
    runner,
    resolver: staticResolver({ v4: ["93.184.216.34"], v6: [] }),
    resolvers: RESOLVERS,
  });
  await controller.apply(parseAllowNet(["example.com"]), HANDLE);
  assertStringIncludes(runner.calls[0].stdin, "elements = { 93.184.216.34 }");
  assertStringIncludes(runner.calls[0].stdin, "ip daddr @allow4 accept");
  assertStringIncludes(runner.calls[0].stdin, "drop\n");
});

Deno.test("a failed apply installs the deny-all seal and fails closed", async () => {
  // First call (the real apply) fails; the second (the seal) succeeds.
  const runner = new FakeRunner([{ success: false, code: 1, stderr: "boom" }]);
  const controller = new EgressController({ runner, resolvers: RESOLVERS });

  const error = await assertRejects(
    () => controller.apply(parseAllowNet(["1.2.3.4"]), HANDLE),
    EgressApplyError,
  );
  assertEquals(error.sealed, true);
  assertEquals(runner.calls.length, 2);
  // The seal is a hard deny-all: no established, no allow sets.
  const seal = runner.calls[1].stdin;
  assertStringIncludes(seal, 'iifname != "tap-a" accept');
  assertStringIncludes(seal, "drop\n");
  assert(!seal.includes("established"), "seal must not allow established");
  assert(!seal.includes("@allow"), "seal must not carry allow sets");
});

Deno.test("reclaim deletes exactly the sandbox's table, idempotently", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({ runner });
  await controller.reclaim({ sandboxId: "sbxa" });

  assertEquals(runner.calls.length, 1);
  assertEquals(
    runner.calls[0].stdin,
    "add table inet sbx_eg_sbxa\ndelete table inet sbx_eg_sbxa\n",
  );
});

Deno.test("reclaim removes exactly what apply added — same table, nothing else", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({ runner, resolvers: RESOLVERS });
  await controller.apply(parseAllowNet(["1.2.3.4", "*.example.com"]), HANDLE);
  await controller.reclaim({ sandboxId: HANDLE.sandboxId });

  const applyScript = runner.calls[0].stdin;
  const reclaimScript = runner.calls[1].stdin;
  assertStringIncludes(applyScript, "table inet sbx_eg_sbxa {");

  const deletes = reclaimScript.split("\n").filter((l) =>
    l.startsWith("delete table")
  );
  assertEquals(deletes, ["delete table inet sbx_eg_sbxa"]);
  // Never a wildcard sweep / flush of shared state (DESIGN.md §8).
  assert(!reclaimScript.includes("flush"), "no flush");
  assert(!reclaimScript.includes("*"), "no wildcard");
});

Deno.test("reclaim surfaces an unexpected nft failure as EgressReclaimError", async () => {
  const runner = new FakeRunner([{
    success: false,
    code: 1,
    stderr: "denied",
  }]);
  const controller = new EgressController({ runner });
  await assertRejects(
    () => controller.reclaim({ sandboxId: "sbxa" }),
    EgressReclaimError,
  );
});

Deno.test("reclaim targets the netns when given one", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({ runner });
  await controller.reclaim({ sandboxId: "sbxa", netns: "sbx-ns" });
  assertEquals(runner.calls[0].bin, "ip");
  assertEquals(runner.calls[0].args, [
    "netns",
    "exec",
    "sbx-ns",
    "nft",
    "-f",
    "-",
  ]);
});

Deno.test("applyAllowNet rejects a malformed spec before touching the host", async () => {
  const runner = new FakeRunner();
  const controller = new EgressController({ runner });
  await assertRejects(
    async () => {
      await controller.applyAllowNet(["bad_host!"], HANDLE);
    },
    EgressSpecError,
  );
  assertEquals(runner.calls.length, 0);
});
