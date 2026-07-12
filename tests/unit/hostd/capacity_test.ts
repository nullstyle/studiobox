import { assertEquals, assertRejects } from "@std/assert";
import {
  CapacityLedger,
  type CapacityLedgerOptions,
  HostCapacityExhaustedError,
  VCPUS_PER_SANDBOX,
} from "../../../src/hostd/capacity.ts";
import {
  HostCapacityError,
  InvalidMemoryError,
} from "../../../src/api/errors.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// A roomy host that never binds on vCPU/sandbox count, so a single-dimension
// exhaustion test isolates the dimension under test.
function roomy(options: CapacityLedgerOptions = {}): CapacityLedger {
  return new CapacityLedger({
    budget: {
      vcpus: 64,
      memoryMiB: 64 * 1024,
      diskBytes: 512 * GIB,
      portRange: { start: 30_000, end: 30_064 },
    },
    headroom: { vcpus: 0, memoryMiB: 0, diskBytes: 0 },
    ...options,
  });
}

Deno.test("reserve within budget commits and capacity reflects it", async () => {
  const ledger = roomy();
  const before = ledger.capacity();
  assertEquals(before.vcpusCommitted, 0);
  assertEquals(before.memoryCommittedMiB, 0);
  assertEquals(before.sandboxCount, 0);

  const handle = await ledger.reserve({
    memory: "1GiB",
    diskBytes: 2 * GIB,
    ports: 1,
  });
  assertEquals(handle.memoryMiB, 1024);
  assertEquals(handle.vcpus, VCPUS_PER_SANDBOX);
  assertEquals(handle.diskBytes, 2 * GIB);
  assertEquals(handle.ports.length, 1);

  const after = ledger.capacity();
  assertEquals(after.vcpusCommitted, VCPUS_PER_SANDBOX);
  assertEquals(after.memoryCommittedMiB, 1024);
  assertEquals(after.diskCommittedBytes, 2 * GIB);
  assertEquals(after.portsCommitted, 1);
  assertEquals(after.sandboxCount, 1);

  const usage = ledger.usage(handle);
  assertEquals(usage, {
    memoryMiB: 1024,
    vcpus: VCPUS_PER_SANDBOX,
    diskBytes: 2 * GIB,
    ports: handle.ports.slice(),
  });
});

Deno.test("reserve accepts a numeric-byte memory value via parseMemory", async () => {
  const ledger = roomy();
  const handle = await ledger.reserve({
    memory: 1024 * MIB,
    diskBytes: 0,
  });
  assertEquals(handle.memoryMiB, 1024);
});

Deno.test("reserve rejects out-of-range memory before touching the ledger", async () => {
  const ledger = roomy();
  await assertRejects(
    () => ledger.reserve({ memory: "256MiB", diskBytes: 0 }),
    InvalidMemoryError,
  );
  await assertRejects(
    () => ledger.reserve({ memory: "8GiB", diskBytes: 0 }),
    InvalidMemoryError,
  );
  assertEquals(ledger.capacity().sandboxCount, 0);
});

Deno.test("a reservation exceeding the memory budget fails fast and typed", async () => {
  const ledger = roomy({
    budget: {
      vcpus: 64,
      memoryMiB: 1024, // room for exactly one 768 MiB sandbox
      diskBytes: 512 * GIB,
      portRange: { start: 30_000, end: 30_064 },
    },
  });
  await ledger.reserve({ memory: "768MiB", diskBytes: 0 });
  const error = await assertRejects(
    () => ledger.reserve({ memory: "768MiB", diskBytes: 0 }),
    HostCapacityExhaustedError,
  );
  assertEquals(error.dimension, "memory");
  // It is also a plain HostCapacityError for existing catch sites.
  assertEquals(error instanceof HostCapacityError, true);
  assertEquals(ledger.capacity().sandboxCount, 1);
});

Deno.test("a reservation exceeding the vCPU budget fails fast and typed", async () => {
  const ledger = roomy({
    budget: {
      vcpus: VCPUS_PER_SANDBOX, // one sandbox worth
      memoryMiB: 64 * 1024,
      diskBytes: 512 * GIB,
      portRange: { start: 30_000, end: 30_064 },
    },
  });
  await ledger.reserve({ memory: "768MiB", diskBytes: 0 });
  const error = await assertRejects(
    () => ledger.reserve({ memory: "768MiB", diskBytes: 0 }),
    HostCapacityExhaustedError,
  );
  assertEquals(error.dimension, "vcpu");
});

