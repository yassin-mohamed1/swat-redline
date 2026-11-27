import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscordResignationRequestRecord, ResignationRequestValidationError, validateResignationRequestFields } from "./resignation-requests.mjs";

test("validates only name and reason", () => {
  assert.deepEqual(validateResignationRequestFields({ memberName: "  Alpha 17  ", reason: "أرغب في تقديم استقالتي." }), { memberName: "Alpha 17", reason: "أرغب في تقديم استقالتي." });
  assert.throws(() => validateResignationRequestFields({ memberName: "A", reason: "سبب واضح" }), ResignationRequestValidationError);
  assert.throws(() => validateResignationRequestFields({ memberName: "Alpha 17", reason: "لا" }), ResignationRequestValidationError);
});

test("builds a resignation row without leave date or duration fields", () => {
  const record = buildDiscordResignationRequestRecord({
    interactionId: "12345678901234567", userId: "22345678901234567", guildId: "32345678901234567",
    channelId: "1575682539564171324", profile: { display_name: "Alpha" }, memberName: "Alpha 17",
    reason: "Personal circumstances", submittedAt: new Date("2026-11-27T00:00:00.000Z")
  });
  assert.equal(record.status, "pending");
  assert.equal(record.source, "discord");
  assert.equal(record.member_name, "Alpha 17");
  assert.equal(record.reason, "Personal circumstances");
  assert.equal("start_date" in record, false);
  assert.equal("end_date" in record, false);
  assert.equal("requested_duration_days" in record, false);
});

test("rejects malformed Discord references", () => {
  assert.throws(() => buildDiscordResignationRequestRecord({
    interactionId: "bad", userId: "22345678901234567", guildId: "32345678901234567", channelId: "1575682539564171324",
    memberName: "Alpha 17", reason: "Personal circumstances"
  }), ResignationRequestValidationError);
});
