import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildDiscordLeaveRequestRecord,
  LeaveRequestValidationError,
  validateLeaveRequestFields
} from "../bot/leave-requests.mjs";

const IDS = {
  interactionId: "12345678901234567",
  userId: "22345678901234567",
  guildId: "32345678901234567",
  channelId: "42345678901234567"
};

test("normalizes Arabic and Persian duration digits", () => {
  assert.deepEqual(
    validateLeaveRequestFields({ militaryName: "Alpha 17", reason: "ظروف عائلية", durationDays: "٥" }),
    { militaryName: "Alpha 17", reason: "ظروف عائلية", durationDays: 5 }
  );
  assert.equal(
    validateLeaveRequestFields({ militaryName: "Ninja", reason: "راحة", durationDays: "۳ أيام" }).durationDays,
    3
  );
  assert.equal(
    validateLeaveRequestFields({ militaryName: "Ninja", reason: "راحة", durationDays: "7 days" }).durationDays,
    7
  );
});

test("rejects missing fields, invalid durations, and excessive lengths", () => {
  const invalid = [
    { militaryName: "", reason: "إجازة", durationDays: "3" },
    { militaryName: "A", reason: "إجازة", durationDays: "3" },
    { militaryName: "Alpha", reason: "لا", durationDays: "3" },
    { militaryName: "Alpha", reason: "راحة", durationDays: "0" },
    { militaryName: "Alpha", reason: "راحة", durationDays: "366" },
    { militaryName: "Alpha", reason: "راحة", durationDays: "1.5" },
    { militaryName: "x".repeat(101), reason: "راحة", durationDays: "3" },
    { militaryName: "Alpha", reason: "x".repeat(1001), durationDays: "3" }
  ];
  for (const input of invalid) {
    assert.throws(() => validateLeaveRequestFields(input), LeaveRequestValidationError);
  }
});

test("builds a pending Discord leave row without turning requested days into approved dates", () => {
  const record = buildDiscordLeaveRequestRecord({
    ...IDS,
    profile: { display_name: "Portal Name", username: "discord-name", avatar_url: "https://example.test/avatar.png" },
    militaryName: "Alpha 17",
    reason: "ظروف عائلية",
    durationDays: "7",
    submittedAt: new Date("2026-11-20T01:00:00.000Z")
  });

  assert.equal(record.discord_user_id, IDS.userId);
  assert.equal(record.display_name, "Portal Name");
  assert.equal(record.military_name, "Alpha 17");
  assert.equal(record.reason, "ظروف عائلية");
  assert.equal(record.requested_duration_days, 7);
  assert.equal(record.start_date, null);
  assert.equal(record.end_date, null);
  assert.equal(record.status, "pending");
  assert.equal(record.source, "discord");
  assert.equal(record.discord_channel_id, IDS.channelId);
  assert.equal(record.discord_message_id, null);
  assert.equal(record.discord_interaction_id, IDS.interactionId);
  assert.equal(record.submitted_at, "2026-11-20T01:00:00.000Z");
});

test("rejects malformed Discord references before a request can be stored", () => {
  assert.throws(() => buildDiscordLeaveRequestRecord({
    ...IDS,
    userId: "not-a-discord-id",
    profile: { display_name: "Member" },
    militaryName: "Alpha",
    reason: "راحة",
    durationDays: 2
  }), LeaveRequestValidationError);
});

test("Discord modal, same website review queue, and old-text intake retirement stay connected", async () => {
  const read = path => readFile(new URL(path, import.meta.url), "utf8");
  const [bot, repository, config, api, html, poller, migration] = await Promise.all([
    read("../bot/index.mjs"),
    read("../bot/repository.mjs"),
    read("../bot/config.mjs"),
    read("../api/warnings.js"),
    read("../index.html"),
    read("../lib/leave-poller.js"),
    read("../supabase/migrations/20261120130000_discord_leave_request_modal_fields.sql")
  ]);

  assert.match(config, /leaveRequestChannelId: String\(env\.LEAVE_REQUEST_CHANNEL_ID \|\| ""\)/);
  assert.match(bot, /LEAVE_PANEL_BUTTON_ID/);
  assert.match(bot, /ButtonStyle\.Success/);
  assert.match(bot, /new ModalBuilder\(\)/);
  assert.match(bot, /setCustomId\("military_name"\)/);
  assert.match(bot, /setCustomId\("leave_reason"\)/);
  assert.match(bot, /setCustomId\("duration_days"\)/);
  assert.match(bot, /interaction\.isModalSubmit\(\)/);
  assert.match(bot, /findLeaveRequestByInteraction/);
  assert.match(bot, /findPendingLeaveRequest/);
  assert.match(bot, /repository\.createLeaveRequest\(record\)/);

  assert.match(repository, /attendance_leave_requests\?select=id,status,discord_user_id/);
  assert.match(repository, /discord_interaction_id/);
  assert.match(api, /military_name,requested_duration_days/);
  assert.match(api, /discord_interaction_id/);
  assert.match(html, /militaryNameLabel/);
  assert.match(html, /requestedDurationLabel/);
  assert.match(html, /item\.approved_duration_days\|\|item\.requested_duration_days/);

  assert.match(poller, /legacy_free_text_intake_disabled/);
  const processStart = poller.indexOf("async function processMessage(");
  const processEnd = poller.indexOf("\\nexport async function handleLeaveRequestPoller", processStart);
  assert.ok(processStart >= 0 && processEnd > processStart);
  assert.doesNotMatch(poller.slice(processStart, processEnd), /createOrLoadRequest\(/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS military_name text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS requested_duration_days smallint/);
  assert.match(migration, /attendance_leave_requests_interaction_unique/);
});
