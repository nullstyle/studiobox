/**
 * Regenerate the committed Lima template `tools/lima/studiobox-host.yaml` from
 * its single source of truth, `renderLimaTemplate()` (PLAN.md §M9).
 *
 * The committed file is asserted byte-identical to the generator by
 * `tests/unit/cli/lima_template_test.ts`; run this whenever the generator
 * changes so the artifact never drifts:
 *
 *   deno run --allow-write=tools/lima tools/lima_template_write.ts
 *
 * @module
 */

import { fromFileUrl } from "@std/path";
import { renderLimaTemplate } from "../src/cli/host_template.ts";

const target = fromFileUrl(
  import.meta.resolve("./lima/studiobox-host.yaml"),
);
await Deno.writeTextFile(target, renderLimaTemplate());
console.log(`wrote ${target}`);
