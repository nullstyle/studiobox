/**
 * Per-restore personalization for snapshot-restore (DESIGN
 * `docs/snapshot-restore.md` §2.2).
 *
 * A warm-template studioboxd boots in **template mode**: its vsock listener is
 * up, but it holds NO credential and its NIC is present-but-unconfigured. Every
 * restore of a template shares one snapshot's guest memory, so per-sandbox
 * identity CANNOT be baked at boot — instead rootd injects it after
 * restore+resume by calling the pre-auth `AgentBootstrap.personalize` method
 * (`schema/sandbox_agent.capnp`) exactly once. `personalize`:
 *
 *   1. validates + sets the per-sandbox credential the later `authenticate`
 *      must match (replacing, for the snapshot path, what `--token-file`
 *      supplies on the cold path) plus the bootNonce/sandboxId binding;
 *   2. reconfigures the guest NIC IN-BAND — `ip addr flush/add`, `ip link set
 *      up`, `ip route replace default`, and a `nameserver <dns>` line in
 *      `/etc/resolv.conf` — through INJECTED seams ({@linkcode
 *      PersonalizeCommandRunner} + {@linkcode PersonalizeFileWriter}) so the
 *      state machine is host-safe testable and the exact argv is assertable;
 *   3. transitions to normal serving, after which `personalize` is rejected
 *      (`already personalized`) and `authenticate`/`agent` behave exactly as on
 *      the cold path.
 *
 * The cold path (`--token-file`) never constructs a `pending` controller: the
 * wire plane synthesizes a `personalized` controller seeded from the boot
 * credential, so `personalize` returns `already personalized` and
 * `authenticate` reads the same immutable credential it always has.
 *
 * @module
 */

/** Lifecycle of the process-global personalization identity. */
export type PersonalizationState = "pending" | "personalized";

/** In-band guest-NIC configuration carried by a `personalize` request. */
export interface GuestNetworkConfig {
  /** Guest CIDR (e.g. `10.201.0.2/30`); EMPTY ⇒ netless (leave the NIC down). */
  readonly guestCidr: string;
  /** Default gateway (the host TAP address); guarded when empty. */
  readonly gateway: string;
  /** Resolver written to `/etc/resolv.conf`; guarded when empty. */
  readonly dns: string;
  /** Guest NIC to (re)configure in-band (e.g. `eth0`). */
  readonly iface: string;
}

/** The validated identity + network a `personalize` call carries. */
export interface PersonalizeInput {
  /** Per-restore authenticate secret (16..512 bytes). */
  readonly credential: Uint8Array;
  /** Per-restore boot nonce (bound like the cold path). */
  readonly bootNonce: Uint8Array;
  /** Bound sandbox id. */
  readonly sandboxId: string;
  /** In-band NIC config (empty `guestCidr` ⇒ netless). */
  readonly network: GuestNetworkConfig;
}

/** What a successful `personalize` reports back to the caller. */
export interface PersonalizeOutcome {
  /** The applied guest CIDR; empty when netless. */
  readonly appliedCidr: string;
}

/**
 * Runs a single in-guest command (argv[0] is the program). The real
 * implementation spawns it and throws on a non-zero exit; the fake asserts the
 * exact argv.
 */
export interface PersonalizeCommandRunner {
  run(argv: readonly string[]): Promise<void>;
}

/** Writes a whole file (used for `/etc/resolv.conf`). */
export interface PersonalizeFileWriter {
  write(path: string, contents: string): Promise<void>;
}

/** Reasons a `personalize` can fail (mapped to `SbxError` by the wire plane). */
export type PersonalizationErrorCode =
  | "alreadyPersonalized"
  | "invalidRequest"
  | "networkApplyFailed";

/** A typed personalization fault. */
export class PersonalizationError extends Error {
  override readonly name = "PersonalizationError";
  readonly code: PersonalizationErrorCode;

