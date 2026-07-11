import { SandboxCommandError } from "./errors.ts";
import {
  KillController,
  KillSignal,
  type KillSignalListener,
  type Signal,
} from "./process.ts";

export type ShellPipeKind = "inherit" | "piped" | "null";

export interface SandboxCommandResult {
  status: {
    success: boolean;
    code: number;
    oom: boolean;
  };
  stdoutText: string | null;
  stderrText: string | null;
  stdout: Uint8Array | null;
  stderr: Uint8Array | null;
}

interface CommandChild {
  output(): Promise<SandboxCommandResult>;
  kill(signal?: Signal): Promise<void>;
}

export interface SandboxCommandHost {
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

export class SandboxCommandBuilder
  implements PromiseLike<SandboxCommandResult> {
  readonly #state: CommandState;

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

  noThrow(value = true): SandboxCommandBuilder {
    return this.withState({ noThrow: value });
  }

  sudo(enable = true): SandboxCommandBuilder {
    return this.withState({ sudo: enable });
  }

  cwd(path: string): SandboxCommandBuilder {
    return this.withState({ cwd: path });
  }

  env(name: string, value: string): SandboxCommandBuilder {
    return this.withState({ env: { ...this.#state.env, [name]: value } });
  }

  stdout(kind: ShellPipeKind): SandboxCommandBuilder {
    return this.withState({ stdout: kind });
  }

  stderr(kind: ShellPipeKind): SandboxCommandBuilder {
    return this.withState({ stderr: kind });
  }

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

  async text(): Promise<string> {
    return (await this.stdout("piped").result()).stdoutText ?? "";
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

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

  then<TResult1 = SandboxCommandResult, TResult2 = never>(
    onfulfilled?:
      | ((value: SandboxCommandResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.result().then(onfulfilled, onrejected);
  }

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

export class SandboxCommandChild {
  constructor(
    private readonly child: CommandChild | SandboxCommandResult,
    private readonly unsubscribe: () => void = () => {},
  ) {}

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
