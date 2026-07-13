import { assert, assertEquals, assertRejects } from "@std/assert";
import { HostLifecycle } from "../../../src/cli/host_lifecycle.ts";
import {
  HOSTD_TOKEN,
  PROVISION_STEP_ORDER,
  renderSystemdUnits,
  ROOTD_TOKEN,
  WIRE_JSON,
} from "../../../src/cli/provision.ts";
import { DEFAULT_PORTS } from "../../../src/cli/lima_template.ts";
import {
  FakeHostRunner,
  FakeLocalFs,
  sequentialTokenFactory,
} from "./cli_test_helpers.ts";

const HOME = "/home/tester";
const HOST_TOKEN = `${HOME}/.studiobox/token`;
const HOSTD_SRC = "/host/.build/studiobox-hostd";
const ROOTD_SRC = "/host/.build/studiobox-rootd";
const COMPAT_SRC = "/host/compat/wire.json";

interface Fixture {
  readonly runner: FakeHostRunner;
  readonly fs: FakeLocalFs;
  readonly lifecycle: HostLifecycle;
}

function makeFixture(
  overrides: Partial<{ mode: "lima" | "no-lima"; daemonsPresent: boolean }> =
    {},
): Fixture {
  const runner = new FakeHostRunner();
  const fs = new FakeLocalFs();
  if (overrides.daemonsPresent !== false) {
    fs.files.add(HOSTD_SRC);
    fs.files.add(ROOTD_SRC);
  }
  const lifecycle = new HostLifecycle({
    runner,
    fs,
    mode: overrides.mode ?? "lima",
    arch: "aarch64",
    homeDir: HOME,
    hostdBinarySource: HOSTD_SRC,
    rootdBinarySource: ROOTD_SRC,
    compatSource: COMPAT_SRC,
    tokenFactory: sequentialTokenFactory(),
    writeTemplate: () => Promise.resolve("/tmp/fake-template.yaml"),
  });
  return { runner, fs, lifecycle };
}

Deno.test("HostLifecycle.up (fresh): creates the VM, checks kvm, provisions", async () => {
  const { runner, fs, lifecycle } = makeFixture();
  const result = await lifecycle.up();

  assertEquals(result.created, true);
  assertEquals(result.kvmPresent, true);

  const lines = runner.commandLines();
  const createIdx = lines.findIndex((l) =>
    l.includes("start --name=studiobox-host-aarch64")
  );
  const kvmIdx = lines.findIndex((l) => l.includes("test -e /dev/kvm"));
  // The token now lands via a `sudo install … <dest>` (staged off the wire),
  // not a colon-prefixed `<vm>:<dest>` cp — detect the install to HOSTD_TOKEN.
  const tokenCpIdx = lines.findIndex((l) =>
    l.includes("install") && l.includes(HOSTD_TOKEN)
  );
  assert(createIdx >= 0, "createVm was issued");
  assert(kvmIdx > createIdx, "kvm check follows create");
  assert(tokenCpIdx > kvmIdx, "token install follows the kvm check");

  // Provision ran every step in the canonical order.
  assertEquals(
    result.provision.steps.map((s) => s.name),
    [...PROVISION_STEP_ORDER],
  );
  assertEquals(result.provision.tokenRotated, true);
  assertEquals(result.provision.installedDaemons, ["hostd", "rootd"]);

  // Guest received the tokens, the compat pin; the host got its SDK token.
  assert(runner.guestFiles.has(HOSTD_TOKEN));
  assert(runner.guestFiles.has(ROOTD_TOKEN));
  assert(runner.guestFiles.has(WIRE_JSON));
  assert(fs.files.has(HOST_TOKEN), "SDK token written on the host");

  // The instance now exists and is running.
  assert(runner.instances.has("studiobox-host-aarch64"));
  assert(runner.running.has("studiobox-host-aarch64"));
});

