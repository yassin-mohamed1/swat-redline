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
  const [notifications, poller, alerts, warnings, bot, config, repository, migration, voiceMigration, statusMigration, index] = await Promise.all([
    read("../api/notifications/send.js"),
    read("../lib/leave-poller.js"),
    read("../lib/admin-alerts.js"),
    read("../api/warnings.js"),
    read("../bot/index.mjs"),
    read("../bot/config.mjs"),
    read("../bot/repository.mjs"),
    read("../supabase/migrations/20261120160000_admin_alerts_voice_attendance.sql"),
    read("../supabase/migrations/20261120180000_voice_join_event_race_protection.sql"),
    read("../supabase/migrations/20261120193000_sync_voice_check_status.sql"),
    read("../index.html")
  ]);

  assert.match(notifications, /config\.notificationChannelId/);
  assert.match(notifications, /\["person", "case", "investigation"\]/);
  assert.match(poller, /queuePendingLeaveAdminAlerts/);
  assert.match(poller, /leave-request:/);
  assert.match(alerts, /resolution=ignore-duplicates/);
  assert.match(alerts, /status: "processing"/);
  assert.match(alerts, /next_attempt_at/);
  assert.match(alerts, /ADMIN_ALERTS_ENABLED/);
  assert.match(alerts, /if \(!config.enabled\)/);
  assert.match(warnings, /processAttendanceAdminNotifications/);
  assert.match(warnings, /processAttendanceAdminNotifications\(cfg, dashboard\)/);
  assert.match(warnings, /admin_notifications: adminNotifications/);
  assert.match(warnings, /stage \* 7 \* 86400000/);
  assert.match(warnings, /voice_verification_status: "eq.pending"/);
  assert.match(warnings, /attendance_date: "lt\." \+ today/);
  assert.match(warnings, /voice_check_status: "eq.pending"/);
  assert.match(warnings, /voice_check_status: "alerted"/);
  assert.match(statusMigration, /voice_check_status = 'confirmed'/);
  assert.match(index, /id="page-rules"/);
  assert.doesNotMatch(index, /التحقق من دخول الصوت بعد البصمة|باستثناء روم AFK|Post-Stamp Voice Check|must join at least one voice channel|It does not record or listen to audio/);
  assert.match(bot, /Events\.VoiceStateUpdate/);
  assert.match(bot, /newState\.guild\.afkChannelId/);
  assert.match(bot, /recordAttendanceVoiceJoinEvent/);
  assert.match(bot, /admin_alerts_channel_manage_channels_missing/);
  assert.match(bot, /admin_alerts_channel_privacy_verification_failed/);
  assert.match(bot, /channel\.permissionOverwrites\.set/);
  assert.match(bot, /guild\.channels\.fetch\(channel\.id, \{ force: true \}\)/);
  assert.doesNotMatch(bot, /channel\.permissionOverwrites\.fetch/);
  assert.match(bot, /clearAdminAlertsChannelHistoryOnce/);
  assert.match(config, /DISCORD_ADMIN_ALERTS_CHANNEL_ID/);
  assert.match(config, /ADMIN_ALERTS_CLEAR_HISTORY_ON_STARTUP/);
  assert.match(repository, /record_swat_attendance_voice_join/);
  assert.match(repository, /p_event_key: eventKey/);
  assert.match(voiceMigration, /CREATE TABLE IF NOT EXISTS public\.attendance_voice_join_events/);
  assert.match(voiceMigration, /record_swat_attendance_voice_join/);
  assert.match(voiceMigration, /attendance_match_voice_join_before_insert/);
  assert.match(voiceMigration, /attendance_voice_join_apply_existing/);
  assert.match(migration, /voice_verification_status IN \('pending','verified','notified','legacy'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.attendance_admin_alerts/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS admin_alert_queued_at timestamptz/);
});
