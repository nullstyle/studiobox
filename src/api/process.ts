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

/** Exit status of a finished child process, mirroring upstream. */
export interface ChildProcessStatus {
  /** True when the process exited cleanly (code 0, no signal). */
  success: boolean;
  /** Numeric exit code (`128 + n` when terminated by signal `n`). */
  code: number;
  /** The signal that terminated the process, or `null`. */
  signal: Signal | null;
  /** True when the process was killed by the out-of-memory killer. */
  oom: boolean;
}

/** Buffered result of a child process, returned by {@link ChildProcess.output}. */
export interface ChildProcessOutput {
  /** The process's final exit status. */
  status: ChildProcessStatus;
  /** Captured stdout bytes, or `null` if not piped or unreadable. */
  readonly stdout: Uint8Array<ArrayBuffer> | null;
  /** Captured stderr bytes, or `null` if not piped or unreadable. */
  readonly stderr: Uint8Array<ArrayBuffer> | null;
  /** {@link stdout} decoded as UTF-8 text (lazy), or `null`. */
  readonly stdoutText: string | null;
  /** {@link stderr} decoded as UTF-8 text (lazy), or `null`. */
  readonly stderrText: string | null;
}

/** Runtime-neutral public process contract. */
export abstract class ChildProcess extends EventTarget
  implements AsyncDisposable {
  /** Process id of the spawned command inside the sandbox. */
  abstract get pid(): number;
  /** Writable stdin stream, or `null` when stdin was not piped. */
  abstract get stdin(): WritableStream<Uint8Array<ArrayBuffer>> | null;
  /** Readable stdout stream, or `null` when stdout was not piped. */
  abstract get stdout(): ReadableStream<Uint8Array<ArrayBuffer>> | null;
  /** Readable stderr stream, or `null` when stderr was not piped. */
  abstract get stderr(): ReadableStream<Uint8Array<ArrayBuffer>> | null;
  /** Resolves with the exit {@link ChildProcessStatus} when the process ends. */
  abstract get status(): Promise<ChildProcessStatus>;
  /** Send `signal` (default `SIGTERM`) to the process. */
  abstract kill(signal?: Signal): Promise<void>;
  /** Await completion and buffer stdout/stderr into a {@link ChildProcessOutput}. */
  abstract output(): Promise<ChildProcessOutput>;
  /** Dispose semantics: kill the process if still running. */
  abstract [Symbol.asyncDispose](): Promise<void>;
}

interface KillSignalState {
  abortedExitCode?: number;
  listeners: KillSignalListener[];
}

/** Callback invoked with the delivered {@link Signal} when a kill fires. */
export type KillSignalListener = (signal: Signal) => void;

/**
 * Source of kill signals, mirroring upstream's `KillController`.
 *
 * Hand its {@link signal} to `sh(...).signal(...)` (or a `ChildProcess`) and
 * call {@link kill} to terminate the linked commands. Abort exit codes follow
 * the `128 + n` convention (SIGTERM → 143, SIGKILL → 137, …).
 */
export class KillController {
  readonly #state: KillSignalState = { listeners: [] };
  readonly #signal = new KillSignal(this.#state);

  /** The {@link KillSignal} that consumers subscribe to. */
  get signal(): KillSignal {
    return this.#signal;
  }

  /** Fire `signal` (default `SIGTERM`) to every linked listener. */
  kill(signal: Signal = "SIGTERM"): void {
    dispatchSignal(this.#state, signal);
  }
}

/**
 * Read side of a {@link KillController} — the object a command observes to
 * learn it should terminate. Mirrors upstream's `KillSignal`.
 */
export class KillSignal {
  /** Wrap shared kill state; obtain instances via {@link KillController.signal}. */
  constructor(private readonly state: KillSignalState) {}

  /** True once a kill has been dispatched through this signal. */
  get aborted(): boolean {
    return this.state.abortedExitCode !== undefined;
  }

  /** The exit code implied by the abort signal, or `undefined` if none maps. */
  get abortedExitCode(): number | undefined {
    return this.state.abortedExitCode;
  }

  /** Forward signals from this parent to a child signal; returns an unsubscribe handle. */
  linkChild(killSignal: KillSignal): { unsubscribe(): void } {
    const listener = (signal: Signal) =>
      dispatchSignal(killSignal.state, signal);
    this.addListener(listener);
    return { unsubscribe: () => this.removeListener(listener) };
  }

  /** Register `listener` to be called when a signal is dispatched. */
  addListener(listener: KillSignalListener): void {
    this.state.listeners.push(listener);
  }

  /** Remove a previously registered {@link addListener} callback. */
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
