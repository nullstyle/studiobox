import { assertEquals, assertRejects } from "@std/assert";
import { TunnelAuthorizer } from "../../../src/hostd/tunnel_authorizer.ts";
import {
  SingleUseTicketStore,
  TicketRejectedError,
} from "../../../src/security/tickets.ts";

const binding = {
  sessionId: "control-1",
  sandboxId: "sandbox-1",
  bootNonce: "boot-1",
  leaseGeneration: 2,
};

Deno.test("hostd burns a ticket before asking the privileged supervisor to dial", async () => {
  const events: string[] = [];
  const tickets = new SingleUseTicketStore();
  const issued = await tickets.issue(binding);
  const authorizer = new TunnelAuthorizer(tickets, {
    openBridge(request): Promise<string> {
      events.push(`bridge:${request.sandboxId}:tickets=${tickets.size}`);
      return Promise.resolve("bridge-1");
    },
  });

  const bridge = await authorizer.authorizeAndOpen(
    issued.ticket,
    binding,
    { sandboxId: "sandbox-1", executionId: "exec-1", guestPort: 7000 },
  );
  assertEquals(events, ["bridge:sandbox-1:tickets=0"]);
  assertEquals(bridge, "bridge-1");
});

Deno.test("rejected tickets never cross the privilege boundary", async () => {
  let bridgeCalls = 0;
  const tickets = new SingleUseTicketStore();
  const issued = await tickets.issue(binding);
  const authorizer = new TunnelAuthorizer(tickets, {
    openBridge(): Promise<string> {
      bridgeCalls++;
      return Promise.resolve("unexpected");
    },
  });

  await assertRejects(
    () =>
      authorizer.authorizeAndOpen(
        issued.ticket,
        { ...binding, sessionId: "wrong-session" },
        { sandboxId: "sandbox-1", executionId: "exec-1", guestPort: 7000 },
      ),
    TicketRejectedError,
  );
  assertEquals(bridgeCalls, 0);
});
