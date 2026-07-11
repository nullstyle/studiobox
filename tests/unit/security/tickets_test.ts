import { assertEquals, assertRejects } from "@std/assert";
import {
  SingleUseTicketStore,
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
