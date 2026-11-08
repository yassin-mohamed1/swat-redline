import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("shared portal data writes append automatic create, update and delete audit records", async () => {
  const state = await readFile(new URL("../api/state.js", import.meta.url), "utf8");
  for (const collection of ["people","cases","investigations","tasks","operations","reports","announcements","rules","dailyCommands"]) {
    assert.ok(state.includes(collection), "missing audited collection " + collection);
  }
  assert.match(state, /buildStateAuditEvents\(beforeData,afterData,user\)/);
  assert.match(state, /const action=!oldItem\?"create":!newItem\?"delete":"update"/);
  assert.match(state, /appendStateAuditEvents\(supabaseUrl,serviceKey,auditEvents\)/);
  assert.match(state, /forwardAuditEventsToDiscord\(batch\)/);
  assert.match(state, /audit_logged_count/);
  assert.match(state, /for\(let offset=0;offset<events\.length;offset\+=50\)/);
});

test("site settings, image uploads, notification preferences and authentication changes are audited", async () => {
  const [settings,media,notifications,login,logout] = await Promise.all([
    readFile(new URL("../api/admin/settings.js", import.meta.url), "utf8"),
    readFile(new URL("../api/admin/media.js", import.meta.url), "utf8"),
    readFile(new URL("../api/user/notifications.js", import.meta.url), "utf8"),
    readFile(new URL("../api/auth/session.js", import.meta.url), "utf8"),
    readFile(new URL("../api/auth/logout.js", import.meta.url), "utf8")
  ]);
  assert.match(settings, /entity_type:"site_setting"/);
  assert.match(settings, /before_summary/);
  assert.match(settings, /after_summary/);
  assert.match(media, /entity_type:"site_media"/);
  assert.match(notifications, /entity_type:"staff_notification_preference"/);
  assert.match(login, /event_key:auditKey/);
  assert.match(login, /action:"login"/);
  assert.match(login, /forwardAuditToDiscord/);
  assert.match(logout, /event_key:auditKey/);
  assert.match(logout, /action:"logout"/);
  assert.match(logout, /forwardAuditToDiscord/);
});

test("login and logout audit idempotency migration adds a unique event key", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261108210000_audit_event_idempotency.sql", import.meta.url), "utf8");
  const fix = await readFile(new URL("../supabase/migrations/20261108211000_fix_audit_event_key_unique.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_key text/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_event_key_uidx/);
  assert.match(fix, /DROP INDEX IF EXISTS public\.audit_logs_event_key_uidx/);
  assert.match(fix, /ON public\.audit_logs\(event_key\)/);
});

test("shared audit forwarder redacts risky content and targets the LUX audit room", async () => {
  const helper = await readFile(new URL("../lib/audit-log.js", import.meta.url), "utf8");
  const audit = await readFile(new URL("../api/audit/log.js", import.meta.url), "utf8");
  assert.match(helper, /forwardAuditEventsToDiscord/);
  assert.match(helper, /1569047013402738829/);
  assert.ok(helper.includes("allowed_mentions:{parse:[]}"));
  assert.match(helper, /SENSITIVE_VALUE/);
  assert.match(audit, /forwardAuditToDiscord/);
});
