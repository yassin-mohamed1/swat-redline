import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warnings API separates editor authorization from bot role execution", async () => {
  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(source, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(source, /DISCORD_BOT_ROLE_ID/);
  assert.match(source, /DISCORD_WARNING_ROLE_1_ID/);
  assert.match(source, /DISCORD_WARNING_ROLE_2_ID/);
  assert.doesNotMatch(source, /DISCORD_WARNING_ROLE_3_ID/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /DISCORD_BOT_TOKEN/);
  assert.match(source, /params.get\("diagnostics"\) === "1"/);
});

test("disciplinary ladder permits Warning 1, Warning 2, then Dismissal only", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261108083809_two_warnings_then_dismissal.sql", import.meta.url), "utf8");
  assert.match(migration, /action_type = 'warning' AND warning_level IN \(1, 2\)/);
  assert.match(migration, /action_type = 'dismissal' AND warning_level = 3/);
  assert.match(migration, /v_subject\.warning_level <> 2/);

  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(source, /const WARNING_LEVELS = \[1, 2\]/);
  assert.match(source, /actionType === "dismissal" && level === 3/);

  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<option value="3">Dismissal<\/option>/);
  assert.doesNotMatch(html, /<option value="3">Warning 3<\/option>/);
  assert.match(html, /Dismissed Members/);
});
