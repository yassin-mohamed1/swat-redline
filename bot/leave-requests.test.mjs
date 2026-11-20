import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscordLeaveRequestRecord,
  LeaveRequestValidationError,
  validateLeaveRequestFields
} from "./leave-requests.mjs";

const IDS = {
  interactionId: "12345678901234567",
  userId: "22345678901234567",
  guildId: "32345678901234567",
  channelId: "42345678901234567"
};

test("normalizes Arabic and Persian duration digits and accepts day suffixes", () => {
  assert.deepEqual(
    validateLeaveRequestFields({ militaryName: "Ninja", reason: "راحة شخصية", durationDays: "٥ أيام" }),
    { militaryName: "Ninja", reason: "راحة شخصية", durationDays: 5 }
  );
  assert.equal(validateLeaveRequestFields({ militaryName: "Alpha", reason: "إجازة", durationDays: "۳" }).durationDays, 3);
});

test("rejects missing military name, short reason, and invalid or out-of-range durations", () => {
  for (const input of [
    { militaryName: "", reason: "إجازة", durationDays: "3" },
    { militaryName: "A", reason: "إجازة", durationDays: "3" },
    { militaryName: "Alpha", reason: "لا", durationDays: "3" },
    { militaryName: "Alpha", reason: "راحة", durationDays: "0" },
    { militaryName: "Alpha", reason: "راحة", durationDays: "366" },
    { militaryName: "Alpha", reason: "راحة", durationDays: "1.5" }
  ]) {
    assert.throws(() => validateLeaveRequestFields(input), LeaveRequestValidationError);
  }
});

test("builds a pending Discord leave request without inventing approved dates", () => {
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

test("rejects malformed Discord identifiers before database insertion", () => {
  assert.throws(() => buildDiscordLeaveRequestRecord({
    ...IDS,
    userId: "not-a-discord-id",
    profile: { display_name: "Member" },
    militaryName: "Alpha",
    reason: "راحة",
    durationDays: 2
  }), /بيانات Discord/);
});
