/** Signals accepted by the upstream sandbox process API. */
export type Signal =
  | "SIGABRT"
  | "SIGALRM"
  | "SIGBREAK"
  | "SIGBUS"
  | "SIGCHLD"
  | "SIGCONT"
  | "SIGEMT"
  | "SIGFPE"
  | "SIGHUP"
  | "SIGILL"
  | "SIGINFO"
  | "SIGINT"
  | "SIGIO"
  | "SIGPOLL"
  | "SIGUNUSED"
  | "SIGKILL"
  | "SIGPIPE"
  | "SIGPROF"
  | "SIGPWR"
  | "SIGQUIT"
  | "SIGSEGV"
  | "SIGSTKFLT"
  | "SIGSTOP"
  | "SIGSYS"
  | "SIGTERM"
  | "SIGTRAP"
  | "SIGTSTP"
  | "SIGTTIN"
  | "SIGTTOU"
  | "SIGURG"
  | "SIGUSR1"
  | "SIGUSR2"
  | "SIGVTALRM"
  | "SIGWINCH"
  | "SIGXCPU"
  | "SIGXFSZ";

export interface ChildProcessStatus {
  success: boolean;
  code: number;
  signal: Signal | null;
  oom: boolean;
}

export interface ChildProcessOutput {
  status: ChildProcessStatus;
  readonly stdout: Uint8Array<ArrayBuffer> | null;
  readonly stderr: Uint8Array<ArrayBuffer> | null;
  readonly stdoutText: string | null;
  readonly stderrText: string | null;
}

/** Runtime-neutral public process contract. */
export abstract class ChildProcess extends EventTarget
  implements AsyncDisposable {
  abstract get pid(): number;
  abstract get stdin(): WritableStream<Uint8Array<ArrayBuffer>> | null;
  abstract get stdout(): ReadableStream<Uint8Array<ArrayBuffer>> | null;
  abstract get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> | null;
  abstract get status(): Promise<ChildProcessStatus>;
  abstract kill(signal?: Signal): Promise<void>;
  abstract output(): Promise<ChildProcessOutput>;
  abstract [Symbol.asyncDispose](): Promise<void>;
}

interface KillSignalState {
  abortedExitCode?: number;
  listeners: KillSignalListener[];
}

export type KillSignalListener = (signal: Signal) => void;

export class KillController {
  readonly #state: KillSignalState = { listeners: [] };
  readonly #signal = new KillSignal(this.#state);

  get signal(): KillSignal {
    return this.#signal;
  }

  kill(signal: Signal = "SIGTERM"): void {
    dispatchSignal(this.#state, signal);
  }
}

export class KillSignal {
  constructor(private readonly state: KillSignalState) {}

  get aborted(): boolean {
    return this.state.abortedExitCode !== undefined;
  }

  get abortedExitCode(): number | undefined {
    return this.state.abortedExitCode;
  }

  linkChild(killSignal: KillSignal): { unsubscribe(): void } {
    const listener = (signal: Signal) =>
      dispatchSignal(killSignal.state, signal);
    this.addListener(listener);
    return { unsubscribe: () => this.removeListener(listener) };
  }

  addListener(listener: KillSignalListener): void {
    this.state.listeners.push(listener);
  }

  removeListener(listener: KillSignalListener): void {
    const index = this.state.listeners.indexOf(listener);
    if (index >= 0) this.state.listeners.splice(index, 1);
  }
}

function dispatchSignal(state: KillSignalState, signal: Signal): void {
  state.abortedExitCode = abortExitCode(signal) ?? state.abortedExitCode;
  for (const listener of [...state.listeners]) listener(signal);
}

function abortExitCode(signal: Signal): number | undefined {
  switch (signal) {
    case "SIGTERM":
      return 143;
    case "SIGKILL":
      return 137;
    case "SIGABRT":
      return 134;
    case "SIGQUIT":
      return 131;
    case "SIGINT":
      return 130;
    default:
      return undefined;
  }
}
