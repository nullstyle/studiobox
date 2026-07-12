/**
 * The injectable subprocess seam the host lifecycle drives (PLAN.md §M9).
 *
 * Every external command the CLI runs — `limactl` on the macOS host, `bash`
 * inside the guest (or directly, under `--no-lima`), `cp`/`install` for token
 * delivery — flows through a {@linkcode HostCommandRunner}. The real
 * implementation is {@linkcode DenoHostCommandRunner} (backed by `Deno.Command`);
 * tests inject a recording fake and assert the exact `limactl`/`bash` argv
 * sequence WITHOUT a real VM, exactly as `src/rootd/network/apply.ts`'s
 * {@linkcode import("../rootd/network/apply.ts").CommandRunner} does for `nft`.
 *
 * @module
 */

/** Result of running one command (stdout/stderr captured, bounded). */
export interface HostCommandResult {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-run options. */
export interface HostCommandOptions {
  /** Bytes piped to the child's stdin (e.g. a heredoc script). */
  readonly stdin?: string;
}

/** The seam: run one command, capture its result. */
export interface HostCommandRunner {
  run(
    bin: string,
    args: readonly string[],
    options?: HostCommandOptions,
  ): Promise<HostCommandResult>;
}

/** Raised when the CLI runs a command that must succeed and it does not. */
export class HostCommandError extends Error {
  readonly bin: string;
  readonly args: readonly string[];
  readonly code: number;
  readonly stderr: string;

  constructor(result: HostCommandResult, bin: string, args: readonly string[]) {
    super(
      `command failed (exit ${result.code}): ${bin} ${args.join(" ")}${
        result.stderr.length > 0 ? `\n${result.stderr.trim()}` : ""
      }`,
    );
    this.name = "HostCommandError";
    this.bin = bin;
    this.args = [...args];
    this.code = result.code;
    this.stderr = result.stderr;
  }
}

const MAX_CAPTURE_BYTES = 64 * 1024;

/**
 * Default runner backed by `Deno.Command`. Captures stdout/stderr (bounded),
 * pipes `stdin` when provided, and never throws on a nonzero exit — the caller
 * decides whether a nonzero code is fatal (some probes, e.g. `test -e`, treat
 * it as data).
 */
export class DenoHostCommandRunner implements HostCommandRunner {
  async run(
    bin: string,
    args: readonly string[],
    options: HostCommandOptions = {},
  ): Promise<HostCommandResult> {
    const command = new Deno.Command(bin, {
      args: [...args],
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    }
    const { success, code, stdout, stderr } = await child.output();
    const decoder = new TextDecoder();
    return {
      success,
      code,
      stdout: decoder.decode(stdout).slice(0, MAX_CAPTURE_BYTES),
      stderr: decoder.decode(stderr).slice(0, MAX_CAPTURE_BYTES),
    };
  }
}

/** Run a command and throw {@linkcode HostCommandError} on a nonzero exit. */
export async function runChecked(
  runner: HostCommandRunner,
  bin: string,
  args: readonly string[],
  options?: HostCommandOptions,
): Promise<HostCommandResult> {
  const result = await runner.run(bin, args, options);
  if (!result.success) throw new HostCommandError(result, bin, args);
  return result;
}
