// The Sandbox provider seam (src/api/provider.ts): explicit installs win over
// the lazy env-wired default; the default is built once and memoized; a failed
// build is not cached; and an unresolved provider surfaces an actionable
// ProviderNotInstalledError (NOT the feature-stub ImplementationPendingError).
// This is what makes `import { Sandbox } from "@nullstyle/studiobox"` a true
// drop-in once a host is up while never clobbering a test's FakeSandboxHost.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import {
  getSandboxProvider,
  installSandboxProvider,
  registerDefaultSandboxProvider,
  resolveSandboxProvider,
  type SandboxProvider,
} from "../../../src/api/provider.ts";
import { ProviderNotInstalledError } from "../../../src/api/errors.ts";

/** A distinguishable no-op provider (create/connect/list are never called). */
function fakeProvider(tag: string): SandboxProvider {
  return {
    // deno-lint-ignore no-explicit-any
    create: () => Promise.reject(new Error(`unused:${tag}`)) as any,
    // deno-lint-ignore no-explicit-any
    connect: () => Promise.reject(new Error(`unused:${tag}`)) as any,
    list: () => Promise.resolve([]),
  };
}

Deno.test("resolveSandboxProvider: an explicitly installed provider beats the lazy default", async () => {
  const fallback = fakeProvider("fallback");
  const installed = fakeProvider("installed");
  const unregister = registerDefaultSandboxProvider(() =>
    Promise.resolve(fallback)
  );
  const restore = installSandboxProvider(installed);
  try {
    assertEquals(await resolveSandboxProvider(), installed);
  } finally {
    restore();
    unregister();
  }
});

Deno.test("resolveSandboxProvider: auto-wires from the default loader when nothing is installed, and builds it exactly once", async () => {
  const provider = fakeProvider("env");
  let builds = 0;
  const unregister = registerDefaultSandboxProvider(() => {
    builds++;
    return Promise.resolve(provider);
  });
  try {
    assertEquals(await resolveSandboxProvider(), provider);
    assertEquals(await resolveSandboxProvider(), provider);
    assertEquals(builds, 1, "the default build is memoized");
  } finally {
    unregister();
  }
});

Deno.test("resolveSandboxProvider: a later explicit install still wins after the default built", async () => {
  const fallback = fakeProvider("fallback");
  const unregister = registerDefaultSandboxProvider(() =>
    Promise.resolve(fallback)
  );
  try {
    assertEquals(await resolveSandboxProvider(), fallback);
    const installed = fakeProvider("installed");
    const restore = installSandboxProvider(installed);
    try {
      assertEquals(await resolveSandboxProvider(), installed);
    } finally {
      restore();
    }
  } finally {
    unregister();
  }
});

Deno.test("resolveSandboxProvider: a failed default build is not cached — a later call retries", async () => {
  const provider = fakeProvider("env");
  let attempt = 0;
  const unregister = registerDefaultSandboxProvider(() => {
    attempt++;
    return attempt === 1
      ? Promise.reject(new Error("STUDIOBOX_HOST is required"))
      : Promise.resolve(provider);
  });
  try {
    await assertRejects(
      () => resolveSandboxProvider(),
      Error,
      "STUDIOBOX_HOST",
    );
    // The rejection was not memoized: the second call rebuilds and succeeds.
    assertEquals(await resolveSandboxProvider(), provider);
    assertEquals(attempt, 2);
  } finally {
    unregister();
  }
});

Deno.test("registerDefaultSandboxProvider: unregister restores the previously registered loader", async () => {
  const first = fakeProvider("first");
  const second = fakeProvider("second");
  const unregisterFirst = registerDefaultSandboxProvider(() =>
    Promise.resolve(first)
  );
  try {
    const unregisterSecond = registerDefaultSandboxProvider(() =>
      Promise.resolve(second)
    );
    assertEquals(await resolveSandboxProvider(), second);
    unregisterSecond();
    assertEquals(await resolveSandboxProvider(), first);
  } finally {
    unregisterFirst();
  }
});

Deno.test("getSandboxProvider: throws an actionable ProviderNotInstalledError (not ImplementationPendingError) when nothing is installed", () => {
  const error = assertThrows(
    () => getSandboxProvider(),
    ProviderNotInstalledError,
  );
  assert(error instanceof ProviderNotInstalledError);
  // The message points the caller at the actual next steps.
  assert(error.message.includes("host up"), "mentions `host up`");
  assert(
    error.message.includes("installStudiobox"),
    "mentions installStudiobox",
  );
  assert(
    error.message.includes("FakeSandboxHost"),
    "mentions the test fake",
  );
});

Deno.test("ProviderNotInstalledError: preserves an underlying cause", () => {
  const cause = new Error("STUDIOBOX_HOST is required");
  const error = new ProviderNotInstalledError(cause);
  assertEquals(error.cause, cause);
  assert(error.message.includes("STUDIOBOX_HOST is required"));
});
