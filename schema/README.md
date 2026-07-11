# Studiobox wire schemas

These files are the append-only source of truth for the three RPC boundaries:

- `host_control.capnp`: client to unprivileged `studiobox-hostd`;
- `sandbox_agent.capnp`: client to guest `studioboxd` through the opaque tunnel;
- `supervisor.capnp`: unprivileged `studiobox-hostd` to root `studiobox-rootd`;
- `streams.capnp`: bounded capability streams shared by guest services; and
- `common.capnp`: negotiation, contract identity, limits, and stable errors.

Schema IDs and ordinals are permanent. Additive changes require a protocol minor
bump and feature bit. Breaking semantic changes require a protocol major bump.
The canonical bundle hash covers all five `.capnp` sources in sorted filename
order; exact hashes are required unless a checked compatibility table explicitly
admits a known additive pair.

`codegen_probe.capnp` is qualification-only and is excluded from the negotiated
bundle hash. Its deterministic generated TypeScript is committed under
`src/wire/generated/` to prove unary and streaming generation against the exact
`capnpc-deno` toolchain published as `jsr:@nullstyle/capnp`.

The five production schemas compile, but their full generated TypeScript is not
committed yet: the M1 qualification (2026-07-11, `capnp-deno` checkout
`ad07911`) confirmed the toolchain still lowers cross-file struct references to
unimported names plus `TYPE_ANY_POINTER` descriptors, surfaces cross-file
interfaces as raw capability pointers, and emits a barrel whose `*_meta.ts`
exports hard-collide for any two schemas. `compat/wire.json` records the exact
blocker inventory, and `deno task wire:check` re-verifies the blocked status on
every toolchain-present run (it fails once upstream fixes land, forcing the full
bindings to be committed). Regenerate the committed bindings with
`deno task wire:generate`. Until the upstream fix, `src/wire/contract.ts`
enforces handshake and hostile-boundary limits without pretending handwritten
declarations are production bindings.
