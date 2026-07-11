/** Fixed, bounded authorization preface for the external sandbox tunnel. */

export const TUNNEL_REQUEST_BYTES = 44;
export const TUNNEL_RESPONSE_BYTES = 12;
export const TUNNEL_PROTOCOL_VERSION = 1;

const REQUEST_MAGIC = new TextEncoder().encode("SBXTUN1\0");
const RESPONSE_MAGIC = new TextEncoder().encode("SBXACK1\0");

export enum TunnelStatus {
  Ok = 0,
  AuthenticationFailed = 1,
  SupervisorUnavailable = 2,
  DialFailed = 3,
  ProtocolError = 4,
  CapacityExceeded = 5,
  InternalError = 255,
}

const KNOWN_STATUSES = new Set<number>(
  Object.values(TunnelStatus).filter(
    (value): value is number => typeof value === "number",
  ),
);

export class TunnelPrefaceError extends Error {
  readonly code = "SBX_TUNNEL_PREFACE";

  constructor(message: string) {
    super(message);
    this.name = "TunnelPrefaceError";
  }
}

export interface TunnelRequest {
  version: 1;
  flags: 0;
  ticket: Uint8Array;
}

export interface TunnelResponse {
  status: TunnelStatus;
}

export interface TunnelPrefaceReader {
  read(destination: Uint8Array): Promise<number | null>;
  close(): void;
}

export interface ReadTunnelPrefaceOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function encodeTunnelRequest(ticket: Uint8Array): Uint8Array {
  if (ticket.byteLength !== 32) {
    throw new RangeError("tunnel ticket must be exactly 32 bytes");
  }
  const output = new Uint8Array(TUNNEL_REQUEST_BYTES);
  output.set(REQUEST_MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(8, TUNNEL_PROTOCOL_VERSION);
  view.setUint16(10, 0);
  output.set(ticket, 12);
  return output;
}

export function decodeTunnelRequest(input: Uint8Array): TunnelRequest {
  if (input.byteLength !== TUNNEL_REQUEST_BYTES) {
    throw new TunnelPrefaceError("tunnel request must be exactly 44 bytes");
  }
  if (!equalBytes(input.subarray(0, 8), REQUEST_MAGIC)) {
    throw new TunnelPrefaceError("invalid tunnel request magic");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = view.getUint16(8);
  const flags = view.getUint16(10);
  if (version !== TUNNEL_PROTOCOL_VERSION) {
    throw new TunnelPrefaceError(
      `unsupported tunnel protocol version ${version}`,
    );
  }
  if (flags !== 0) {
    throw new TunnelPrefaceError("tunnel request flags must be zero");
  }
  return { version: 1, flags: 0, ticket: input.slice(12, 44) };
}

/**
 * Read only the fixed request bytes, retaining any pipelined Cap'n Proto data
 * in the connection. A stalled or cancelled connection is closed so no
 * unresolved read remains behind.
 */
export async function readTunnelRequest(
  reader: TunnelPrefaceReader,
  options: ReadTunnelPrefaceOptions = {},
): Promise<TunnelRequest> {
  const bytes = await readExactly(
    reader,
    TUNNEL_REQUEST_BYTES,
    options.timeoutMs ?? 5_000,
    "tunnel request",
    options.signal,
  );
  return decodeTunnelRequest(bytes);
}

export function encodeTunnelResponse(status: TunnelStatus): Uint8Array {
  if (!KNOWN_STATUSES.has(status)) {
    throw new RangeError(`unknown tunnel status ${status}`);
  }
  const output = new Uint8Array(TUNNEL_RESPONSE_BYTES);
  output.set(RESPONSE_MAGIC, 0);
  new DataView(output.buffer).setUint16(8, status);
  return output;
}

export function decodeTunnelResponse(input: Uint8Array): TunnelResponse {
  if (input.byteLength !== TUNNEL_RESPONSE_BYTES) {
    throw new TunnelPrefaceError("tunnel response must be exactly 12 bytes");
  }
  if (!equalBytes(input.subarray(0, 8), RESPONSE_MAGIC)) {
    throw new TunnelPrefaceError("invalid tunnel response magic");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const status = view.getUint16(8);
  if (view.getUint16(10) !== 0) {
    throw new TunnelPrefaceError("tunnel response reserved bytes must be zero");
  }
  if (!KNOWN_STATUSES.has(status)) {
    throw new TunnelPrefaceError(`unknown tunnel status ${status}`);
  }
  return { status: status as TunnelStatus };
}

/** Read the fixed response without consuming the first agent-RPC byte. */
export async function readTunnelResponse(
  reader: TunnelPrefaceReader,
  options: ReadTunnelPrefaceOptions = {},
): Promise<TunnelResponse> {
  const bytes = await readExactly(
    reader,
    TUNNEL_RESPONSE_BYTES,
    options.timeoutMs ?? 12_000,
    "tunnel response",
    options.signal,
  );
  return decodeTunnelResponse(bytes);
}

async function readExactly(
  reader: TunnelPrefaceReader,
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
      () => stop(new TunnelPrefaceError(`${label} deadline exceeded`)),
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
        throw new TunnelPrefaceError(`${label} ended before ${length} bytes`);
      }
      if (
        !Number.isSafeInteger(count) || count <= 0 ||
        count > output.byteLength - offset
      ) {
        throw new TunnelPrefaceError(
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
