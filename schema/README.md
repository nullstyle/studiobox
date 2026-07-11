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
committed yet: the audited `capnpc-deno` snapshot lowers cross-file structs to
`TYPE_ANY_POINTER`, loses imported interface service types, and emits a
collision-prone flat barrel. `compat/wire.json` records this hard M0 blocker and
`CAPNP_DENO_INTEGRATION.md` contains the reproduction. Until it is fixed,
`src/wire/contract.ts` enforces handshake and hostile-boundary limits without
pretending handwritten declarations are production bindings.
