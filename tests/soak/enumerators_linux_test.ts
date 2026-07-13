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
  dnsmasqEnumerator,
  EGRESS_TABLE_PREFIX,
  mountEnumerator,
  netnsEnumerator,
  nftablesEnumerator,
  parseDnsmasqSlots,
  parseIpLinkNames,
  parseMountPoints,
  parseNetnsNames,
  parseNftInetTables,
  parseNftTables,
  PORT_FORWARD_TABLE_PREFIX,
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

Deno.test("PORT_FORWARD_TABLE_PREFIX tracks the port-forward engine", () => {
  assertEquals(PORT_FORWARD_TABLE_PREFIX, "sbx_pf_");
});

Deno.test("nftablesEnumerator returns owned egress (inet) + port-forward (ip), family-qualified", async () => {
  const runner = runnerFor({
    "nft -j list tables": ok(JSON.stringify({
      nftables: [
        { metainfo: { version: "1.0" } },
        // Owned per-sandbox tables: the inet egress seal + the ip forward table.
        { table: { family: "inet", name: "sbx_eg_616263" } },
        { table: { family: "ip", name: "sbx_pf_616263" } },
        // The shared, persistent masquerade table is NOT a per-sandbox leak.
        { table: { family: "ip", name: "studiobox_nat" } },
        // An unrelated table on the box.
        { table: { family: "inet", name: "filter" } },
      ],
    })),
  });
  // Sorted, family-qualified: `inet:` sorts before `ip:`.
  assertEquals(await nftablesEnumerator({ runner }).enumerate(), [
    "inet:sbx_eg_616263",
    "ip:sbx_pf_616263",
  ]);
});

Deno.test("parseNftTables reads both families; parseNftInetTables keeps inet only", () => {
  const json = JSON.stringify({
    nftables: [
      { metainfo: { version: "1.0" } },
      { table: { family: "inet", name: "sbx_eg_1" } },
      { table: { family: "ip", name: "sbx_pf_1" } },
    ],
  });
  assertEquals(parseNftTables(json), [
    { family: "inet", name: "sbx_eg_1" },
    { family: "ip", name: "sbx_pf_1" },
  ]);
  assertEquals(parseNftInetTables(json), ["sbx_eg_1"]);
});

Deno.test("parseNftTables / parseNftInetTables handle empty / missing keys", () => {
  assertEquals(parseNftTables(""), []);
  assertEquals(parseNftTables(JSON.stringify({})), []);
  assertEquals(parseNftInetTables(""), []);
  assertEquals(parseNftInetTables(JSON.stringify({})), []);
  assertEquals(parseNftInetTables(JSON.stringify({ nftables: [] })), []);
});

Deno.test("dnsmasqEnumerator returns only studiobox dns-run-dir instances", async () => {
  const runner = runnerFor({
    "pgrep -a dnsmasq": ok(
      [
        // A studiobox per-sandbox dnsmasq: its pidfile names the dns run dir.
        "1234 dnsmasq --pid-file=/run/studiobox/dns/7.pid --listen-address=10.201.0.1 --bind-interfaces --interface=sbxtap7 --server=1.1.1.1",
        // An unrelated host dnsmasq: no studiobox run-dir pidfile → ignored.
        "5678 /usr/sbin/dnsmasq --conf-file=/etc/dnsmasq.conf",
      ].join("\n") + "\n",
    ),
  });
  assertEquals(await dnsmasqEnumerator({ runner }).enumerate(), ["dns:7"]);
});

Deno.test("dnsmasqEnumerator treats an empty pgrep (exit 1) as no instances", async () => {
  const runner: SoakCommandRunner = {
    run: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
  };
  assertEquals(await dnsmasqEnumerator({ runner }).enumerate(), []);
});

Deno.test("parseDnsmasqSlots parses the slot from --pid-file, custom run dir", () => {
  assertEquals(
    parseDnsmasqSlots(
      "42 dnsmasq --pid-file=/run/studiobox/dns/3.pid --server=1.1.1.1\n",
    ),
    ["dns:3"],
  );
  // A custom run dir + a line that does not name it.
  assertEquals(
    parseDnsmasqSlots(
      [
        "10 dnsmasq --pid-file=/var/run/sbx/dns/12.pid --server=8.8.8.8",
        "11 dnsmasq --pid-file=/somewhere/else/9.pid",
      ].join("\n"),
      "/var/run/sbx/dns",
    ),
    ["dns:12"],
  );
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

Deno.test("procCmdlineOrphanEnumerator keys VMMs by jail exec-id, ignoring substring matches", async () => {
  const proc = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-proc-" });
  try {
    // pid 123: a jailed firecracker VMM; pid 789: the jailer for the SAME
    // execution (jailer exec's into firecracker) — both key to exec:x0-0 and
    // dedup to one identity.
    await writeCmdline(proc, 123, [
      "/firecracker",
      "--id",
      "x0-0",
      "--api-sock",
      "/fc.sock",
    ]);
    await writeCmdline(proc, 789, [
      "/usr/local/bin/jailer",
      "--id",
      "x0-0",
      "--exec-file",
      "firecracker",
    ]);
    // pid 456: the soak runner — its cmdline CONTAINS "firecracker" (an env var
    // passed as an `env VAR=val` argv element), but argv0 is `sudo`, NOT a VMM
    // binary, so it must NOT be flagged (the old substring match did).
    await writeCmdline(proc, 456, [
      "sudo",
      "-E",
      "env",
      "SBX_VM_FIRECRACKER_BIN=/usr/local/bin/firecracker",
      "deno",
      "run",
    ]);
    // pid 999: an unrelated shell.
    await writeCmdline(proc, 999, ["/bin/bash", "-c", "sleep 1"]);
    // A non-numeric dir must be ignored.
    await Deno.mkdir(join(proc, "self"), { recursive: true });

    const found = await procCmdlineOrphanEnumerator({
      procRoot: proc,
      ownedBinaries: () => ["firecracker", "jailer"],
    }).enumerate();
    assertEquals(found, ["exec:x0-0"]);

    // No owned binaries → nothing is studiobox-owned.
    const none = await procCmdlineOrphanEnumerator({
      procRoot: proc,
      ownedBinaries: () => [],
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
