/**
 * `runCli` — parse argv, dispatch a `host` subcommand through a
 * {@linkcode HostLifecycle}, format the result, and return a process exit code
 * (PLAN.md §M9).
 *
 * Output/side-effect seams (`stdout`, `stderr`, `lifecycleFactory`) are
 * injectable so a unit test drives dispatch + formatting with a fake lifecycle
 * and captures the lines, without a VM. Exit codes: `0` success, `1` a runtime
 * failure, `2` a usage error.
 *
 * @module
 */

import {
  type CliInvocation,
  CliUsageError,
  type HostFlags,
  parseCliArgs,
  USAGE,
} from "./args.ts";
import { DenoHostCommandRunner, type HostCommandRunner } from "./exec.ts";
import { HostLifecycle } from "./host_lifecycle.ts";
import { type DoctorReport, formatDoctorReport } from "./doctor.ts";
import type { HostStatus } from "./host_lifecycle.ts";
import type { ProvisionResult } from "./provision.ts";
// Read the package version straight from the manifest (embedded in the compiled
// CLI binary) so `studiobox --version` can never drift from the published one.
import denoJson from "../../deno.json" with { type: "json" };

/** The package version reported by `studiobox --version` (from deno.json). */
export const CLI_VERSION: string = denoJson.version;

/** Injectable dependencies for {@linkcode runCli}. */
export interface RunCliDeps {
  /** Subprocess seam. @default DenoHostCommandRunner */
  readonly runner?: HostCommandRunner;
  /** Normal output sink. @default console.log */
  readonly stdout?: (line: string) => void;
  /** Error output sink. @default console.error */
  readonly stderr?: (line: string) => void;
  /** Build the lifecycle from parsed flags (test seam). */
  readonly lifecycleFactory?: (flags: HostFlags) => HostLifecycle;
}

/** Parse + dispatch one CLI invocation; returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  deps: RunCliDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));

  let invocation: CliInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      err(error.message);
      err("");
      err(USAGE);
      return 2;
    }
    throw error;
  }

  if (invocation.kind === "help") {
    out(USAGE);
    return 0;
  }
  if (invocation.kind === "version") {
    out(CLI_VERSION);
    return 0;
  }

  const { sub, flags } = invocation;
  const lifecycle = (deps.lifecycleFactory ?? defaultLifecycleFactory(deps))(
    flags,
  );

  try {
    switch (sub) {
      case "up": {
        const result = await lifecycle.up({
          recreate: flags.recreate,
          rotateToken: flags.rotateToken,
        });
        formatProvision(result.provision, flags.json, out);
        if (result.provision.installedDaemons.length < 2) {
          out(
            "host up: NOTE — not all daemons were installed; " +
              "run `studiobox host provision` after compiling them.",
          );
        }
        // A requested bake that failed leaves a control-plane-only host — honest
        // nonzero exit even though the daemons are up (warning already printed).
        return bakeExitCode(result.provision, "host up", out);
      }
      case "provision": {
        const result = await lifecycle.provision(flags.rotateToken);
        formatProvision(result, flags.json, out);
        return bakeExitCode(result, "host provision", out);
      }
      case "down": {
        await lifecycle.down();
        out(`host down: ${lifecycle.name} (${lifecycle.mode})`);
        return 0;
      }
      case "status": {
        const status = await lifecycle.status();
        formatStatus(status, flags.json, out);
        return 0;
      }
      case "doctor": {
        const report = await lifecycle.doctor();
        formatDoctor(report, flags.json, out);
        return report.healthy ? 0 : 1;
      }
    }
  } catch (error) {
    err(
      `host ${sub} failed: ${error instanceof Error ? error.message : error}`,
    );
    return 1;
  }
}

function defaultLifecycleFactory(
  deps: RunCliDeps,
): (flags: HostFlags) => HostLifecycle {
  const runner = deps.runner ?? new DenoHostCommandRunner();
  const log = deps.stdout ?? ((line: string) => console.log(line));
  return (flags) =>
    new HostLifecycle({
      runner,
      mode: flags.noLima ? "no-lima" : "lima",
      log,
      ...(flags.arch === undefined ? {} : { arch: flags.arch }),
      ...(flags.name === undefined ? {} : { name: flags.name }),
      ...(flags.buildDir === undefined ? {} : { buildDir: flags.buildDir }),
      ...(flags.hostdBin === undefined
        ? {}
        : { hostdBinarySource: flags.hostdBin }),
      ...(flags.rootdBin === undefined
        ? {}
        : { rootdBinarySource: flags.rootdBin }),
      ...(flags.manifestHash === undefined
        ? {}
        : { launchConfig: { manifestHash: flags.manifestHash } }),
      // --bake resolves its source root via HostLifecycle's default
      // resolveSourceRoot (from-JSR → fails fast). Mutually exclusive with
      // --manifest-hash (enforced in parseCliArgs).
      ...(flags.bake ? { bake: flags.rebuild ? { rebuild: true } : {} } : {}),
      ...(flags.controlPort === undefined ? {} : {
        ports: {
          control: flags.controlPort,
          tunnel: flags.controlPort + 1,
          exposeRange: [flags.controlPort + 100, flags.controlPort + 199],
        },
      }),
    });
}

/**
 * Exit code for a provision-bearing subcommand: `1` when a requested bake
 * failed (the control plane is up but `Sandbox.create` is unavailable — an
 * honest CI signal), else `0`. The detailed failure warning is already in the
 * formatted output; add a one-line pointer.
 */
function bakeExitCode(
  result: ProvisionResult,
  command: string,
  out: (line: string) => void,
): number {
  if (result.bakeFailed) {
    out(
      `${command}: bake FAILED — Sandbox.create unavailable; re-run once the ` +
        `cause is fixed (see the warning above).`,
    );
    return 1;
  }
  return 0;
}

function formatProvision(
  result: ProvisionResult,
  json: boolean,
  out: (line: string) => void,
): void {
  if (json) {
    out(JSON.stringify(result));
    return;
  }
  out("host provision:");
  for (const step of result.steps) {
    out(`  [${step.status}] ${step.name}: ${step.detail}`);
  }
  for (const warning of result.warnings) {
    out(`  WARNING: ${warning}`);
  }
}

function formatStatus(
  status: HostStatus,
  json: boolean,
  out: (line: string) => void,
): void {
  if (json) {
    out(JSON.stringify(status));
    return;
  }
  out(`host status (${status.mode}): ${status.name} [${status.arch}]`);
  out(`  vm:      exists=${status.vmExists} running=${status.vmRunning}`);
  out(`  hostd:   ${status.daemons.hostd}`);
  out(`  rootd:   ${status.daemons.rootd}`);
  out(`  token:   ${status.tokenPresent ? "present" : "absent"}`);
  out(
    `  ports:   control=${status.ports.control} tunnel=${status.ports.tunnel} ` +
      `expose=${status.ports.exposeRange[0]}-${status.ports.exposeRange[1]}`,
  );
}

function formatDoctor(
  report: DoctorReport,
  json: boolean,
  out: (line: string) => void,
): void {
  if (json) {
    out(JSON.stringify(report));
    return;
  }
  out(formatDoctorReport(report));
}
