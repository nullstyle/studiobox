import type {
  NegotiatedContract,
  NegotiationResult,
  SbxError,
} from "./contract.ts";

export type BootstrapPhase =
  | "connected"
  | "negotiated"
  | "authenticated"
  | "closed";

/**
 * Transport-local state gate shared by all three bootstraps.
 *
 * Generated capabilities remain unusable until this gate reaches
 * `authenticated`. An out-of-order call fails closed instead of relying on a
 * client to observe bootstrap method ordering.
 */
export class BootstrapGate {
  #phase: BootstrapPhase = "connected";
  #contract: NegotiatedContract | undefined;
  #authenticationFailures = 0;
  readonly #maxAuthenticationFailures: number;

  constructor(maxAuthenticationFailures = 3) {
    if (
      !Number.isSafeInteger(maxAuthenticationFailures) ||
      maxAuthenticationFailures < 1 ||
      maxAuthenticationFailures > 16
    ) {
      throw new RangeError(
        "maxAuthenticationFailures must be between 1 and 16",
      );
    }
    this.#maxAuthenticationFailures = maxAuthenticationFailures;
  }

  get phase(): BootstrapPhase {
    return this.#phase;
  }

  get contract(): NegotiatedContract | undefined {
    return this.#contract;
  }

  acceptNegotiation(result: NegotiationResult): NegotiatedContract {
    this.#requirePhase("connected", "negotiate");
    if (!result.ok) {
      this.#phase = "closed";
      throw new BootstrapRejectedError(result.error);
    }
    this.#contract = result.value;
    this.#phase = "negotiated";
    return result.value;
  }

  recordAuthentication(verified: boolean): void {
    this.#requirePhase("negotiated", "authenticate");
    if (verified) {
      this.#phase = "authenticated";
      return;
    }

    this.#authenticationFailures++;
    if (this.#authenticationFailures >= this.#maxAuthenticationFailures) {
      this.#phase = "closed";
    }
    throw new AuthenticationRejectedError(this.#phase === "closed");
  }

  assertAuthorized(): void {
    if (this.#phase !== "authenticated") {
      this.#phase = "closed";
      throw new BootstrapStateError(
        "service capability requested before authentication",
      );
    }
  }

  close(): void {
    this.#phase = "closed";
    this.#contract = undefined;
  }

  #requirePhase(expected: BootstrapPhase, operation: string): void {
    if (this.#phase !== expected) {
      const actual = this.#phase;
      this.#phase = "closed";
      throw new BootstrapStateError(
        `${operation} requires ${expected} phase, received ${actual}`,
      );
    }
  }
}

export class BootstrapStateError extends Error {
  override readonly name = "BootstrapStateError";
}

export class BootstrapRejectedError extends Error {
  override readonly name = "BootstrapRejectedError";

  constructor(readonly error: SbxError) {
    super(error.message);
  }
}

export class AuthenticationRejectedError extends Error {
  override readonly name = "AuthenticationRejectedError";

  constructor(readonly connectionClosed: boolean) {
    super("authentication rejected");
  }
}
