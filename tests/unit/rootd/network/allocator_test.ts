import { assertEquals, assertThrows } from "@std/assert";
import {
  BitmapSubnetAllocator,
  type SubnetAllocation,
  subnetForSlot,
  SubnetPoolExhaustedError,
} from "../../../../src/rootd/network/allocator.ts";

/** Total /30 slots in the default 10.201.0.0/16 pool. */
const SLOT_COUNT = 16384;

Deno.test("subnetForSlot computes exact addresses / mac / tap for slot 0", () => {
  assertEquals(
    subnetForSlot(0),
    {
      slot: 0,
      tapName: "sbxtap0",
      subnet: "10.201.0.0/30",
      hostIp: "10.201.0.1",
      guestIp: "10.201.0.2",
      guestCidr: "10.201.0.2/30",
      guestMac: "02:00:0a:c9:00:02",
    } satisfies SubnetAllocation,
  );
});

Deno.test("subnetForSlot computes exact addresses for the last slot of a third-octet (63)", () => {
  // third = 63>>6 = 0, base4 = (63&63)<<2 = 252.
  assertEquals(
    subnetForSlot(63),
    {
      slot: 63,
      tapName: "sbxtap63",
      subnet: "10.201.0.252/30",
      hostIp: "10.201.0.253",
      guestIp: "10.201.0.254",
      guestCidr: "10.201.0.254/30",
      guestMac: "02:00:0a:c9:00:fe",
    } satisfies SubnetAllocation,
  );
});

Deno.test("subnetForSlot rolls the third octet at slot 64", () => {
  // third = 64>>6 = 1, base4 = (64&63)<<2 = 0.
  assertEquals(
    subnetForSlot(64),
    {
      slot: 64,
      tapName: "sbxtap64",
      subnet: "10.201.1.0/30",
      hostIp: "10.201.1.1",
      guestIp: "10.201.1.2",
      guestCidr: "10.201.1.2/30",
      guestMac: "02:00:0a:c9:01:02",
    } satisfies SubnetAllocation,
  );
});

Deno.test("subnetForSlot computes exact addresses for the top slot (16383)", () => {
  // third = 16383>>6 = 255, base4 = (16383&63)<<2 = 252.
  assertEquals(
    subnetForSlot(16383),
    {
      slot: 16383,
      tapName: "sbxtap16383",
      subnet: "10.201.255.252/30",
      hostIp: "10.201.255.253",
      guestIp: "10.201.255.254",
      guestCidr: "10.201.255.254/30",
      guestMac: "02:00:0a:c9:ff:fe",
    } satisfies SubnetAllocation,
  );
});

Deno.test("the TAP name is always <= 15 chars (IFNAMSIZ) and regex-safe", () => {
  const longest = subnetForSlot(16383).tapName;
  assertEquals(longest, "sbxtap16383");
  assertEquals(longest.length, 11);
});

Deno.test("subnetForSlot honours an overridden /16 pool CIDR (prefix drives the MAC)", () => {
  // 10 -> 0a, 50 -> 32, third 0 -> 00, guest .2 -> 02.
  assertEquals(
    subnetForSlot(0, "10.50.0.0/16"),
    {
      slot: 0,
      tapName: "sbxtap0",
      subnet: "10.50.0.0/30",
      hostIp: "10.50.0.1",
      guestIp: "10.50.0.2",
      guestCidr: "10.50.0.2/30",
      guestMac: "02:00:0a:32:00:02",
    } satisfies SubnetAllocation,
  );
});

Deno.test("subnetForSlot rejects an out-of-range slot and a non-/16 pool", () => {
  assertThrows(() => subnetForSlot(-1), RangeError);
  assertThrows(() => subnetForSlot(SLOT_COUNT), RangeError);
  assertThrows(() => subnetForSlot(0, "10.201.0.0/24"), RangeError);
  assertThrows(() => subnetForSlot(0, "not-a-cidr"), RangeError);
});

Deno.test("a non-/16 pool is rejected at construction", () => {
  assertThrows(
    () => new BitmapSubnetAllocator({ poolCidr: "10.0.0.0/8" }),
    RangeError,
  );
});

Deno.test("allocate hands out the lowest free slot, matching subnetForSlot", () => {
  const alloc = new BitmapSubnetAllocator();
  assertEquals(alloc.allocate("exec-a"), subnetForSlot(0));
  assertEquals(alloc.allocate("exec-b"), subnetForSlot(1));
  assertEquals(alloc.allocate("exec-c"), subnetForSlot(2));
  assertEquals(alloc.inUse, 3);
});

Deno.test("allocate reuses the lowest freed slot after release", () => {
  const alloc = new BitmapSubnetAllocator();
  alloc.allocate("exec-a"); // slot 0
  alloc.allocate("exec-b"); // slot 1
  alloc.allocate("exec-c"); // slot 2
  alloc.release(1);
  assertEquals(alloc.inUse, 2);
  // The lowest free slot is now 1 again — it is reused before slot 3.
  assertEquals(alloc.allocate("exec-d").slot, 1);
  assertEquals(alloc.allocate("exec-e").slot, 3);
});

Deno.test("reserve marks a slot in-use so allocate skips it (cold reconcile)", () => {
  const alloc = new BitmapSubnetAllocator();
  alloc.reserve(0);
  alloc.reserve(2);
  assertEquals(alloc.inUse, 2);
  // Lowest free skips the two reserved slots.
  assertEquals(alloc.allocate("exec-a").slot, 1);
  assertEquals(alloc.allocate("exec-b").slot, 3);
  assertEquals(alloc.allocate("exec-c").slot, 4);
});

Deno.test("double-free and double-reserve are idempotent no-ops", () => {
  const alloc = new BitmapSubnetAllocator();
  alloc.allocate("exec-a"); // slot 0
  alloc.release(0);
  alloc.release(0); // second free must not underflow the counter
  assertEquals(alloc.inUse, 0);

  alloc.reserve(5);
  alloc.reserve(5); // second reserve must not double-count
  assertEquals(alloc.inUse, 1);

  // Freeing a never-allocated slot is a no-op, not an error.
  alloc.release(9);
  assertEquals(alloc.inUse, 1);
});

Deno.test("release / reserve reject an out-of-range slot", () => {
  const alloc = new BitmapSubnetAllocator();
  assertThrows(() => alloc.release(-1), RangeError);
  assertThrows(() => alloc.reserve(SLOT_COUNT), RangeError);
});

Deno.test("allocate throws SBX_NET_EXHAUSTED on a full pool", () => {
  const alloc = new BitmapSubnetAllocator();
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    alloc.reserve(slot);
  }
  assertEquals(alloc.inUse, SLOT_COUNT);
  const error = assertThrows(
    () => alloc.allocate("exec-overflow"),
    SubnetPoolExhaustedError,
  );
  assertEquals(error.code, "SBX_NET_EXHAUSTED");
});
