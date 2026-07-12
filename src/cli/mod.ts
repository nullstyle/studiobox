/**
 * The studiobox CLI programmatic surface — the `./cli` package export
 * (DESIGN.md §12; PLAN.md §M9).
 *
 * `deno run -A jsr:@nullstyle/studiobox/cli` runs `./main.ts`; this barrel
 * exposes the pieces an embedder assembling a local host needs: {@linkcode
 * runCli}, the {@linkcode HostLifecycle} module, the committed Lima template
 * generator, the provisioner, and the doctor. The daemon wire surfaces the
 * doctor consumes (hostd's `HostControl` client) are imported read-only; this
 * module owns none of them.
 *
 * @module
 */

// Dispatch + argument parsing.
export { CLI_VERSION, runCli } from "./run.ts";
export type { RunCliDeps } from "./run.ts";
export {
  CliUsageError,
  HOST_SUBCOMMANDS,
  parseCliArgs,
  USAGE,
} from "./args.ts";
export type {
  CliInvocation,
  HostCommand,
  HostFlags,
  HostSubcommand,
} from "./args.ts";

// Lifecycle module.
export { HostLifecycle } from "./host_lifecycle.ts";
export type {
  HostLifecycleOptions,
  HostStatus,
  HostUpResult,
} from "./host_lifecycle.ts";

// The subprocess seam.
export { DenoHostCommandRunner, HostCommandError, runChecked } from "./exec.ts";
export type {
  HostCommandOptions,
  HostCommandResult,
  HostCommandRunner,
} from "./exec.ts";

// The host execution environment (Lima / no-lima).
export { HostEnv, shellQuote } from "./host_env.ts";
export type { HostEnvOptions, HostMode } from "./host_env.ts";

// The committed Lima template + generator.
export {
  DEFAULT_LIMA_TEMPLATE_OPTIONS,
  DEFAULT_PORTS,
  hostVmName,
  renderLimaTemplate,
} from "./lima_template.ts";
export type { HostPortConfig, LimaTemplateOptions } from "./lima_template.ts";

// Provisioning.
export {
  defaultCompatPath,
  defaultDaemonBinary,
  defaultHostTokenPath,
  PROVISION_STEP_ORDER,
  provisionHost,
  renderSystemdUnits,
} from "./provision.ts";
export type {
  ProvisionOptions,
  ProvisionResult,
  ProvisionStepName,
  ProvisionStepResult,
} from "./provision.ts";

// Local filesystem seam.
export { DenoLocalFs } from "./local_fs.ts";
export type { LocalFs } from "./local_fs.ts";

// Doctor.
export { formatDoctorReport, runDoctor } from "./doctor.ts";
export type {
  DoctorCheck,
  DoctorCheckName,
  DoctorReport,
  HostCapacitySnapshot,
  HostProbe,
  QuarantinedRecord,
} from "./doctor.ts";
export {
  createHostProbe,
  DEFAULT_HOST_PROBE_TIMEOUT_MS,
} from "./host_client.ts";
export type { HostProbeOptions } from "./host_client.ts";
