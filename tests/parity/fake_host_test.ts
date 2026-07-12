/**
 * The parity fixture suite, run against {@linkcode FakeSandboxHost} —
 * the M3 exit criterion. M5 reruns `suite.ts` against real in-VM
 * sandboxes and M8 against the full macOS-tunnel SDK by registering
 * their own backends; this file must stay a thin binding.
 */

import { FakeSandboxHost } from "../../testing/mod.ts";
import { runParitySuite } from "./suite.ts";

// One host for the whole file: each fixture creates (and closes) its
// own sandbox; the provider seam stays installed so `Sandbox.connect`
// resolves against this host.
const host = FakeSandboxHost.install();

runParitySuite({
  label: "fake",
  create: (options) => host.create(options),
  supportsConnect: true,
});
