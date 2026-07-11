import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { basename, join } from "@std/path";
import {
  makeFakeJailerBin,
  makeFakeVmmBin,
} from "@nullstyle/firecracker/testing";
import {
  FirecrackerAdapter,
  type JailedLaunchRequest,
} from "../../../src/rootd/firecracker/adapter.ts";
import { FirecrackerAdapterError } from "../../../src/rootd/firecracker/errors.ts";
import {
  CreateOnlyVmRegistry,
  EXECUTION_ID_METADATA,
  SANDBOX_ID_METADATA,
  SandboxStateJailRecordStore,
} from "../../../src/rootd/firecracker/registry.ts";
import {
  newSandboxRecord,
  type SandboxRecord,
} from "../../../src/state/model.ts";
import { JsonFileSandboxStore } from "../../../src/state/store.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ContractHarness {
  readonly adapter: FirecrackerAdapter;
  readonly registry: CreateOnlyVmRegistry;
  readonly state: JsonFileSandboxStore;
  readonly sandboxId: string;
}

interface LaunchFixture {
  readonly request: JailedLaunchRequest;
  readonly jailRoot: string;
  readonly stagedKernel: string;
  readonly sourceKernel: string;
}

async function withContractDir(
  operation: (dir: string) => Promise<void>,
): Promise<void> {
  // Keep the base short: the jail path is part of every Unix socket path,
  // whose host-side limit is only 104 bytes on macOS.
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "sbx-fc-" });
  try {
    await operation(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function makeHarness(
  dir: string,
  sandboxId: string,
): Promise<ContractHarness> {
  const state = new JsonFileSandboxStore(join(dir, "state.json"));
  await state.create(newSandboxRecord({
    id: sandboxId,
    createdAt: "2026-07-10T00:00:00.000Z",
  }));
  const registry = new CreateOnlyVmRegistry(
    new SandboxStateJailRecordStore(state, {
      now: () => "2026-07-10T00:00:01.000Z",
    }),
  );
  return {
    adapter: new FirecrackerAdapter({ registry }),
    registry,
    state,
    sandboxId,
  };
}

async function makeLaunchFixture(
  dir: string,
  sandboxId: string,
  executionId: string,
  mode: "ready" | "exit-before-bind",
  options: { echoPort?: number } = {},
): Promise<LaunchFixture> {
  const firecrackerBin = await makeFakeVmmBin(
    dir,
    mode,
    options.echoPort === undefined
      ? {}
      : { FAKE_VMM_ECHO_PORT: String(options.echoPort) },
  );
  const jailerBin = await makeFakeJailerBin(dir);
  const sourceKernel = join(dir, `${executionId}-vmlinux`);
  await Deno.writeTextFile(sourceKernel, "immutable kernel fixture\n");
  await Deno.chmod(sourceKernel, 0o744);

  const chrootBaseDir = join(dir, "j");
  const jailRoot = join(
    chrootBaseDir,
    basename(firecrackerBin),
    executionId,
  );
  const stagedKernel = join(jailRoot, "root", "vmlinux");
  return {
    request: {
      sandboxId,
      executionId,
      jailer: {
        jailerBin,
        firecrackerBin,
        uid: Deno.uid() ?? 0,
        gid: Deno.gid() ?? 0,
        chrootBaseDir,
      },
      stage: [{
        hostPath: sourceKernel,
        jailPath: "/vmlinux",
      }],
      config: {
        boot_source: { kernel_image_path: "/vmlinux" },
        ...(options.echoPort === undefined
          ? {}
          : { vsock: { guest_cid: 3, uds_path: "/v.sock" } }),
      },
      readinessTimeoutMs: 5_000,
    },
    jailRoot,
    stagedKernel,
    sourceKernel,
  };
}

async function writeAll(
  conn: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function readText(
  conn: { read(bytes: Uint8Array): Promise<number | null> },
  length: number,
): Promise<string> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await conn.read(bytes.subarray(offset));
    if (read === null) break;
    offset += read;
  }
  return decoder.decode(bytes.subarray(0, offset));
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  return await Deno.stat(path).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
}

function assertDistinctFiles(
  source: Deno.FileInfo,
  staged: Deno.FileInfo,
): void {
  if (
    source.dev !== null && source.ino !== null && staged.dev !== null &&
    staged.ino !== null
  ) {
    assertFalse(
      source.dev === staged.dev && source.ino === staged.ino,
      "the staged artifact must be a copy, not a hardlink to the source",
    );
  }
}

function assertJournalCleared(record: SandboxRecord | null): void {
  assert(record !== null);
  assert(record.machine !== undefined);
  assertEquals(record.machine.phase, "reclaiming");
  assertEquals(record.machine.jailRecord, undefined);
}

Deno.test(
  "Firecracker process contract: jailed copy, vsock echo, and dispose cleanup",
  async () => {
    await withContractDir(async (dir) => {
      const harness = await makeHarness(dir, "box-success");
      const fixture = await makeLaunchFixture(
        dir,
        harness.sandboxId,
        "exec-success",
        "ready",
        { echoPort: 5000 },
      );

      const machine = await harness.adapter.launch(fixture.request);
      let conn: Deno.Conn | undefined;
      try {
        assertEquals(machine.executionId, "exec-success");
        assertEquals(machine.state, "running");

        const records = await harness.registry.list();
        assertEquals(records.length, 1);
        assertEquals(records[0].vmId, "exec-success");
        assertEquals(records[0].pid, machine.pid);
        assertEquals(
          records[0].metadata?.[SANDBOX_ID_METADATA],
          harness.sandboxId,
        );
        assertEquals(
          records[0].metadata?.[EXECUTION_ID_METADATA],
          machine.executionId,
        );

        const sourceStat = await Deno.stat(fixture.sourceKernel);
        const stagedStat = await Deno.stat(fixture.stagedKernel);
        assertEquals(
          await Deno.readTextFile(fixture.sourceKernel),
          "immutable kernel fixture\n",
        );
        assertEquals(
          await Deno.readTextFile(fixture.stagedKernel),
          "immutable kernel fixture\n",
        );
        assertEquals((sourceStat.mode ?? 0) & 0o777, 0o744);
        assertEquals((stagedStat.mode ?? 0) & 0o777, 0o400);
        assertDistinctFiles(sourceStat, stagedStat);

        conn = await machine.connectVsock(5000, { retryTimeoutMs: 5_000 });
        await writeAll(conn, encoder.encode("studiobox-vsock"));
        assertEquals(await readText(conn, 15), "studiobox-vsock");
      } finally {
        // Deliberately leave the outbound connection open. The Studiobox
        // wrapper owns it and must close it before disposing the machine.
        await machine[Symbol.asyncDispose]();
      }

      assertEquals(await harness.registry.list(), []);
      assertEquals(await statOrNull(fixture.jailRoot), null);
      assertEquals(
        await Deno.readTextFile(fixture.sourceKernel),
        "immutable kernel fixture\n",
      );
      assertJournalCleared(await harness.state.get(harness.sandboxId));
      if (conn !== undefined) {
        await assertRejects(() => conn!.write(new Uint8Array([1])));
      }
    });
  },
);

Deno.test(
  "Firecracker process contract: failed launch leaves no jail or package journal",
  async () => {
    await withContractDir(async (dir) => {
      const harness = await makeHarness(dir, "box-failed");
      const fixture = await makeLaunchFixture(
        dir,
        harness.sandboxId,
        "exec-failed",
        "exit-before-bind",
      );

      const error = await assertRejects(
        () => harness.adapter.launch(fixture.request),
        FirecrackerAdapterError,
      );
      assertEquals(error.code, "SBX_FC_VMM_EXITED");
      assertEquals(error.details.exitCode, 7);
      assertEquals(await harness.registry.list(), []);
      assertEquals(await statOrNull(fixture.jailRoot), null);
      assertEquals(
        await Deno.readTextFile(fixture.sourceKernel),
        "immutable kernel fixture\n",
      );
      assertJournalCleared(await harness.state.get(harness.sandboxId));
    });
  },
);

Deno.test(
  "Firecracker process contract: restart reconciliation kills and reclaims a live execution",
  async () => {
    await withContractDir(async (dir) => {
      const harness = await makeHarness(dir, "box-reconcile");
      const fixture = await makeLaunchFixture(
        dir,
        harness.sandboxId,
        "exec-reconcile",
        "ready",
      );
      const machine = await harness.adapter.launch(fixture.request);

      try {
        assertEquals((await harness.registry.list()).length, 1);
        const result = await harness.adapter.reconcileAfterSupervisorRestart();
        assertEquals(result.reclaimed, ["exec-reconcile"]);
        assertEquals(result.stillRunning, []);
        assertEquals(result.failures, []);
        const exit = await machine.exited;
        assertEquals(exit.signal, "SIGKILL");
      } finally {
        // Reconciliation and normal ownership cleanup must compose
        // idempotently even though this stale wrapper still exists.
        await machine[Symbol.asyncDispose]();
      }

      assertEquals(await harness.registry.list(), []);
      assertEquals(await statOrNull(fixture.jailRoot), null);
      assertJournalCleared(await harness.state.get(harness.sandboxId));
    });
  },
);
