// M6: the studiobox-hostd -> studiobox-rootd supervisor CLIENT
// (src/hostd/supervisor_client.ts), driven end-to-end over a real Unix-domain
// socket against a FAKE in-process SupervisorApi served through the REAL
// supervisor.capnp wire adapter (src/rootd/service.ts + main.ts). macOS-safe:
// no VMM, no jailer, no KVM.
//
// Covered here:
//   - the bounded fail-closed handshake (negotiate -> authenticate ->
//     supervisor()) and launch/status/usage/kill/reconcile/ping round-trips
//     through the generated codecs and result unions;
//   - the wire SbxError -> typed SupervisorError decode (the exact
//     SupervisorErrorCode recovered from details.supervisorCode);
//   - a wrong credential surfaces the typed unavailable error, not a hang;
//   - the pinned M1 ownership contract on the dial leg: a peer that closes mid
//     -session surfaces the next call as a typed rejection (never a hang).

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  buildSupervisorContractIdentity,
  type SupervisorCompatIdentitySource,
} from "../../../src/rootd/service.ts";
import {
  startSupervisorServer,
  type SupervisorServerHandle,
} from "../../../src/rootd/main.ts";
import {
  type SupervisorApi,
  SupervisorError,
  type SupervisorHealth,
  type SupervisorLaunchRequest,
  type SupervisorMachineStatus,
  type SupervisorMachineUsage,
  type SupervisorReconcileSummary,
} from "../../../src/rootd/supervisor_core_api.ts";
import {
  connectSupervisorSession,
  type SupervisorSession,
} from "../../../src/hostd/supervisor_client.ts";
import type { ContractIdentity } from "../../../src/wire/contract.ts";

const TIMEOUT_MS = 5_000;

const ZERO_USAGE: SupervisorMachineUsage = {
  cpuTimeMicros: 0,
  memoryCurrentBytes: 0,
  memoryPeakBytes: 0,
  diskBytes: 0,
  rxBytes: 0,
  txBytes: 0,
};

/** A minimal in-process SupervisorApi the rootd wire adapter serves. */
class FakeSupervisorApi implements SupervisorApi {
  readonly machines = new Map<string, SupervisorMachineStatus>();
  readonly killed: string[] = [];

  launch(request: SupervisorLaunchRequest): Promise<SupervisorMachineStatus> {
    if (this.machines.has(request.executionId)) {
      return Promise.reject(
        new SupervisorError("SBX_SUP_DUPLICATE", "execution already journaled"),
      );
    }
    const status: SupervisorMachineStatus = {
      sandboxId: request.sandboxId,
      executionId: request.executionId,
      state: "running",
      pid: 4321,
    };
    this.machines.set(request.executionId, status);
    return Promise.resolve(status);
  }

  status(executionId: string): Promise<SupervisorMachineStatus> {
    const status = this.machines.get(executionId);
    if (status === undefined) {
      return Promise.reject(
        new SupervisorError("SBX_SUP_NOT_FOUND", "no such execution"),
      );
    }
    return Promise.resolve(status);
  }

  usage(executionId: string): Promise<SupervisorMachineUsage> {
    if (!this.machines.has(executionId)) {
      return Promise.reject(
        new SupervisorError("SBX_SUP_NOT_FOUND", "no such execution"),
      );
    }
    return Promise.resolve(ZERO_USAGE);
  }

  probeAgent(): Promise<void> {
    return Promise.resolve();
  }

  openBridge(): Promise<never> {
    return Promise.reject(
      new SupervisorError("SBX_SUP_STATE", "no bridge in the fake"),
    );
  }

  shutdown(executionId: string): Promise<void> {
    return this.kill(executionId);
  }

  kill(executionId: string): Promise<void> {
    this.machines.delete(executionId);
    this.killed.push(executionId);
    return Promise.resolve();
  }

  reconcile(): Promise<SupervisorReconcileSummary> {
    const killed = this.machines.size;
    this.machines.clear();
    return Promise.resolve({
      examined: killed,
      killed,
      reclaimed: killed,
      quarantined: 0,
      failures: [],
    });
  }

  health(): Promise<SupervisorHealth> {
    return Promise.resolve({
      buildId: "fake",
      startedAtUnixMs: 0,
      activeMachines: this.machines.size,
      activeBridges: 0,
      reconciling: false,
    });
  }

  ping(nonce: bigint): Promise<bigint> {
    return Promise.resolve(nonce);
  }
}

