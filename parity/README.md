# Upstream API inventory

`inventory.json` is the machine-readable root export inventory for
`jsr:@deno/sandbox@0.13.2`. It is derived from:

```sh
deno doc --json jsr:@deno/sandbox@0.13.2
```

The exact package currently reports 129 root symbols. That is three more than
the 126-symbol estimate in the original plan, so the generated inventory—not the
estimate—is the M0 baseline. Symbol-level tiers have been reviewed;
mixed-surface symbols (`Sandbox`, `SandboxOptions`, `SandboxDeno`, and `Client`)
also carry member overrides.

`member-audit.json` expands that baseline to the 473 declared member occurrences
on 94 member-bearing symbols. It records the comparison method, compile-checked
exact structural contracts, nominal class-return boundaries,
internal-constructor exclusions, and the resolution of every concrete signature
mismatch. The compile fixture is `tests/unit/api/upstream_type_compat_test.ts`;
it checks defaulted calls, writable diagnostics, public keysets, and the custom
inspection symbols against the exact upstream package.

The M0 consumer-surface member gate is closed. `Sandbox.spawn`,
`Sandbox.exposeVscode`, and `Sandbox.deploy` accept the upstream defaulted call
forms; `Sandbox.sh` and diagnostic fields have matching mutability; and Sandbox,
VsCode, Volume, and Snapshot implement the custom inspection member.
Runtime-token constructors tagged `@internal` upstream remain an explicit
abstract-provider deviation rather than a normal consumer API.

Provenance: both JSON files are carried byte-exact from the limabox audit
(expensive to reproduce). Their internal field names therefore still use the
historical `limabox` key for the local implementation's signatures; read those
keys as describing the Studiobox surface.