Deno.test("HostLifecycle.up (re-run): reuses the VM and does NOT rotate the token", async () => {
  const { runner, lifecycle } = makeFixture();
  await lifecycle.up();
  const boundary = runner.calls.length;

  const second = await lifecycle.up();
  const secondLines = runner.commandLines().slice(boundary);

  // No fresh create; a plain `start <name>` reuse instead.
  assert(
    !secondLines.some((l) => l.includes("start --name=")),
    "re-run must not recreate the VM",
  );
  assert(
    secondLines.some((l) => l === "limactl start studiobox-host-aarch64"),
    "re-run starts the existing instance",
  );

  // Token step skipped: no new token install on the second run. (The binaries
  // step still re-installs wire.json + the daemon binaries, so key off an
  // install of the TOKEN specifically, not any install.)
  assertEquals(second.provision.tokenRotated, false);
  assert(
    !secondLines.some((l) => l.includes("install") && l.includes(HOSTD_TOKEN)),
    "re-run must not re-install the token",
  );
  const tokenStep = second.provision.steps.find((s) => s.name === "token");
  assertEquals(tokenStep?.status, "skipped");
});

Deno.test("HostLifecycle.up --rotate-token re-mints even when present", async () => {
  const { runner, lifecycle } = makeFixture();
  await lifecycle.up();
  const boundary = runner.calls.length;

  const second = await lifecycle.up({ rotateToken: true });
  assertEquals(second.provision.tokenRotated, true);
  const secondLines = runner.commandLines().slice(boundary);
  assert(
    secondLines.some((l) => l.includes("install") && l.includes(HOSTD_TOKEN)),
    "rotate re-installs the token",
  );
});

Deno.test("HostLifecycle.up --recreate deletes the existing VM first", async () => {
  const { runner, lifecycle } = makeFixture();
  await lifecycle.up();
  const boundary = runner.calls.length;

  await lifecycle.up({ recreate: true });
  const secondLines = runner.commandLines().slice(boundary);
  const deleteIdx = secondLines.findIndex((l) =>
    l === "limactl delete -f studiobox-host-aarch64"
  );
  const createIdx = secondLines.findIndex((l) =>
    l.includes("start --name=studiobox-host-aarch64")
  );
  assert(deleteIdx >= 0, "recreate deletes the instance");
  assert(createIdx > deleteIdx, "recreate then creates fresh");
});

Deno.test("HostLifecycle.up: a missing /dev/kvm fails loudly", async () => {
  const { runner, lifecycle } = makeFixture();
  runner.kvm = false;
  await assertRejects(() => lifecycle.up(), Error, "/dev/kvm missing");
});

Deno.test("HostLifecycle.up: a missing daemon binary is a warning, not a failure", async () => {
  const { lifecycle } = makeFixture({ daemonsPresent: false });
  const result = await lifecycle.up();
  assertEquals(result.provision.installedDaemons, []);
  assert(
    result.provision.warnings.some((w) => w.includes("hostd binary not found")),
  );
  // systemd step written but not enabled.
  const systemd = result.provision.steps.find((s) => s.name === "systemd");
  assertEquals(systemd?.status, "skipped");
});

Deno.test("HostLifecycle.down (lima): stops the running instance", async () => {
  const { runner, lifecycle } = makeFixture();
  await lifecycle.up();
  const boundary = runner.calls.length;
  await lifecycle.down();
  const lines = runner.commandLines().slice(boundary);
  assert(lines.some((l) => l === "limactl stop studiobox-host-aarch64"));
  assert(!runner.running.has("studiobox-host-aarch64"));
});

