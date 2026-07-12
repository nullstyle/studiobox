import { assertEquals, assertRejects } from "@std/assert";
import type {
  CommandRunner,
  EgressCommandResult,
} from "../../../../src/rootd/network/apply.ts";
import { subnetForSlot } from "../../../../src/rootd/network/allocator.ts";
import {
  DnsmasqController,
  DnsmasqError,
  type FileReader,
  type FileRemover,
  type FileWriter,
  type ProcessSignaller,
} from "../../../../src/rootd/network/dnsmasq.ts";

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

class FakeWriter implements FileWriter {
  readonly writes: { path: string; contents: string }[] = [];
  write(path: string, contents: string): Promise<void> {
    this.writes.push({ path, contents });
    return Promise.resolve();
  }
}

class FakeReader implements FileReader {
  constructor(private readonly byPath: Record<string, string | Error>) {}
  read(path: string): Promise<string> {
    const value = this.byPath[path];
    if (value === undefined || value instanceof Error) {
      return Promise.reject(value ?? new Deno.errors.NotFound(path));
    }
    return Promise.resolve(value);
  }
}

class FakeRemover implements FileRemover {
  readonly removes: string[] = [];
  constructor(private readonly failing: Set<string> = new Set()) {}
  remove(path: string): Promise<void> {
    this.removes.push(path);
    if (this.failing.has(path)) {
      return Promise.reject(new Deno.errors.NotFound(path));
    }
    return Promise.resolve();
  }
}

class FakeSignaller implements ProcessSignaller {
  readonly calls: { pid: number; signal: string }[] = [];
  signal(pid: number, signal: string): void {
    this.calls.push({ pid, signal });
  }
}

const FRAGMENT =
  "stop-dns-rebind\nnftset=/example.com/4#inet#sbx_eg_sbxa#wild4_0,6#inet#sbx_eg_sbxa#wild6_0\n";

Deno.test("install writes the conf-file and spawns dnsmasq with the exact argv", async () => {
  const runner = new FakeRunner();
  const writer = new FakeWriter();
  const controller = new DnsmasqController({ runner, writer });
  const instance = await controller.install(subnetForSlot(0), {
    fragment: FRAGMENT,
    upstream: "1.1.1.1",
  });

  // The conf-file contents are exactly the rendered fragment, byte-for-byte.
  assertEquals(writer.writes, [
    { path: "/run/studiobox/dns/0.conf", contents: FRAGMENT },
  ]);
  assertEquals(runner.calls.length, 1);
  assertEquals(runner.calls[0].bin, "dnsmasq");
  assertEquals(runner.calls[0].stdin, "");
  assertEquals(runner.calls[0].args, [
    "--keep-in-foreground=false",
    "--pid-file=/run/studiobox/dns/0.pid",
    "--listen-address=10.201.0.1",
    "--bind-interfaces",
    "--interface=sbxtap0",
    "--except-interface=lo",
    "--no-resolv",
    "--server=1.1.1.1",
    "--conf-file=/run/studiobox/dns/0.conf",
  ]);
  assertEquals(instance, {
    pidfile: "/run/studiobox/dns/0.pid",
    confFile: "/run/studiobox/dns/0.conf",
  });
});

Deno.test("install with an empty fragment writes no conf-file and passes no --conf-file", async () => {
  const runner = new FakeRunner();
  const writer = new FakeWriter();
  const controller = new DnsmasqController({ runner, writer });
  const instance = await controller.install(subnetForSlot(64), {
    fragment: "",
    upstream: "9.9.9.9",
  });

  assertEquals(writer.writes, []);
  assertEquals(runner.calls[0].args, [
    "--keep-in-foreground=false",
    "--pid-file=/run/studiobox/dns/64.pid",
    "--listen-address=10.201.1.1",
    "--bind-interfaces",
    "--interface=sbxtap64",
    "--except-interface=lo",
    "--no-resolv",
    "--server=9.9.9.9",
  ]);
  assertEquals(instance, { pidfile: "/run/studiobox/dns/64.pid" });
});

Deno.test("install surfaces a spawn failure as DnsmasqError", async () => {
  const runner = new FakeRunner([
    { success: false, code: 1, stderr: "failed to bind" },
  ]);
  const controller = new DnsmasqController({
    runner,
    writer: new FakeWriter(),
  });
  await assertRejects(
    () =>
      controller.install(subnetForSlot(0), {
        fragment: "",
        upstream: "1.1.1.1",
      }),
    DnsmasqError,
  );
});

Deno.test("reap SIGKILLs the pid from the pidfile then unlinks pid + conf", async () => {
  const reader = new FakeReader({ "/run/studiobox/dns/0.pid": "4242\n" });
  const remover = new FakeRemover();
  const signaller = new FakeSignaller();
  const controller = new DnsmasqController({ reader, remover, signaller });

  await controller.reap("/run/studiobox/dns/0.pid");

  assertEquals(signaller.calls, [{ pid: 4242, signal: "SIGKILL" }]);
  // Both the pidfile and its sibling conf-file are unlinked, in that order.
  assertEquals(remover.removes, [
    "/run/studiobox/dns/0.pid",
    "/run/studiobox/dns/0.conf",
  ]);
});

Deno.test("reap is gone-tolerant when the pidfile is already absent", async () => {
  const reader = new FakeReader({}); // read rejects with NotFound
  const remover = new FakeRemover(
    new Set(["/run/studiobox/dns/0.pid", "/run/studiobox/dns/0.conf"]),
  );
  const signaller = new FakeSignaller();
  const controller = new DnsmasqController({ reader, remover, signaller });

  await controller.reap("/run/studiobox/dns/0.pid"); // must not throw

  // No pid to signal, but the unlinks are still attempted (and tolerated).
  assertEquals(signaller.calls, []);
  assertEquals(remover.removes, [
    "/run/studiobox/dns/0.pid",
    "/run/studiobox/dns/0.conf",
  ]);
});

Deno.test("reap tolerates a signaller that throws (process already dead)", async () => {
  const reader = new FakeReader({ "/run/studiobox/dns/0.pid": "77" });
  const remover = new FakeRemover();
  const throwingSignaller: ProcessSignaller = {
    signal() {
      throw new Deno.errors.NotFound("no such process");
    },
  };
  const controller = new DnsmasqController({
    reader,
    remover,
    signaller: throwingSignaller,
  });
  await controller.reap("/run/studiobox/dns/0.pid"); // must not throw
  assertEquals(remover.removes.length, 2);
});
