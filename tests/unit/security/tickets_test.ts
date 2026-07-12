import { assertEquals, assertRejects } from "@std/assert";
import {
  SingleUseTicketStore,
  TicketCapacityError,
  TicketRejectedError,
} from "../../../src/security/tickets.ts";

const binding = {
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  bootNonce: "boot-1",
  leaseGeneration: 7,
};

Deno.test("ticket consumption is single-use under concurrency", async () => {
  let now = 1_000;
  const tickets = new SingleUseTicketStore({ now: () => now });
  const issued = await tickets.issue(binding);
  assertEquals(issued.ticket.byteLength, 32);
  assertEquals(issued.expiresAt, 16_000);

  const outcomes = await Promise.allSettled([
    tickets.consume(issued.ticket, binding),
    tickets.consume(issued.ticket, binding),
  ]);
  assertEquals(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assertEquals(
    outcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
  );
  now = 2_000;
});

Deno.test("tickets reject wrong bindings, expiry, and replay identically", async () => {
  let now = 5_000;
  const tickets = new SingleUseTicketStore({ now: () => now });
  const wrongBindingTicket = await tickets.issue(binding);
  await assertRejects(
    () =>
      tickets.consume(wrongBindingTicket.ticket, {
        ...binding,
        leaseGeneration: 8,
      }),
    TicketRejectedError,
    "ticket rejected",
  );

  const expired = await tickets.issue(binding);
  now = expired.expiresAt + 1;
  await assertRejects(
    () => tickets.consume(expired.ticket, binding),
    TicketRejectedError,
    "ticket rejected",
  );
  await assertRejects(
    () => tickets.consume(expired.ticket, binding),
    TicketRejectedError,
    "ticket rejected",
  );
});

Deno.test("a ticket replayed at another endpoint is rejected WITHOUT being burned", async () => {
  // The M8 daemon-level tunnel shares ONE SingleUseTicketStore across every
  // sandbox in a HostControlCore, so sandbox B's tunnel endpoint calls
  // consume() against the same store that holds sandbox A's ticket. An
  // attacker who possesses A's ticket must not be able to burn it by presenting
  // it at B's endpoint (a cross-endpoint griefing/denial); the burn is gated on
  // the ticket's binding, so A can still redeem its own ticket afterward.
  const tickets = new SingleUseTicketStore();
  const bindingA = {
    sessionId: "lease-A",
    sandboxId: "sbx_loc_aaaaaaaaaaaaaaaaaaaa",
    bootNonce: "boot-A",
    leaseGeneration: 3,
  };
  const bindingB = {
    sessionId: "lease-B",
    sandboxId: "sbx_loc_bbbbbbbbbbbbbbbbbbbb",
    bootNonce: "boot-B",
    leaseGeneration: 3,
  };
  const issuedA = await tickets.issue(bindingA);
  assertEquals(tickets.size, 1);

  // Attacker replays A's valid ticket at sandbox B's tunnel endpoint. Rejected,
  // and — critically — A's ticket is NOT consumed: the store still holds it.
  await assertRejects(
    () => tickets.consume(issuedA.ticket, bindingB),
    TicketRejectedError,
  );
  assertEquals(tickets.size, 1);

  // A's legitimate holder can still open its own tunnel with the same ticket.
  await tickets.consume(issuedA.ticket, bindingA);
  assertEquals(tickets.size, 0);

  // And it remains strictly single-use: a second legitimate redeem fails.
  await assertRejects(
    () => tickets.consume(issuedA.ticket, bindingA),
    TicketRejectedError,
  );
});

Deno.test("cross-endpoint replay cannot be used to drain another sandbox's tickets", async () => {
  // Belt-and-suspenders on the griefing vector: repeatedly presenting A's
  // ticket at B's endpoint must never reduce A's outstanding-ticket count.
  const tickets = new SingleUseTicketStore();
  const bindingA = {
    sessionId: "lease-A",
    sandboxId: "sbx_loc_aaaaaaaaaaaaaaaaaaaa",
    bootNonce: "boot-A",
    leaseGeneration: 1,
  };
  const bindingB = { ...bindingA, sandboxId: "sbx_loc_bbbbbbbbbbbbbbbbbbbb" };
  const issuedA = await tickets.issue(bindingA);
  for (let attempt = 0; attempt < 5; attempt++) {
    await assertRejects(
      () => tickets.consume(issuedA.ticket, bindingB),
      TicketRejectedError,
    );
  }
  assertEquals(tickets.size, 1);
  await tickets.consume(issuedA.ticket, bindingA);
});

Deno.test("issue rejects once the outstanding-ticket capacity is reached", async () => {
  let now = 1_000;
  const tickets = new SingleUseTicketStore({
    now: () => now,
    maxOutstanding: 2,
  });
  const first = await tickets.issue({ ...binding, sessionId: "lease-1" });
  await tickets.issue({ ...binding, sessionId: "lease-2" });
  assertEquals(tickets.size, 2);

  // The third outstanding ticket is refused with the typed capacity error —
  // the rate limit that bounds how many tunnels a client can hold open at once.
  await assertRejects(
    () => tickets.issue({ ...binding, sessionId: "lease-3" }),
    TicketCapacityError,
    "outstanding tunnel ticket limit 2 reached",
  );
  assertEquals(tickets.size, 2);

  // Consuming one frees a slot, so a fresh issue succeeds again — the limit
  // bounds concurrency, it is not a permanent ceiling.
  await tickets.consume(first.ticket, { ...binding, sessionId: "lease-1" });
  assertEquals(tickets.size, 1);
  await tickets.issue({ ...binding, sessionId: "lease-3" });
  assertEquals(tickets.size, 2);

  // Expiry also frees capacity: advancing past the TTL lets issue() sweep the
  // outstanding tickets before enforcing the limit.
  now += 20_000;
  await tickets.issue({ ...binding, sessionId: "lease-4" });
  assertEquals(tickets.size, 1);
});

Deno.test("revoking a sandbox burns all of its outstanding tickets", async () => {
  const tickets = new SingleUseTicketStore();
  const first = await tickets.issue(binding);
  const second = await tickets.issue({ ...binding, sessionId: "session-2" });
  assertEquals(tickets.revokeSandbox(binding.sandboxId), 2);
  await assertRejects(
    () => tickets.consume(first.ticket, binding),
    TicketRejectedError,
  );
  await assertRejects(
    () =>
      tickets.consume(second.ticket, { ...binding, sessionId: "session-2" }),
    TicketRejectedError,
  );
});