Deno.test("HostLifecycle.status: reports vm + daemon + token + ports", async () => {
  const { runner, lifecycle } = makeFixture();
  await lifecycle.up();
  runner.daemonActive.set("studiobox-hostd.service", "active");
  runner.daemonActive.set("studiobox-rootd.service", "active");

  const status = await lifecycle.status();
  assertEquals(status.mode, "lima");
  assertEquals(status.name, "studiobox-host-aarch64");
  assertEquals(status.arch, "aarch64");
  assertEquals(status.vmExists, true);
  assertEquals(status.vmRunning, true);
  assertEquals(status.daemons.hostd, "active");
  assertEquals(status.daemons.rootd, "active");
  assertEquals(status.tokenPresent, true);
  assertEquals(status.ports.control, DEFAULT_PORTS.control);
});

Deno.test("HostLifecycle.status: absent VM reports unknown daemons", async () => {
  const { lifecycle } = makeFixture();
  const status = await lifecycle.status();
  assertEquals(status.vmExists, false);
  assertEquals(status.vmRunning, false);
  assertEquals(status.daemons.hostd, "unknown");
  assertEquals(status.tokenPresent, false);
});

Deno.test("HostLifecycle.provision (--no-lima): no limactl, provisions locally", async () => {
  const { runner, fs, lifecycle } = makeFixture({ mode: "no-lima" });
  const result = await lifecycle.provision();

  assert(
    !runner.calls.some((c) => c.bin.endsWith("limactl")),
    "no-lima must never invoke limactl",
  );
  assertEquals(
    result.steps.map((s) => s.name),
    [...PROVISION_STEP_ORDER],
  );
  assertEquals(result.installedDaemons, ["hostd", "rootd"]);
  // Guest files land via `sudo install` locally.
  assert(runner.guestFiles.has(HOSTD_TOKEN));
  assert(fs.files.has(HOST_TOKEN));
});

Deno.test("HostLifecycle.down (--no-lima): stops the systemd units", async () => {
  const { runner, lifecycle } = makeFixture({ mode: "no-lima" });
  await lifecycle.down();
  assert(
    runner.calls.some((c) =>
      c.args.some((a) => a.includes("systemctl stop studiobox-hostd.service"))
    ),
  );
});

Deno.test("renderSystemdUnits: ExecStart matches the daemons' flag contracts", () => {
  const units = renderSystemdUnits(DEFAULT_PORTS);

  // rootd: --socket, --state, --token-file, --compat (its parser's required set).
  assert(units.rootd.includes("ExecStart=/usr/local/bin/studiobox-rootd"));
  assert(units.rootd.includes("--socket /run/studiobox/supervisor.sock"));
  assert(units.rootd.includes("--state /var/lib/studiobox/journal.json"));
  assert(units.rootd.includes(`--token-file ${ROOTD_TOKEN}`));
  assert(units.rootd.includes(`--compat ${WIRE_JSON}`));
  assert(units.rootd.includes("User=root"));

  // hostd: --listen, --rootd-socket, --token-file, --rootd-token-file, --compat.
  assert(units.hostd.includes("ExecStart=/usr/local/bin/studiobox-hostd"));
  assert(units.hostd.includes("--listen 0.0.0.0:40000"));
  assert(units.hostd.includes("--rootd-socket /run/studiobox/supervisor.sock"));
  assert(units.hostd.includes(`--token-file ${HOSTD_TOKEN}`));
  assert(units.hostd.includes(`--rootd-token-file ${ROOTD_TOKEN}`));
  // hostd is unprivileged and ordered after rootd (DESIGN.md §3).
  assert(units.hostd.includes("User=studiobox"));
  assert(units.hostd.includes("Requires=studiobox-rootd.service"));
});

Deno.test("provision: firecracker step installs the pinned version", async () => {
  const { runner, lifecycle } = makeFixture();
  await lifecycle.provision();
  // The pinned Firecracker version from FIRECRACKER_COMPAT rides in the script.
  assert(
    runner.calls.some((c) =>
      c.args.some((a) => a.includes("firecracker/releases/download/v1.16.1"))
    ),
    "provision installs the FIRECRACKER_COMPAT-pinned Firecracker",
  );
});
