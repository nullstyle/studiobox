# @nullstyle/studiobox

A Deno-native local substitute for [`@deno/sandbox`](https://jsr.io/@deno/sandbox):
the same SDK surface, backed by Firecracker microVMs on machines you control
instead of Deno Deploy's cloud. On macOS, sandboxes run inside one long-lived
Lima Linux VM; on Linux, directly on any KVM-capable host. Every sandbox is a
jailed microVM — a kernel isolation boundary, not a container.

```ts
// import { Sandbox } from "@deno/sandbox";
import { Sandbox } from "@nullstyle/studiobox";

await using sandbox = await Sandbox.create();

await sandbox.sh`ls -lh /`;
await sandbox.fs.writeTextFile("hello.ts", `console.log("hi");`);
const result = await sandbox.deno.eval(`1 + 2`); // 3
```

Built on [`jsr:@nullstyle/firecracker`](https://jsr.io/@nullstyle/firecracker)
(microVM lifecycle, jailer, vsock, crash recovery) and
[`@nullstyle/capnp`](https://github.com/nullstyle/capnp-deno) (typed Cap'n
Proto RPC between client, host daemons, and the in-guest agent,
`studioboxd`). Studiobox adds the policy, authorization, durable state,
resource accounting, and recovery layers.

## Status

**Design stage.** This repository currently holds the founding design and
plan; the M0 foundation (transplanted from the earlier `limabox` prototype)
is next. Not usable yet.

- [DESIGN.md](DESIGN.md) — architecture, API fidelity tiers, state and
  security model
- [PLAN.md](PLAN.md) — carry-forward map, milestones M0 → 1.0, testing
  strategy, risks

1.0 means: repeatedly create, use, terminate, and reconcile real microVM
sandboxes on both supported Linux architectures with bounded resources and no
leaks — proven by a soak drill in CI, not by assertion.

## License

Apache-2.0
