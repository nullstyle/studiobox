import { InvalidMemoryError } from "./errors.ts";

/** Upstream-compatible memory size grammar. */
export type Memory =
  | number
  | `${number}GB`
  | `${number}MB`
  | `${number}kB`
  | `${number}GiB`
  | `${number}MiB`
  | `${number}KiB`;

const MEBIBYTE = 1024 * 1024;
const MIN_MEMORY_MIB = 768;
const MAX_MEMORY_MIB = 4096;
const MEMORY_PATTERN = /^(\d+(?:\.\d+)?)(GB|MB|kB|GiB|MiB|KiB)$/;
const UNITS: Record<string, number> = {
  GiB: 1024 ** 3,
  MiB: 1024 ** 2,
  KiB: 1024,
  GB: 1000 ** 3,
  MB: 1000 ** 2,
  kB: 1000,
};

/** Parse and validate the upstream 768 MiB–4 GiB memory contract. */
export function parseMemory(value: Memory): number {
  let mib: number;
  if (typeof value === "number") {
    mib = Math.floor(value / MEBIBYTE);
  } else {
    const match = MEMORY_PATTERN.exec(value);
    if (!match) {
      throw new InvalidMemoryError(`Invalid memory format: ${value}`);
    }
    mib = Math.floor((Number(match[1]) * UNITS[match[2]]) / MEBIBYTE);
  }

  if (mib < MIN_MEMORY_MIB || mib > MAX_MEMORY_MIB) {
    throw new InvalidMemoryError(
      `Memory value ${mib} MiB is out of range. It must be between ${MIN_MEMORY_MIB} MiB and ${MAX_MEMORY_MIB} MiB.`,
    );
  }
  return mib;
}
