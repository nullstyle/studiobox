import { assertEquals } from "@std/assert";
import { publishReadinessFailures } from "../../../tools/check_publish.ts";

const readyConfig = {
  name: "@nullstyle/studiobox",
  version: "1.0.0",
  exports: { ".": "./mod.ts" },
  imports: {
    "@nullstyle/lima": "jsr:@nullstyle/lima@^0.1",
    "@nullstyle/lima/testing": "jsr:@nullstyle/lima@^0.1/testing",
    "@nullstyle/capnp": "jsr:@nullstyle/capnp@^0.1",
    "@nullstyle/capnp/rpc": "jsr:@nullstyle/capnp@^0.1/rpc",
    "@nullstyle/firecracker": "jsr:@nullstyle/firecracker@^0.2",
    "@nullstyle/firecracker/vsock": "jsr:@nullstyle/firecracker@^0.2/vsock",
  },
  publish: {
    include: [
      "mod.ts",
      "src/**",
      "schema/**",
      "compat/**",
      "README.md",
      "LICENSE",
      "deno.json",
    ],
  },
};

const readyManifest = {
  lima: {
    package: "@nullstyle/lima",
    version: "0.1.0",
    releaseSpecifier: "jsr:@nullstyle/lima@^0.1",
  },
  capnp: {
    package: "@nullstyle/capnp",
    version: "0.1.0",
    releaseSpecifier: "jsr:@nullstyle/capnp@^0.1",
  },
  firecracker: {
    package: "@nullstyle/firecracker",
    version: "0.2.0",
    releaseSpecifier: "jsr:@nullstyle/firecracker@^0.2",
  },
};

Deno.test("publish guard accepts published foundation packages", () => {
  assertEquals(publishReadinessFailures(readyConfig, readyManifest), []);
});

Deno.test("publish guard rejects placeholders and development-only sources", () => {
  const failures = publishReadinessFailures(
    {
      ...readyConfig,
      version: "0.0.0",
      imports: {
        "@nullstyle/capnp": "./vendor/capnp-deno/src/mod.ts",
        "@nullstyle/firecracker":
          "https://raw.githubusercontent.com/nullstyle/firecracker-deno/commit/mod.ts",
      },
    },
    {
      ...readyManifest,
      capnp: { ...readyManifest.capnp, releaseSpecifier: null },
      firecracker: { ...readyManifest.firecracker, releaseSpecifier: null },
    },
  );
  assertEquals(failures.includes("package version is still 0.0.0"), true);
  assertEquals(
    failures.some((failure) => failure.includes("development-only")),
    true,
  );
  assertEquals(
    failures.some((failure) => failure.includes("release must be")),
    true,
  );
});

Deno.test("publish guard rejects a window that excludes the qualified version", () => {
  const failures = publishReadinessFailures(readyConfig, {
    ...readyManifest,
    firecracker: {
      ...readyManifest.firecracker,
      releaseSpecifier: "jsr:@nullstyle/firecracker@^0.1",
    },
  });
  assertEquals(
    failures.some(
      (failure) =>
        failure.includes("release must be a window admitting") ||
        failure.includes("must resolve to"),
    ),
    true,
  );
});