Deno.test("a reservation exceeding the disk budget fails fast and typed", async () => {
  const ledger = roomy({
    budget: {
      vcpus: 64,
      memoryMiB: 64 * 1024,
      diskBytes: 4 * GIB,
      portRange: { start: 30_000, end: 30_064 },
    },
  });
  await ledger.reserve({ memory: "768MiB", diskBytes: 3 * GIB });
  const error = await assertRejects(
    () => ledger.reserve({ memory: "768MiB", diskBytes: 3 * GIB }),
    HostCapacityExhaustedError,
  );
  assertEquals(error.dimension, "disk");
});

Deno.test("a reservation exceeding the port range fails fast and typed", async () => {
  const ledger = roomy({
    budget: {
      vcpus: 64,
      memoryMiB: 64 * 1024,
      diskBytes: 512 * GIB,
      portRange: { start: 30_000, end: 30_002 }, // two ports
    },
  });
  await ledger.reserve({ memory: "768MiB", diskBytes: 0, ports: 2 });
  const error = await assertRejects(
    () => ledger.reserve({ memory: "768MiB", diskBytes: 0, ports: 1 }),
    HostCapacityExhaustedError,
  );
  assertEquals(error.dimension, "ports");
  // The failed reservation committed nothing: the two ports are still the only
  // ones held, and no sandbox slot was consumed by the rejected request.
  assertEquals(ledger.capacity().portsCommitted, 2);
  assertEquals(ledger.capacity().sandboxCount, 1);
});

Deno.test("release frees exactly the reservation's resources", async () => {
  const ledger = roomy();
  const a = await ledger.reserve({
    memory: "1GiB",
    diskBytes: 4 * GIB,
    ports: 2,
  });
  const b = await ledger.reserve({
    memory: "2GiB",
    diskBytes: 8 * GIB,
    ports: 3,
  });

  const committed = ledger.capacity();
  assertEquals(committed.memoryCommittedMiB, 1024 + 2048);
  assertEquals(committed.vcpusCommitted, 2 * VCPUS_PER_SANDBOX);
  assertEquals(committed.diskCommittedBytes, 12 * GIB);
  assertEquals(committed.portsCommitted, 5);
  assertEquals(committed.sandboxCount, 2);

  await ledger.release(a);
  const afterA = ledger.capacity();
  // Exactly a's resources are gone; b's remain untouched.
  assertEquals(afterA.memoryCommittedMiB, 2048);
  assertEquals(afterA.vcpusCommitted, VCPUS_PER_SANDBOX);
  assertEquals(afterA.diskCommittedBytes, 8 * GIB);
  assertEquals(afterA.portsCommitted, 3);
  assertEquals(afterA.sandboxCount, 1);
  assertEquals(ledger.usage(a), null);
  assertEquals(ledger.usage(b)?.memoryMiB, 2048);

  // Double release is a no-op and cannot touch b.
  await ledger.release(a);
  assertEquals(ledger.capacity().portsCommitted, 3);
  assertEquals(ledger.capacity().sandboxCount, 1);
});

Deno.test("port allocation hands out distinct ports and reclaims freed ones", async () => {
  const ledger = roomy({
    budget: {
      vcpus: 64,
      memoryMiB: 64 * 1024,
      diskBytes: 512 * GIB,
      portRange: { start: 40_000, end: 40_004 }, // exactly four ports
    },
  });
  const a = await ledger.reserve({ memory: "768MiB", diskBytes: 0, ports: 2 });
  const b = await ledger.reserve({ memory: "768MiB", diskBytes: 0, ports: 2 });

  // Distinct across reservations, and drawn from the configured range.
  const all = [...a.ports, ...b.ports];
  assertEquals(new Set(all).size, 4);
  for (const port of all) {
    assertEquals(port >= 40_000 && port < 40_004, true);
  }

  // Range is exhausted; the next port request fails.
  const error = await assertRejects(
    () => ledger.reserve({ memory: "768MiB", diskBytes: 0, ports: 1 }),
    HostCapacityExhaustedError,
  );
  assertEquals(error.dimension, "ports");

  // Freeing a returns its ports to the pool for reuse.
  await ledger.release(a);
  const c = await ledger.reserve({ memory: "768MiB", diskBytes: 0, ports: 2 });
  assertEquals(c.ports.slice().sort(), a.ports.slice().sort());
});