  constructor(
    code: PersonalizationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

/** Minimum/maximum credential length, mirroring `readCredentialFile`. */
const MIN_CREDENTIAL_BYTES = 16;
const MAX_CREDENTIAL_BYTES = 512;
/** Default in-guest resolver path (studioboxd runs chrooted into the overlay). */
export const DEFAULT_RESOLV_CONF_PATH = "/etc/resolv.conf";

/** Dependencies a `pending` (template-mode) controller needs to apply a NIC. */
export interface PersonalizationControllerDeps {
  readonly runner: PersonalizeCommandRunner;
  readonly writer: PersonalizeFileWriter;
  /** Where the resolver line lands. @default {@linkcode DEFAULT_RESOLV_CONF_PATH} */
  readonly resolvConfPath?: string;
}

/** Seed for a `personalized` controller (the cold path's immutable identity). */
export interface PersonalizedSeed {
  readonly credential: Uint8Array | null;
  readonly expectedSandboxId?: string;
  readonly expectedBootNonce?: Uint8Array;
}

/**
 * The process-global personalization identity shared by every served
 * connection. A `pending` controller (template mode) accepts exactly one
 * `personalize`; a `personalized` controller (post-personalize, or the cold
 * path's synthesized seed) rejects it.
 */
export class PersonalizationController {
  #state: PersonalizationState;
  /**
   * Synchronous in-progress latch closing the check-then-act gap between the
   * `pending` guard and the `await #applyNetwork` yield: a second `personalize`
   * that interleaves across that await sees `#claimed` and is rejected, so the
   * one-shot holds against CONCURRENT calls (not just sequential ones) and a
   * later caller can never swap the credential mid-apply. Reset on failure so a
   * NIC-apply fault leaves the controller re-personalizable (fallback/retry).
   */
  #claimed = false;
  #credential: Uint8Array | null;
  #expectedSandboxId: string | undefined;
  #expectedBootNonce: Uint8Array | undefined;
  readonly #runner: PersonalizeCommandRunner | null;
  readonly #writer: PersonalizeFileWriter | null;
  readonly #resolvConfPath: string;

  private constructor(
    state: PersonalizationState,
    credential: Uint8Array | null,
    expectedSandboxId: string | undefined,
    expectedBootNonce: Uint8Array | undefined,
    deps: PersonalizationControllerDeps | null,
  ) {
    this.#state = state;
    this.#credential = credential;
    this.#expectedSandboxId = expectedSandboxId;
    this.#expectedBootNonce = expectedBootNonce;
    this.#runner = deps?.runner ?? null;
    this.#writer = deps?.writer ?? null;
    this.#resolvConfPath = deps?.resolvConfPath ?? DEFAULT_RESOLV_CONF_PATH;
  }

  /** A template-mode controller: pending, holding no credential. */
  static pending(
    deps: PersonalizationControllerDeps,
  ): PersonalizationController {
    return new PersonalizationController(
      "pending",
      null,
      undefined,
      undefined,
      deps,
    );
  }

  /**
   * A serving controller seeded from an immutable identity — the cold path's
   * boot credential (from `--token-file`). `personalize` is rejected.
   */
  static personalized(seed: PersonalizedSeed): PersonalizationController {
    return new PersonalizationController(
      "personalized",
      seed.credential,
      seed.expectedSandboxId,
      seed.expectedBootNonce,
      null,
    );
  }

  get state(): PersonalizationState {
    return this.#state;
  }

  /** The credential `authenticate` must match; `null` fails every auth closed. */
  get credential(): Uint8Array | null {
    return this.#credential;
  }

  get expectedSandboxId(): string | undefined {
    return this.#expectedSandboxId;
  }

  get expectedBootNonce(): Uint8Array | undefined {
    return this.#expectedBootNonce;
  }

  /**
   * One-shot: validate the request, apply the guest NIC in-band, then set the
   * credential + bindings and flip to `personalized`. The network is applied
   * BEFORE the state flips so a NIC failure leaves the controller `pending`
   * (rootd kills the restore and falls back to cold). Throws
   * {@linkcode PersonalizationError} on any fault.
   */
  async personalize(input: PersonalizeInput): Promise<PersonalizeOutcome> {
    if (this.#state !== "pending" || this.#claimed) {
      throw new PersonalizationError(
        "alreadyPersonalized",
        "sandbox already personalized",
      );
    }
    validateInput(input);
    // Claim synchronously (no await since the guard) so a concurrent
    // personalize cannot also pass the guard while we await the NIC apply.
    this.#claimed = true;
    let appliedCidr: string;
    try {
      appliedCidr = await this.#applyNetwork(input.network);
    } catch (error) {
      // A NIC-apply fault leaves the controller `pending` AND unclaimed, so
      // credential stays null (fails auth closed) and rootd can kill+fallback
      // or retry a fresh personalize.
      this.#claimed = false;
      throw error;
    }
    this.#credential = input.credential;
    // Bind the bootNonce (anti-replay) but NOT the sandboxId: rootd's launch
    // sandboxId (`sbx-loc-…`) is NOT the client-facing id (`sbx_loc_…`) the
    // tunnel client presents at `authenticate` — hostd keeps the public id and
    // "the public id never has to reach the wire" (hostd control_core), so a
    // sandboxId binding here can NEVER match and would reject every client. The
    // per-restore credential is already unique, and the bootNonce (minted once
    // by hostd, handed to BOTH rootd.launch and the client grant) matches, so
    // credential + bootNonce is the enforceable binding. The cold path binds
    // neither (credential only); this is strictly stronger and still parity-safe.
    this.#expectedBootNonce = input.bootNonce;
    this.#state = "personalized";
    return { appliedCidr };
  }

  /**
   * Apply the guest NIC exactly as `overlay-init` does on the cold path, but
   * in-band and through the injected seams. Returns the applied CIDR (empty
   * when netless). `flush` first makes it idempotent-safe against any residual
   * template state.
   */
  async #applyNetwork(network: GuestNetworkConfig): Promise<string> {
    if (network.guestCidr === "") return ""; // netless: leave the NIC down.
    const iface = network.iface;
    const runner = this.#runner;
    const writer = this.#writer;
    if (runner === null || writer === null) {
      throw new PersonalizationError(
        "networkApplyFailed",
        "personalization controller has no command runner (not template mode)",
      );
    }
    try {
      await runner.run(["ip", "addr", "flush", "dev", iface]);
      await runner.run(["ip", "addr", "add", network.guestCidr, "dev", iface]);
      await runner.run(["ip", "link", "set", iface, "up"]);
      if (network.gateway !== "") {
        await runner.run([
          "ip",
          "route",
          "replace",
          "default",
          "via",
          network.gateway,
        ]);
      }
      if (network.dns !== "") {
        await writer.write(
          this.#resolvConfPath,
          `nameserver ${network.dns}\n`,
        );
      }
    } catch (error) {
      if (error instanceof PersonalizationError) throw error;
      throw new PersonalizationError(
        "networkApplyFailed",
        `failed to apply guest network: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
    }
    return network.guestCidr;
  }
}

function validateInput(input: PersonalizeInput): void {
  const length = input.credential.byteLength;
  if (length < MIN_CREDENTIAL_BYTES || length > MAX_CREDENTIAL_BYTES) {
    throw new PersonalizationError(
      "invalidRequest",
      `credential must decode to ${MIN_CREDENTIAL_BYTES}..${MAX_CREDENTIAL_BYTES} bytes`,
    );
  }
  if (input.bootNonce.byteLength === 0) {
    throw new PersonalizationError(
      "invalidRequest",
      "bootNonce must be non-empty",
    );
  }
  if (input.sandboxId === "") {
    throw new PersonalizationError(
      "invalidRequest",
      "sandboxId must be non-empty",
    );
  }
  if (input.network.guestCidr !== "" && input.network.iface === "") {
    throw new PersonalizationError(
      "invalidRequest",
      "a networked personalize requires network.iface",
    );
  }
}

/**
 * The real in-guest command runner: spawns `argv[0]` with the remaining argv,
 * inheriting stdio to the guest console, and throws on a non-zero exit.
 */
/**
 * Search path for the in-band personalize commands. Template-mode studioboxd is
 * exec'd by `overlay-init` as a near-bare init with NO `PATH`, so a bare `ip`
 * cannot be resolved by name (`Deno.Command` then throws "no path to search").
 * The guest ships `ip` at `/bin/ip` (with `/sbin`, `/usr/sbin` symlinks), so
 * supplying the standard sbin/bin search path lets the argv stay by-name.
 */
const PERSONALIZE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

export const denoCommandRunner: PersonalizeCommandRunner = Object.freeze({
  async run(argv: readonly string[]): Promise<void> {
    const [command, ...args] = argv;
    const output = await new Deno.Command(command, {
      args,
      // Merge a real PATH over the (possibly empty) inherited env so `ip`
      // resolves even when studioboxd booted without one.
      env: { PATH: PERSONALIZE_PATH },
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(
        `${argv.join(" ")} exited with code ${output.code}${
          stderr === "" ? "" : `: ${stderr}`
        }`,
      );
    }
  },
});

/** The real file writer, targeting the in-chroot `/etc/resolv.conf`. */
export const denoFileWriter: PersonalizeFileWriter = Object.freeze({
  write(path: string, contents: string): Promise<void> {
    return Deno.writeTextFile(path, contents);
  },
});
