/**
 * The Linux / in-guest enumerators (PLAN.md §M11): their parsers are exercised
 * host-safe against captured `ip` / `nft` / `/proc` fixtures via the injected
 * {@linkcode SoakCommandRunner} + temp proc/mounts paths — no Linux, no root,
 * no host mutation. These are the enumerators the deferred `soak:vm` runs.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";

import {
  EGRESS_TABLE_PREFIX,
  mountEnumerator,
  netnsEnumerator,
  nftablesEnumerator,
  parseIpLinkNames,
  parseMountPoints,
  parseNetnsNames,
  parseNftInetTables,
  procCmdlineOrphanEnumerator,
  type SoakCommandResult,
  type SoakCommandRunner,
  tapEnumerator,
} from "../../tools/soak/enumerators_linux.ts";

function runnerFor(
  map: Record<string, SoakCommandResult>,
): SoakCommandRunner {
  return {
    run: (bin, args) =>
      Promise.resolve(
        map[`${bin} ${args.join(" ")}`] ??
          { code: 127, stdout: "", stderr: "command not found" },
      ),
  };
}

function ok(stdout: string): SoakCommandResult {
  return { code: 0, stdout, stderr: "" };
}

Deno.test("EGRESS_TABLE_PREFIX tracks the egress engine", () => {
  assertEquals(EGRESS_TABLE_PREFIX, "sbx_eg_");
});

Deno.test("tapEnumerator returns only owned-prefix TAP interfaces", async () => {
  const runner = runnerFor({
    "ip -j link show": ok(JSON.stringify([
      { ifindex: 1, ifname: "lo" },
      { ifindex: 2, ifname: "eth0" },
      { ifindex: 7, ifname: "sbx-tap-a" },
      { ifindex: 8, ifname: "sbx-tap-b" },
    ])),
  });
  const found = await tapEnumerator({ runner, ownedPrefix: "sbx-tap" })
    .enumerate();
  assertEquals(found, ["sbx-tap-a", "sbx-tap-b"]);
});

Deno.test("parseIpLinkNames tolerates empty output", () => {
  assertEquals(parseIpLinkNames(""), []);
  assertEquals(parseIpLinkNames("[]"), []);
});

Deno.test("netnsEnumerator parses both JSON and plain formats", async () => {
  const jsonRunner = runnerFor({
    "ip -j netns list": ok(JSON.stringify([
      { name: "sbx-ns-1" },
      { name: "sbx-ns-2" },
      { name: "docker" },
    ])),
  });
  assertEquals(
    await netnsEnumerator({ runner: jsonRunner, ownedPrefix: "sbx-ns" })
      .enumerate(),
    ["sbx-ns-1", "sbx-ns-2"],
  );

  // Plain `name (id: N)` lines.
  assertEquals(
    parseNetnsNames("sbx-ns-1 (id: 0)\nother (id: 1)\n"),
    ["sbx-ns-1", "other"],
  );
});

Deno.test("nftablesEnumerator returns only inet egress tables with the prefix", async () => {
  const runner = runnerFor({
    "nft -j list tables": ok(JSON.stringify({
      nftables: [
        { metainfo: { version: "1.0" } },
        { table: { family: "inet", name: "sbx_eg_616263" } },
        { table: { family: "inet", name: "filter" } },
        { table: { family: "ip", name: "sbx_eg_notinet" } },
      ],
    })),
  });
  assertEquals(await nftablesEnumerator({ runner }).enumerate(), [
    "sbx_eg_616263",
  ]);
});

Deno.test("parseNftInetTables handles empty / missing keys", () => {
  assertEquals(parseNftInetTables(""), []);
  assertEquals(parseNftInetTables(JSON.stringify({})), []);
  assertEquals(parseNftInetTables(JSON.stringify({ nftables: [] })), []);
});

Deno.test("mountEnumerator returns jail-scoped mount points, unescaped", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-mnt-" });
  try {
    const mountsPath = join(dir, "mounts");
    const scope = "/srv/jail";
    await Deno.writeTextFile(
      mountsPath,
      [
        "proc /proc proc rw 0 0",
        "overlay /srv/jail/e1/root overlay rw 0 0",
        // A space in the path is octal-escaped as \040.
        "tmpfs /srv/jail/e2/with\\040space tmpfs rw 0 0",
        "sysfs /sys sysfs rw 0 0",
      ].join("\n") + "\n",
    );
    const found = await mountEnumerator({ mountsPath, scopePrefix: scope })
      .enumerate();
    assertEquals(found, [
      "/srv/jail/e1/root",
      "/srv/jail/e2/with space",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("parseMountPoints ignores the scope base itself when not present", () => {
  const points = parseMountPoints("a /x/y ext4 rw 0 0\nb /z ext4 rw 0 0\n");
  assertEquals(points, ["/x/y", "/z"]);
});

Deno.test("procCmdlineOrphanEnumerator finds pids whose cmdline matches an identity token", async () => {
  const proc = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-proc-" });
  try {
    // pid 123: a jailed firecracker VMM (--id x0-0). pid 456: an unrelated
    // shell. pid 789: the jailer for the same execution.
    await writeCmdline(proc, 123, ["firecracker", "--id", "x0-0"]);
    await writeCmdline(proc, 456, ["/bin/bash", "-c", "sleep 1"]);
    await writeCmdline(proc, 789, ["jailer", "--id", "x0-0", "--exec-file"]);
    // A non-numeric dir must be ignored.
    await Deno.mkdir(join(proc, "self"), { recursive: true });

    const found = await procCmdlineOrphanEnumerator({
      procRoot: proc,
      identityTokens: () => ["firecracker", "jailer"],
    }).enumerate();
    assertEquals(found, ["pid=123", "pid=789"]);

    // No tokens → nothing is studiobox-owned.
    const none = await procCmdlineOrphanEnumerator({
      procRoot: proc,
      identityTokens: () => [],
    }).enumerate();
    assertEquals(none, []);
  } finally {
    await Deno.remove(proc, { recursive: true }).catch(() => {});
  }
});

async function writeCmdline(
  procRoot: string,
  pid: number,
  argv: readonly string[],
): Promise<void> {
  const dir = join(procRoot, String(pid));
  await Deno.mkdir(dir, { recursive: true });
  // /proc/<pid>/cmdline is NUL-separated, NUL-terminated.
  await Deno.writeFile(
    join(dir, "cmdline"),
    new TextEncoder().encode(argv.join("\0") + "\0"),
  );
}