Deno.test("concurrent reserves are serialized: two racers cannot both take the last slot", async () => {
  // Budget leaves room for exactly one sandbox. A barrier that yields inside
  // the critical section would let a second reserve observe pre-commit state
  // and double-book — the mutex must prevent that.
  let entered = 0;
  let unblock = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });

  const ledger = new CapacityLedger({
    budget: {
      vcpus: 64, // vCPU / sandbox limits stay slack; memory is the last slot
      memoryMiB: 768, // room for exactly one 768 MiB sandbox
      diskBytes: 64 * GIB,
      portRange: { start: 30_000, end: 30_064 },
    },
    headroom: { vcpus: 0, memoryMiB: 0, diskBytes: 0 },
    admissionBarrier: async () => {
      entered++;
      // First entrant parks on the gate; if the mutex were absent the second
      // reserve would enter here concurrently and both would commit.
      if (entered === 1) await gate;
    },
  });

  const first = ledger.reserve({ memory: "768MiB", diskBytes: 0 });
  const second = ledger.reserve({ memory: "768MiB", diskBytes: 0 });

  // Give both promises a chance to run; only one can be inside the barrier.
  await Promise.resolve();
  assertEquals(entered, 1);

  unblock();
  const results = await Promise.allSettled([first, second]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assertEquals(fulfilled.length, 1);
  assertEquals(rejected.length, 1);
  const reason = (rejected[0] as PromiseRejectedResult).reason;
  assertEquals(reason instanceof HostCapacityExhaustedError, true);
  assertEquals((reason as HostCapacityExhaustedError).dimension, "memory");
  assertEquals(ledger.capacity().sandboxCount, 1);
});

Deno.test("headroom is subtracted from the raw budget", () => {
  const ledger = new CapacityLedger({
    budget: {
      vcpus: 4,
      memoryMiB: 8 * 1024,
      diskBytes: 60 * GIB,
      portRange: { start: 20_000, end: 20_010 },
    },
    headroom: { vcpus: 0, memoryMiB: 512, diskBytes: 2 * GIB },
  });
  const cap = ledger.capacity();
  assertEquals(cap.memoryTotalMiB, 8 * 1024 - 512);
  assertEquals(cap.diskTotalBytes, 60 * GIB - 2 * GIB);
  assertEquals(cap.vcpusTotal, 4);
  assertEquals(cap.sandboxLimit, 2); // floor(4 / 2)
  assertEquals(cap.portsTotal, 10);
});

Deno.test("maxSandboxes caps below the vCPU-derived limit", async () => {
  const ledger = new CapacityLedger({
    budget: {
      vcpus: 64,
      memoryMiB: 64 * 1024,
      diskBytes: 512 * GIB,
      portRange: { start: 30_000, end: 30_064 },
    },
    headroom: { vcpus: 0, memoryMiB: 0, diskBytes: 0 },
    maxSandboxes: 1,
  });
  assertEquals(ledger.capacity().sandboxLimit, 1);
  await ledger.reserve({ memory: "768MiB", diskBytes: 0 });
  const error = await assertRejects(
    () => ledger.reserve({ memory: "768MiB", diskBytes: 0 }),
    HostCapacityExhaustedError,
  );
  assertEquals(error.dimension, "sandboxes");
});

Deno.test("construction rejects headroom that exceeds the budget", () => {
  let threw = false;
  try {
    new CapacityLedger({
      budget: {
        vcpus: 2,
        memoryMiB: 1024,
        diskBytes: GIB,
        portRange: { start: 20_000, end: 20_010 },
      },
      headroom: { vcpus: 0, memoryMiB: 2048, diskBytes: 0 },
    });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assertEquals(threw, true);
});
