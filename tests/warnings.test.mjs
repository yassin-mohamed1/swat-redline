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
  assert.match(source, /sendDirectNotice/);
  assert.match(source, /complete_disciplinary_action_v2/);
  assert.match(source, /restoreMemberRoles/);
  assert.match(source, /30 \* 24 \* 60 \* 60 \* 1000/);
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

test("warning DM and announcement delivery are mandatory and expiry is scheduled", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const worker = api;
  const migration = await readFile(new URL("../supabase/migrations/20261108084856_warning_expiry_and_required_dm.sql", import.meta.url), "utf8");
  const schedule = await readFile(new URL("../supabase/migrations/20261108085251_warning_expiry_endpoint_consolidation.sql", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /await sendDirectNotice/);
  assert.match(api, /await sendAnnouncement/);
  assert.match(api, /The member's private message could not be delivered/);
  assert.match(api, /restoreMemberRoles/);
  assert.match(migration, /warning_expires_at timestamptz/);
  assert.match(migration, /dm_status text NOT NULL DEFAULT 'pending'/);
  assert.match(migration, /claim_expired_warning_roles/);
  assert.match(migration, /complete_expired_warning_role/);
  assert.match(worker, /CRON_SECRET/);\n  assert.match(worker, /processExpiredWarningRoles/);\n  assert.match(worker, /task\\\"\\) === \\\"expire/);
  assert.match(worker, /DISCORD_WARNING_ROLE_1_ID/);
  assert.match(worker, /DISCORD_WARNING_ROLE_2_ID/);
  assert.match(worker, /complete_expired_warning_role/);
  assert.match(schedule, /\* \* \* \* \*/);
  assert.match(schedule, /swat-warning-role-expiry/);\n  assert.match(schedule, /api\\/warnings\\?task=expire/);
  assert.match(html, /automatically/);
  assert.match(html, /Private Message/);
  assert.match(html, /30 days/);
});
