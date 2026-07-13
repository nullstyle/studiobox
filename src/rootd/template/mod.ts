/**
 * Warm-template store + build primitives for snapshot-restore
 * (`docs/snapshot-restore.md`, WI-5). The host-safe surface — the on-disk
 * store, its `template.json` validation, the refcount tie-in, and the build
 * orchestration behind the {@linkcode TemplateBaker} seam — plus the real
 * fc-smoke-only microVM baker.
 *
 * @module
 */

export * from "./store.ts";
export * from "./builder.ts";
export * from "./machine_baker.ts";
