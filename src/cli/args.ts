/**
 * Argument parsing for the studiobox CLI (PLAN.md §M9).
 *
 * Grammar:
 *
 *   studiobox host <up|down|status|doctor|provision> [flags]
 *   studiobox --help | host --help
 *   studiobox --version
 *
 * Flags (host subcommands): `--recreate`, `--no-lima`, `--json`,
 * `--rotate-token`, `--name <n>`, `--arch <aarch64|x86_64>`,
 * `--control-port <n>`, `--build-dir <path>`, `--hostd-bin <path>`,
 * `--rootd-bin <path>`. Parsing is exhaustively unit-tested; nothing here
 * touches the host.
 *
 * @module
 */

import { ARTIFACT_ARCHES, type ArtifactArch } from "../../images/pins.ts";

/** The five host subcommands (DESIGN.md §11). */
export const HOST_SUBCOMMANDS = [
  "up",
  "down",
  "status",
  "doctor",
  "provision",
] as const;
export type HostSubcommand = (typeof HOST_SUBCOMMANDS)[number];

/** Parsed host-subcommand flags. */
export interface HostFlags {
  /** Delete + recreate the VM before provisioning (up/provision). */
  readonly recreate: boolean;
  /** Provision the local machine directly (Linux / CI) instead of Lima. */
  readonly noLima: boolean;
  /** Emit machine-readable JSON (status/doctor). */
  readonly json: boolean;
  /** Re-mint the bootstrap token even if one exists (up/provision). */
  readonly rotateToken: boolean;
  /** Override the Lima instance name (default `studiobox-host-<arch>`). */
  readonly name?: string;
  /** Override the target arch (default `Deno.build.arch`). */
  readonly arch?: ArtifactArch;
  /** Override the HostControl port (default 40000). */
  readonly controlPort?: number;
  /** Where the compiled daemon binaries live (default `.build`). */
  readonly buildDir?: string;
  /** Explicit host source of the `studiobox-hostd` binary. */
  readonly hostdBin?: string;
  /** Explicit host source of the `studiobox-rootd` binary. */
  readonly rootdBin?: string;
}

/** A parsed `host <sub>` invocation. */
export interface HostCommand {
  readonly kind: "host";
  readonly sub: HostSubcommand;
  readonly flags: HostFlags;
}

/** The parse result. */
export type CliInvocation =
  | HostCommand
  | { readonly kind: "help"; readonly topic?: "host" }
  | { readonly kind: "version" };

/** Top-level + host usage text. */
export const USAGE = `studiobox — local Firecracker-backed sandboxes

usage:
  studiobox host <command> [flags]
  studiobox --help | --version

host commands:
  up         create/start the host VM (macOS) and provision it, then verify
  down       stop the host VM (macOS) or the daemons (--no-lima)
  status     report VM + daemon + token state
  doctor     negotiate, read capacity, probe a canary sandbox, list quarantine
  provision  (re)install firecracker, daemons, systemd units, and the token

host flags:
  --recreate         delete + recreate the VM before provisioning
  --no-lima          provision this Linux machine directly (no Lima VM)
  --json             machine-readable output (status/doctor)
  --rotate-token     re-mint the bootstrap token
  --name <name>      Lima instance name (default studiobox-host-<arch>)
  --arch <arch>      target arch: aarch64 | x86_64 (default: this host)
  --control-port <n> HostControl port (default 40000)
  --build-dir <dir>  directory holding the compiled daemons (default .build)
  --hostd-bin <path> explicit studiobox-hostd binary source
  --rootd-bin <path> explicit studiobox-rootd binary source`;

/** Raised on any malformed invocation; carries the usage text. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function isHostSubcommand(value: string): value is HostSubcommand {
  return (HOST_SUBCOMMANDS as readonly string[]).includes(value);
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new CliUsageError(`--control-port must be 1..65535 (got "${value}")`);
  }
  return port;
}

function parseArch(value: string): ArtifactArch {
  if (!(ARTIFACT_ARCHES as readonly string[]).includes(value)) {
    throw new CliUsageError(
      `--arch must be one of ${ARTIFACT_ARCHES.join(", ")} (got "${value}")`,
    );
  }
  return value as ArtifactArch;
}

/** Parse the full argv into a {@linkcode CliInvocation}. */
export function parseCliArgs(argv: readonly string[]): CliInvocation {
  if (argv.length === 0) {
    throw new CliUsageError("no command given");
  }
  const [first, ...rest] = argv;

  if (first === "--help" || first === "-h" || first === "help") {
    return { kind: "help" };
  }
  if (first === "--version" || first === "-v" || first === "version") {
    return { kind: "version" };
  }
  if (first !== "host") {
    throw new CliUsageError(`unknown command: ${first}`);
  }

  if (rest.length === 0) {
    throw new CliUsageError("host requires a subcommand");
  }
  const [sub, ...flagArgs] = rest;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    return { kind: "help", topic: "host" };
  }
  if (!isHostSubcommand(sub)) {
    throw new CliUsageError(
      `unknown host subcommand: ${sub} ` +
        `(expected ${HOST_SUBCOMMANDS.join(", ")})`,
    );
  }

  let recreate = false;
  let noLima = false;
  let json = false;
  let rotateToken = false;
  let name: string | undefined;
  let arch: ArtifactArch | undefined;
  let controlPort: number | undefined;
  let buildDir: string | undefined;
  let hostdBin: string | undefined;
  let rootdBin: string | undefined;

  for (let i = 0; i < flagArgs.length; i++) {
    const arg = flagArgs[i];
    const take = (flag: string): string => {
      const inline = `${flag}=`;
      if (arg.startsWith(inline)) return arg.slice(inline.length);
      const next = flagArgs[++i];
      if (next === undefined) {
        throw new CliUsageError(`${flag} needs a value`);
      }
      return next;
    };
    const is = (flag: string): boolean =>
      arg === flag || arg.startsWith(`${flag}=`);

    if (arg === "--recreate") recreate = true;
    else if (arg === "--no-lima") noLima = true;
    else if (arg === "--json") json = true;
    else if (arg === "--rotate-token") rotateToken = true;
    else if (is("--name")) name = take("--name");
    else if (is("--arch")) arch = parseArch(take("--arch"));
    else if (is("--control-port")) {
      controlPort = parsePort(take("--control-port"));
    } else if (is("--build-dir")) buildDir = take("--build-dir");
    else if (is("--hostd-bin")) hostdBin = take("--hostd-bin");
    else if (is("--rootd-bin")) rootdBin = take("--rootd-bin");
    else throw new CliUsageError(`unknown flag: ${arg}`);
  }

  return {
    kind: "host",
    sub,
    flags: {
      recreate,
      noLima,
      json,
      rotateToken,
      ...(name === undefined ? {} : { name }),
      ...(arch === undefined ? {} : { arch }),
      ...(controlPort === undefined ? {} : { controlPort }),
      ...(buildDir === undefined ? {} : { buildDir }),
      ...(hostdBin === undefined ? {} : { hostdBin }),
      ...(rootdBin === undefined ? {} : { rootdBin }),
    },
  };
}
