import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("attendance room composer is available from the daily attendance page", async () => {
  const html = await read("../index.html");
  assert.match(html, /onclick="openAttendanceMessageModal\(\)"/);
  assert.match(html, /id="attendanceMessageModalBack"/);
  assert.match(html, /id="attendanceMessageForm"/);
  assert.match(html, /id="attendanceMessageType"/);
  assert.match(html, /id="attendanceMessageTitle"/);
  assert.match(html, /id="attendanceMessageDescription"/);
  assert.match(html, /function openAttendanceMessageModal\(\)/);
  assert.match(html, /async function sendAttendanceMessage\(event\)/);
  assert.match(html, /action:'publish_attendance_notice'/);
});

test("attendance room messages ping only the configured SWAT role in the attendance channel", async () => {
  const api = await read("../api/notifications/send.js");
  assert.match(api, /body\.action === "publish_attendance_notice"/);
  assert.match(api, /process\.env\.ATTENDANCE_CHANNEL_ID \|\| "1569735227146768434"/);
  assert.match(api, /isActiveStaffForNotifications\(config, user\)/);
  assert.match(api, /const swatRoleId = String\(process\.env\.DISCORD_ROLE_ID \|\| ""\)\.trim\(\)/);
  assert.match(api, /content: "<@&" \+ swatRoleId \+ ">"/);
  assert.match(api, /allowed_mentions: \{ parse: \[\], roles: \[swatRoleId\], replied_user: false \}/);
  assert.doesNotMatch(api, /allowed_mentions: \{ parse: \["everyone"\]/);
  assert.match(api, /entity_type: "attendance_channel_notice"/);
  assert.match(api, /DISCORD_GUILD_ID/);
  assert.match(api, /notice_description: description/);
  assert.match(html, /منشن حقيقي لرتبة SWAT تلقائيًا/);
  assert.match(html, /لا تكتب اسم الرتبة يدويًا/);
});

test("attendance room composer supports message categories and content limits", async () => {
  const html = await read("../index.html");
  const api = await read("../api/notifications/send.js");
  for (const type of ["announcement", "notice", "request", "report", "instructions", "other"]) {
    assert.match(html, new RegExp('value="' + type + '"'));
  }
  assert.match(api, /title\.length > 200 \|\| description\.length > 4000/);
  assert.match(api, /typeLabels/);
});
