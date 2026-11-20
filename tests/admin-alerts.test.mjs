import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { riyadhDateKey } from "../lib/admin-alerts.js";

test("voice verification uses the Riyadh calendar day boundary", () => {
  assert.equal(riyadhDateKey(new Date("2026-11-19T21:00:00.000Z")), "2026-11-20");
  assert.equal(riyadhDateKey(new Date("2026-11-20T20:59:59.000Z")), "2026-11-20");
  assert.equal(riyadhDateKey(new Date("2026-11-20T21:00:00.000Z")), "2026-11-21");
});

test("admin alert routing, voice verification, and one-time channel cleanup are wired together", async () => {
  const read = path => readFile(new URL(path, import.meta.url), "utf8");
  const [notifications, poller, alerts, warnings, bot, config, repository, migration] = await Promise.all([
    read("../api/notifications/send.js"),
    read("../lib/leave-poller.js"),
    read("../lib/admin-alerts.js"),
    read("../api/warnings.js"),
    read("../bot/index.mjs"),
    read("../bot/config.mjs"),
    read("../bot/repository.mjs"),
    read("../supabase/migrations/20261120160000_admin_alerts_voice_attendance.sql")
  ]);

  assert.match(notifications, /config\.notificationChannelId/);
  assert.match(notifications, /\["person", "case", "investigation"\]/);
  assert.match(poller, /queuePendingLeaveAdminAlerts/);
  assert.match(poller, /leave-request:/);
  assert.match(alerts, /resolution=ignore-duplicates/);
  assert.match(alerts, /status: "processing"/);
  assert.match(alerts, /next_attempt_at/);
  assert.match(warnings, /processAttendanceAdminNotifications/);
  assert.match(warnings, /stage \* 7 \* 86400000/);
  assert.match(warnings, /voice_verification_status: "eq.pending"/);
  assert.match(warnings, /attendance_date: "lt\." \+ today/);
  assert.match(bot, /Events\.VoiceStateUpdate/);
  assert.match(bot, /newState\.guild\.afkChannelId/);
  assert.match(bot, /markAttendanceVoiceJoin/);
  assert.match(bot, /channel\.permissionOverwrites\.set/);
  assert.match(bot, /clearAdminAlertsChannelHistoryOnce/);
  assert.match(config, /DISCORD_ADMIN_ALERTS_CHANNEL_ID/);
  assert.match(config, /ADMIN_ALERTS_CLEAR_HISTORY_ON_STARTUP/);
  assert.match(repository, /voice_verification_status: "eq.pending"/);
  assert.match(repository, /voice_verification_status: "verified"/);
  assert.match(migration, /voice_verification_status IN \('pending','verified','notified','legacy'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.attendance_admin_alerts/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS admin_alert_queued_at timestamptz/);
});
