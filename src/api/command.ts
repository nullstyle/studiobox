import { SandboxCommandError } from "./errors.ts";
import {
  KillController,
  KillSignal,
  type KillSignalListener,
  type Signal,
} from "./process.ts";

/** How a command's stdout/stderr is handled: passed through, captured, or discarded. */
export type ShellPipeKind = "inherit" | "piped" | "null";

/** Buffered result of a completed `sh` command. */
export interface SandboxCommandResult {
  /** Exit status of the command. */
  status: {
    /** True when the command exited with code 0. */
    success: boolean;
    /** Numeric exit code. */
    code: number;
    /** True when the command was killed by the out-of-memory killer. */
    oom: boolean;
  };
  /** Captured stdout as text, or `null` when stdout was not piped. */
  stdoutText: string | null;
  /** Captured stderr as text, or `null` when stderr was not piped. */
  stderrText: string | null;
  /** Captured stdout bytes, or `null` when stdout was not piped. */
  stdout: Uint8Array | null;
  /** Captured stderr bytes, or `null` when stderr was not piped. */
  stderr: Uint8Array | null;
}

interface CommandChild {
  output(): Promise<SandboxCommandResult>;
  kill(signal?: Signal): Promise<void>;
}

/**
 * Backend a {@link SandboxCommandBuilder} spawns through — implemented by
 * `Sandbox`, which supplies its `spawn` to the `sh` builder.
 */
export interface SandboxCommandHost {
  /** Spawn `command` with the given argv/stdio/env/cwd and return the child. */
  spawn(
    command: string,
    options: {
      args?: string[];
      stdout?: ShellPipeKind;
      stderr?: ShellPipeKind;
      env?: Record<string, string>;
      cwd?: string;
    },
  ): Promise<CommandChild>;
}

interface CommandState {
  noThrow: boolean;
  sudo: boolean;
  cwd?: string;
  env: Record<string, string>;
  stdout: ShellPipeKind;
  stderr: ShellPipeKind;
  signal?: KillSignal;
}

/**
 * Chainable builder returned by the `sh` template tag (Tier A).
 *
 * Runs `bash -c` with `BASH_ENV=$HOME/.bashrc` and per-argument single-quote
 * escaping (arrays expand, objects throw `TypeError`). Chain
 * `noThrow`/`sudo`/`cwd`/`env`/`stdout`/`stderr`/`signal`; finish with
 * `text`/`json`/`result`/`spawn`, or `await` it directly (it is thenable).
 * A nonzero exit throws `SandboxCommandError`.
 */
