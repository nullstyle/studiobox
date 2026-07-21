import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  DEFAULT_PORTS,
  hostVmName,
  renderLimaTemplate,
} from "../../../src/cli/host_template.ts";

Deno.test("renderLimaTemplate: sets vmType vz + nested virtualization", () => {
  const yaml = renderLimaTemplate();
  assertStringIncludes(yaml, "vmType: vz");
  assertStringIncludes(yaml, "nestedVirtualization: true");
});

Deno.test("renderLimaTemplate: no host mounts", () => {
  assertStringIncludes(renderLimaTemplate(), "mounts: []");
});

Deno.test("renderLimaTemplate: containerd disabled (not a container host)", () => {
  const yaml = renderLimaTemplate();
  assertStringIncludes(yaml, "containerd:");
  assertStringIncludes(yaml, "system: false");
  assertStringIncludes(yaml, "user: false");
});

Deno.test("renderLimaTemplate: the three static loopback port forwards", () => {
  const yaml = renderLimaTemplate();
  // control 40000
  assertStringIncludes(yaml, "guestPort: 40000");
  assertStringIncludes(yaml, "hostPort: 40000");
  // tunnel 40001
  assertStringIncludes(yaml, "guestPort: 40001");
  assertStringIncludes(yaml, "hostPort: 40001");
  // expose range 40100-40199
  assertStringIncludes(yaml, "guestPortRange: [40100, 40199]");
  assertStringIncludes(yaml, "hostPortRange: [40100, 40199]");
  // every forward binds the host loopback only
  const forwards = yaml.slice(yaml.indexOf("portForwards:"));
  assertEquals(
    forwards.match(/hostIP: "127\.0\.0\.1"/g)?.length,
    3,
    "all three forwards bind 127.0.0.1",
  );
});

Deno.test("renderLimaTemplate: honors custom ports", () => {
  const yaml = renderLimaTemplate({
    ports: { control: 50000, tunnel: 50001, exposeRange: [50100, 50199] },
  });
  assertStringIncludes(yaml, "guestPort: 50000");
  assertStringIncludes(yaml, "guestPort: 50001");
  assertStringIncludes(yaml, "guestPortRange: [50100, 50199]");
});

Deno.test("DEFAULT_PORTS match DESIGN.md §11 (40000/40001/40100-40199)", () => {
  assertEquals(DEFAULT_PORTS.control, 40000);
  assertEquals(DEFAULT_PORTS.tunnel, 40001);
  assertEquals(DEFAULT_PORTS.exposeRange, [40100, 40199]);
});

Deno.test("hostVmName: studiobox-host-<arch>", () => {
  assertEquals(hostVmName("aarch64"), "studiobox-host-aarch64");
  assertEquals(hostVmName("x86_64"), "studiobox-host-x86_64");
});

Deno.test("committed tools/lima/studiobox-host.yaml == generator output", async () => {
  const committedPath = fromFileUrl(
    import.meta.resolve("../../../tools/lima/studiobox-host.yaml"),
  );
  const committed = await Deno.readTextFile(committedPath);
  assertEquals(
    committed,
    renderLimaTemplate(),
    "the committed Lima template drifted from renderLimaTemplate(); " +
      "regenerate with `deno run --allow-write=tools/lima tools/lima_template_write.ts`",
  );
  // Sanity: the committed file is composed from the Ubuntu base template.
  assert(committed.includes("base: template://ubuntu-24.04"));
});
