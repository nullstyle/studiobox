import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

/**
 * Host-safe contract guard for the WI-3 template branch of
 * `images/overlay_init/overlay-init.sh` (snapshot-restore §2.2). The full boot
 * runs mounts/chroot and is proven end to end only in fc-smoke (WI-8); here we
 * assert the security-critical cmdline-parse + exec-branch contract the next
 * build (and the golden rebake) wire to, straight off the real script so the
 * check never drifts from what ships in the image.
 */

const SCRIPT = await Deno.readTextFile(
  fromFileUrl(
    import.meta.resolve("../../../images/overlay_init/overlay-init.sh"),
  ),
);

/** Body of `if [ "$MODE" = "template" ]; then … fi` (the template branch). */
function templateBranch(): string {
  const start = SCRIPT.indexOf('if [ "$MODE" = "template" ]; then');
  if (start === -1) throw new Error("template branch not found");
  const end = SCRIPT.indexOf("\nfi", start);
  if (end === -1) throw new Error("template branch has no closing fi");
  return SCRIPT.slice(start, end);
}

/** Body of the final cold `exec chroot … --token-file …` block. */
function coldExec(): string {
  const marker = '--token-file "$TOKEN_FILE"';
  const at = SCRIPT.indexOf(marker);
  if (at === -1) throw new Error("cold token-file exec not found");
  const start = SCRIPT.lastIndexOf("exec chroot", at);
  return SCRIPT.slice(start, at + marker.length + 200);
}

Deno.test("overlay-init parses studiobox.mode alongside the existing tokens", () => {
  assertEquals(
    SCRIPT.includes('studiobox.mode=*) MODE="${tok#studiobox.mode=}" ;;'),
    true,
  );
  // The pre-existing token-parse contract is untouched.
  for (
    const line of [
      'studiobox.vsock_port=*) VSOCK_PORT="${tok#studiobox.vsock_port=}" ;;',
      'studiobox.token=*) TOKEN_HEX="${tok#studiobox.token=}" ;;',
      'studiobox.ip=*) GUEST_IP="${tok#studiobox.ip=}" ;;',
      'studiobox.gw=*) GUEST_GW="${tok#studiobox.gw=}" ;;',
      'studiobox.dns=*) GUEST_DNS="${tok#studiobox.dns=}" ;;',
    ]
  ) {
    assertEquals(SCRIPT.includes(line), true);
  }
});

Deno.test("the missing-token FATAL is bypassed ONLY in template mode", () => {
  // Cold boots (MODE empty) still fail closed without a credential; the gate is
  // widened by exactly one conjunct that is false only for a template boot.
  assertEquals(
    SCRIPT.includes(
      'if [ "$MODE" != "template" ] && [ -z "$TOKEN_HEX" ]; then',
    ),
    true,
  );
});

Deno.test("template branch execs studioboxd --template with NO credential file", () => {
  const branch = templateBranch();
  assertEquals(branch.includes("--template"), true);
  assertEquals(branch.includes('--vsock-port "$VSOCK_PORT"'), true);
  // The template holds no credential: it must never be handed a --token-file.
  assertEquals(branch.includes("--token-file"), false);
  // And it must not materialize a credential file — the whole point of
  // template mode is that identity is injected after restore via personalize.
  assertEquals(branch.includes("TOKEN_FILE="), false);
});

Deno.test("the cold exec still requires the credential file", () => {
  assertEquals(coldExec().includes('--token-file "$TOKEN_FILE"'), true);
});

Deno.test("both exec sites run studioboxd under tini as guest pid 1", () => {
  // tini reaps the orphaned grandchildren a daemonizing workload reparents to
  // pid 1 — studioboxd (Deno) reaps only its own direct children. It is baked
  // in via the `tini` package pin and referenced through a defaulted var.
  assertEquals(
    SCRIPT.includes('TINI="${STUDIOBOXD_TINI:-/usr/bin/tini}"'),
    true,
    "tini path is defaulted like the other guest binaries",
  );

  for (
    const [name, block] of [
      ["cold", coldExec()],
      ["template", templateBranch()],
    ] as const
  ) {
    // tini wraps the agent: `exec chroot /mnt/root "$TINI" -g -- "$AGENT" ...`.
    assertEquals(
      block.includes('"$TINI" -g -- "$AGENT"'),
      true,
      `${name}: agent is wrapped by tini`,
    );
    // -g forwards signals to the whole process group, not just studioboxd — the
    // point of the wrap. A wrap that drops it must fail this test.
    assertEquals(block.includes('"$TINI" -g'), true, `${name}: -g present`);
    // Still `exec` (process replacement), so tini actually inherits pid 1 — no
    // fork between overlay-init and tini.
    assertEquals(
      block.includes("exec chroot /mnt/root"),
      true,
      `${name}: exec-into-chroot preserved`,
    );
    // tini precedes the agent's own flags — a reorder that put --vsock-port
    // ahead of tini would hand it to tini, not studioboxd.
    assertEquals(
      block.indexOf('"$TINI"') < block.indexOf('--vsock-port "$VSOCK_PORT"'),
      true,
      `${name}: tini precedes the agent argv`,
    );
  }
});

Deno.test("template exec precedes credential materialization (never materialized)", () => {
  const templateExec = SCRIPT.indexOf('if [ "$MODE" = "template" ]; then');
  const tokenMaterialize = SCRIPT.indexOf('TOKEN_FILE="/run/studioboxd.token"');
  // The template branch execs (replacing the process) BEFORE the cold path's
  // credential materialization, so a template boot can never write a token.
  assertEquals(templateExec !== -1 && tokenMaterialize !== -1, true);
  assertEquals(templateExec < tokenMaterialize, true);
});
