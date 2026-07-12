/**
 * Fixed, bounded authorization preface for the hostd -> rootd bridge hop.
 *
 * The tunnel path is two spliced hops (DESIGN.md §4; PLAN.md §M7/M8):
 *
 *   client --SBXTUN1--> hostd TunnelServer --SBXBRG1--> rootd BridgeServer --> guest vsock
 *
 * The outer hop is authorized by the single-use tunnel ticket (`tunnel_preface`).
 * This module is the INNER hop: rootd's `openBridge` grant names a per-bridge
 * loopback UDS plus a 32-byte `bridgeCredential`; hostd's bridge factory dials
 * that UDS and presents the credential in this fixed preface. rootd verifies it
 * (constant time) BEFORE it dials the guest vsock — the same burn-before-bridge
 * ordering the outer hop uses, so a local process that merely reaches the UDS
 * (defense in depth beneath the root-owned `/run/studiobox/b/` directory mode)
 * cannot claim the one-shot bridge without the credential.
 *
 * The wire shape mirrors `tunnel_preface` deliberately: a fixed 44-byte request
 * (magic + version + flags + 32-byte credential) and a fixed 12-byte response
 * (magic + status). Nothing past the preface is interpreted — once `Ok` is sent
 * the connection is a verbatim byte pipe to the guest agent.
 *
 * @module
 */

export const BRIDGE_REQUEST_BYTES = 44;
export const BRIDGE_RESPONSE_BYTES = 12;
export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_CREDENTIAL_BYTES = 32;

const REQUEST_MAGIC = new TextEncoder().encode("SBXBRG1\0");
const RESPONSE_MAGIC = new TextEncoder().encode("SBXBRA1\0");

export enum BridgeStatus {
  Ok = 0,
  AuthenticationFailed = 1,
  DialFailed = 2,
  ProtocolError = 3,
  InternalError = 255,
}

const KNOWN_STATUSES = new Set<number>(
  Object.values(BridgeStatus).filter(
    (value): value is number => typeof value === "number",
  ),
);

export class BridgePrefaceError extends Error {
  readonly code = "SBX_BRIDGE_PREFACE";

  constructor(message: string) {
    super(message);
    this.name = "BridgePrefaceError";
  }
}

export interface BridgeRequest {
  version: 1;
  flags: 0;
  credential: Uint8Array;
}

export interface BridgeResponse {
  status: BridgeStatus;
}

export interface BridgePrefaceReader {
  read(destination: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface ReadBridgePrefaceOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function encodeBridgeRequest(credential: Uint8Array): Uint8Array {
  if (credential.byteLength !== BRIDGE_CREDENTIAL_BYTES) {
    throw new RangeError("bridge credential must be exactly 32 bytes");
  }
  const output = new Uint8Array(BRIDGE_REQUEST_BYTES);
  output.set(REQUEST_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(8, BRIDGE_PROTOCOL_VERSION);
  view.setUint16(10, 0);
  output.set(credential, 12);
  return output;
}

export function decodeBridgeRequest(input: Uint8Array): BridgeRequest {
  if (input.byteLength !== BRIDGE_REQUEST_BYTES) {
    throw new BridgePrefaceError("bridge request must be exactly 44 bytes");
  }
  if (!equalBytes(input.subarray(0, 8), REQUEST_MAGIC)) {
    throw new BridgePrefaceError("invalid bridge request magic");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = view.getUint16(8);
  const flags = view.getUint16(10);
  if (version !== BRIDGE_PROTOCOL_VERSION) {
    throw new BridgePrefaceError(
      `unsupported bridge protocol version ${version}`,
    );
  }
  if (flags !== 0) {
    throw new BridgePrefaceError("bridge request flags must be zero");
  }
  return { version: 1, flags: 0, credential: input.slice(12, 44) };
}

/**
 * Read only the fixed request bytes, retaining any pipelined agent-plane data
 * in the connection. A stalled or cancelled connection is closed so no
 * unresolved read remains behind.
 */
export async function readBridgeRequest(
  reader: BridgePrefaceReader,
  options: ReadBridgePrefaceOptions = {},
): Promise<BridgeRequest> {
  const bytes = await readExactly(
    reader,
    BRIDGE_REQUEST_BYTES,
    options.timeoutMs ?? 5_000,
    "bridge request",
    options.signal,
  );
  return decodeBridgeRequest(bytes);
}

export function encodeBridgeResponse(status: BridgeStatus): Uint8Array {
  if (!KNOWN_STATUSES.has(status)) {
    throw new RangeError(`unknown bridge status ${status}`);
  }
  const output = new Uint8Array(BRIDGE_RESPONSE_BYTES);
  output.set(RESPONSE_MAGIC, 0);
  new DataView(output.buffer).setUint16(8, status);
  return output;
}

export function decodeBridgeResponse(input: Uint8Array): BridgeResponse {
  if (input.byteLength !== BRIDGE_RESPONSE_BYTES) {
    throw new BridgePrefaceError("bridge response must be exactly 12 bytes");
  }
  if (!equalBytes(input.subarray(0, 8), RESPONSE_MAGIC)) {
    throw new BridgePrefaceError("invalid bridge response magic");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const status = view.getUint16(8);
  if (view.getUint16(10) !== 0) {
    throw new BridgePrefaceError("bridge response reserved bytes must be zero");
  }
  if (!KNOWN_STATUSES.has(status)) {
    throw new BridgePrefaceError(`unknown bridge status ${status}`);
  }
  return { status: status as BridgeStatus };
}

/** Read the fixed response without consuming the first agent-RPC byte. */
export async function readBridgeResponse(
  reader: BridgePrefaceReader,
  options: ReadBridgePrefaceOptions = {},
): Promise<BridgeResponse> {
  const bytes = await readExactly(
    reader,
    BRIDGE_RESPONSE_BYTES,
    options.timeoutMs ?? 8_000,
    "bridge response",
    options.signal,
  );
  return decodeBridgeResponse(bytes);
}

async function readExactly(
  reader: BridgePrefaceReader,
  length: number,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("preface timeout must be positive");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (error: unknown) => {
      try {
        reader.close();
      } catch {
        // Best effort: the original deadline/cancellation remains authoritative.
      }
      reject(error);
    };
    timeout = setTimeout(
      () => stop(new BridgePrefaceError(`${label} deadline exceeded`)),
      timeoutMs,
    );
    abortListener = () =>
      stop(
        signal?.reason ?? new DOMException(`${label} cancelled`, "AbortError"),
      );
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();
  });
  const read = (async () => {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < output.byteLength) {
      const count = await reader.read(output.subarray(offset));
      if (count === null) {
        throw new BridgePrefaceError(`${label} ended before ${length} bytes`);
      }
      if (
        !Number.isSafeInteger(count) || count <= 0 ||
        count > output.byteLength - offset
      ) {
        throw new BridgePrefaceError(
          `${label} reader returned an invalid byte count`,
        );
      }
      offset += count;
    }
    return output;
  })();
  try {
    return await Promise.race([read, interrupted]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener !== undefined) {
      signal?.removeEventListener("abort", abortListener);
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}