interface Harness {
  readonly api: FakeSupervisorApi;
  readonly identity: ContractIdentity;
  readonly credential: Uint8Array;
  readonly server: SupervisorServerHandle;
  readonly socketPath: string;
}

async function loadCompat(): Promise<SupervisorCompatIdentitySource> {
  const text = await Deno.readTextFile(
    new URL("../../../compat/wire.json", import.meta.url),
  );
  return JSON.parse(text) as SupervisorCompatIdentitySource;
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-hcl-" });
  let server: SupervisorServerHandle | undefined;
  try {
    const api = new FakeSupervisorApi();
    const identity = await buildSupervisorContractIdentity(await loadCompat(), {
      buildId: "hostd-client-test",
    });
    const credential = crypto.getRandomValues(new Uint8Array(32));
    const socketPath = join(dir, "r.sock");
    server = await startSupervisorServer({
      socketPath,
      api,
      identity,
      credential,
    });
    await run({ api, identity, credential, server, socketPath });
  } finally {
    await server?.close().catch(() => {});
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function launchRequest(suffix: string): SupervisorLaunchRequest {
  return {
    sandboxId: `sbx-${suffix}`,
    executionId: `exec-${suffix}`,
    artifactId: "artifact-loc",
    allocationId: `alloc-${suffix}`,
    bootNonce: crypto.getRandomValues(new Uint8Array(32)),
    idempotencyKey: crypto.getRandomValues(new Uint8Array(16)),
  };
}

async function open(h: Harness): Promise<SupervisorSession> {
  return await connectSupervisorSession(h.socketPath, {
    identity: h.identity,
    credential: h.credential,
    timeoutMs: TIMEOUT_MS,
  });
}

Deno.test("hostd supervisor client: launch/status/usage/kill/reconcile/ping round-trip", async () => {
  await withHarness(async (h) => {
    const session = await open(h);
    try {
      assertEquals(await session.ping(77n), 77n);

      const status = await session.launch(launchRequest("a"));
      assertEquals(status.sandboxId, "sbx-a");
      assertEquals(status.executionId, "exec-a");
      assertEquals(status.state, "running");
      assertEquals(status.pid, 4321);

      const observed = await session.status("exec-a");
      assertEquals(observed.state, "running");

      const usage = await session.usage("exec-a");
      assertEquals(usage.cpuTimeMicros, 0);
      assertEquals(usage.memoryCurrentBytes, 0);

      await session.kill("exec-a");
      assertEquals(h.api.killed, ["exec-a"]);

      const summary = await session.reconcile();
      assertEquals(summary.examined, 0);
      assertEquals(summary.killed, 0);
    } finally {
      await session.close();
    }
  });
});

Deno.test("hostd supervisor client: wire SbxError decodes back to the typed SupervisorError code", async () => {
  await withHarness(async (h) => {
    const session = await open(h);
    try {
      // A vanished execution -> SBX_SUP_NOT_FOUND recovered from details.
      const notFound = await assertRejects(
        () => session.status("exec-missing"),
        SupervisorError,
      );
      assertEquals(notFound.code, "SBX_SUP_NOT_FOUND");

      // A duplicate launch -> SBX_SUP_DUPLICATE recovered from details.
      await session.launch(launchRequest("b"));
      const duplicate = await assertRejects(
        () => session.launch(launchRequest("b")),
        SupervisorError,
      );
      assertEquals(duplicate.code, "SBX_SUP_DUPLICATE");
    } finally {
      await session.close();
    }
  });
});

Deno.test("hostd supervisor client: a wrong credential surfaces the typed unavailable error, not a hang", async () => {
  await withHarness(async (h) => {
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    const error = await assertRejects(
      () =>
        connectSupervisorSession(h.socketPath, {
          identity: h.identity,
          credential: wrong,
          timeoutMs: TIMEOUT_MS,
        }),
      SupervisorError,
    );
    assertEquals(error.code, "SBX_SUP_UNAVAILABLE");
  });
});

Deno.test("hostd supervisor client: a peer that closes mid-session surfaces the next call as a typed rejection", async () => {
  await withHarness(async (h) => {
    const session = await open(h);
    try {
      // Sanity: the session works before rootd vanishes.
      assertEquals(await session.ping(1n), 1n);

      // rootd goes away out from under the client. The wired onClose settles
      // in-flight/next calls as typed rejections instead of hanging.
      await h.server.close();

      await assertRejects(() => session.ping(2n));
    } finally {
      await session.close();
    }
  });
});
