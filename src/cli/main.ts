/**
 * The studiobox CLI entrypoint (PLAN.md §M9; DESIGN.md §11):
 *
 *   deno run -A jsr:@nullstyle/studiobox/cli host <up|down|status|doctor|provision>
 *
 * Delegates to {@linkcode runCli} and exits with its code. The programmatic
 * surface lives in `./mod.ts` (the `./cli` export).
 *
 * @module
 */

import { runCli } from "./run.ts";

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args));
}
