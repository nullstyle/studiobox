/**
 * Durable guest-side paths shared by the provisioner and the golden-bake step
 * (PLAN.md §M9; DESIGN.md §12). A dependency-free LEAF module: both
 * {@link import("./provision.ts")} and {@link import("./bake.ts")} import these,
 * so keeping them here avoids a `provision.ts` ↔ `bake.ts` import cycle (which
 * would otherwise risk a temporal-dead-zone crash if one module hoisted the
 * other's import above these `const` definitions).
 *
 * @module
 */

/** State root rootd owns (journal, jail, overlay, and the golden cache). */
export const GUEST_STATE_DIR = "/var/lib/studiobox";

/**
 * The golden artifact cache. This is BOTH where the bake stores the set
 * (`tools/build_golden_set.ts --cache-root`) AND `buildLaunchConfig().artifactCache`
 * (what rootd reads) — the single load-bearing invariant "bake writes where
 * rootd reads". Do not let the two drift.
 */
export const GUEST_CACHE_DIR = `${GUEST_STATE_DIR}/cache`;
