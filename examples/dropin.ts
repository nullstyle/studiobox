/**
 * Drop-in demo: a `@deno/sandbox` program that runs UNCHANGED on Studiobox.
 *
 * Every executable statement below is byte-identical to the upstream
 * `@deno/sandbox` quickstart — the ONLY difference is the import specifier on
 * the next line (`@nullstyle/studiobox` in place of `@deno/sandbox`). With the
 * Studiobox provider installed (from the environment via `installStudiobox()`,
 * or by a host that already wired one), it drives a real Firecracker microVM:
 * `sh`, `fs.writeTextFile`/`readTextFile`, and `deno.eval`.
 *
 * @module
 */

import { Sandbox } from "@nullstyle/studiobox";

const sandbox = await Sandbox.create();
try {
  const greeting = await sandbox.sh`echo hello from the sandbox`.text();
  console.log(greeting.trim());

  await sandbox.fs.writeTextFile("/home/app/note.txt", "written by the demo\n");
  const note = await sandbox.fs.readTextFile("/home/app/note.txt");
  console.log(note.trim());

  const answer = await sandbox.deno.eval<number>("6 * 7");
  console.log(`6 * 7 = ${answer}`);
} finally {
  await sandbox.close();
}