export class SandboxCommandBuilder
  implements PromiseLike<SandboxCommandResult> {
  readonly #state: CommandState;

  /** Construct a builder for a template-tagged command against `host`. */
  constructor(
    private readonly host: SandboxCommandHost,
    private readonly strings: TemplateStringsArray,
    private readonly substitutions: unknown[],
    state?: CommandState,
  ) {
    this.#state = state ?? {
      noThrow: false,
      sudo: false,
      env: {},
      stdout: "inherit",
      stderr: "inherit",
    };
  }

  /** Return a builder that resolves instead of throwing on a nonzero exit. */
  noThrow(value = true): SandboxCommandBuilder {
    return this.withState({ noThrow: value });
  }

  /** Return a builder that runs the command under `sudo`. */
  sudo(enable = true): SandboxCommandBuilder {
    return this.withState({ sudo: enable });
  }

  /** Return a builder that runs the command in working directory `path`. */
  cwd(path: string): SandboxCommandBuilder {
    return this.withState({ cwd: path });
  }

  /** Return a builder with `name=value` added to the command's environment. */
  env(name: string, value: string): SandboxCommandBuilder {
    return this.withState({ env: { ...this.#state.env, [name]: value } });
  }

  /** Return a builder with the given stdout disposition. */
  stdout(kind: ShellPipeKind): SandboxCommandBuilder {
    return this.withState({ stdout: kind });
  }

  /** Return a builder with the given stderr disposition. */
  stderr(kind: ShellPipeKind): SandboxCommandBuilder {
    return this.withState({ stderr: kind });
  }

  /** Return a builder whose command is killed when `signal` fires. */
  signal(signal: KillSignal | AbortSignal): SandboxCommandBuilder {
    let killSignal: KillSignal;
    if (signal instanceof KillSignal) {
      killSignal = signal;
    } else {
      const controller = new KillController();
      if (signal.aborted) controller.kill();
      signal.addEventListener("abort", () => controller.kill(), { once: true });
      killSignal = controller.signal;
    }
    return this.withState({ signal: killSignal });
  }

  /** Run the command and return its stdout as text (implies `stdout("piped")`). */
  async text(): Promise<string> {
    return (await this.stdout("piped").result()).stdoutText ?? "";
  }

  /** Run the command and parse its stdout as JSON. */
  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  /** Run the command and return its full {@link SandboxCommandResult}. */
  async result(): Promise<SandboxCommandResult> {
    const result = await (await this.spawn()).output();
    if (!this.#state.noThrow && !result.status.success) {
      const suffix = result.status.oom ? " (process ran out of memory)" : "";
      throw new SandboxCommandError(
        `Command failed with exit code ${result.status.code}${suffix}${
          result.stderrText ? `\n${result.stderrText}` : ""
        }`,
        result.status.code,
      );
    }
    return result;
  }

  /** Start the command without awaiting it, returning a {@link SandboxCommandChild}. */
  async spawn(): Promise<SandboxCommandChild> {
    if (this.#state.signal?.abortedExitCode !== undefined) {
      return new SandboxCommandChild({
        status: {
          success: false,
          code: this.#state.signal.abortedExitCode,
          oom: false,
        },
        stdoutText: "",
        stderrText: "",
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }

    const command = `${this.#state.sudo ? "sudo " : ""}${this.commandText()}`;
    const child = await this.host.spawn("bash", {
      args: ["-c", command],
      cwd: this.#state.cwd,
      env: { BASH_ENV: "$HOME/.bashrc", ...this.#state.env },
      stdout: this.#state.stdout,
      stderr: this.#state.stderr,
    });
    const listener: KillSignalListener = (signal) => {
      child.kill(signal).catch(() => {});
    };
    this.#state.signal?.addListener(listener);
    return new SandboxCommandChild(
      child,
      () => this.#state.signal?.removeListener(listener),
    );
  }

  /** {@link PromiseLike} hook: awaiting the builder runs it via {@link result}. */
  then<TResult1 = SandboxCommandResult, TResult2 = never>(
    onfulfilled?:
      | ((value: SandboxCommandResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.result().then(onfulfilled, onrejected);
  }

  /** Return a copy of this builder with `change` merged into its state. */
  private withState(change: Partial<CommandState>): SandboxCommandBuilder {
    return new SandboxCommandBuilder(
      this.host,
      this.strings,
      this.substitutions,
      {
        ...this.#state,
        ...change,
      },
    );
  }

  /** Interpolate and shell-escape substitutions into the final command string. */
  private commandText(): string {
    let command = this.strings[0];
    for (let index = 0; index < this.substitutions.length; index++) {
      const value = this.substitutions[index];
      const values = Array.isArray(value) ? value : [value];
      command += values.map(shellEscape).join(" ") + this.strings[index + 1];
    }
    return command;
  }
}

/** Handle to a spawned `sh` command, returned by {@link SandboxCommandBuilder.spawn}. */
export class SandboxCommandChild {
  /** Wrap a live child (or an already-resolved result) plus a cleanup callback. */
  constructor(
    private readonly child: CommandChild | SandboxCommandResult,
    private readonly unsubscribe: () => void = () => {},
  ) {}

  /** Await the command and return its buffered {@link SandboxCommandResult}. */
  async output(): Promise<SandboxCommandResult> {
    try {
      return "output" in this.child ? await this.child.output() : this.child;
    } finally {
      this.unsubscribe();
    }
  }
}

function shellEscape(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    throw new TypeError("Cannot use objects as shell arguments");
  }
  const text = String(value);
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
