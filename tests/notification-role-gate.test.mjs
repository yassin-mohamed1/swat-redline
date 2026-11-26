import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("manual bulk DMs require live S.W.A.T. role verification before any DM is sent", async () => {
  const api = await read("../api/notifications/send.js");
  assert.match(api, /process\.env\.DISCORD_ROLE_ID/);
  assert.match(api, /async function verifyDiscordSwatRole\(config, discordUserIds\)/);
  assert.match(api, /\/guilds\/.*\/members\//);
  assert.match(api, /roles\.includes\(requiredRoleId\)/);
  assert.match(api, /private broadcast withheld/);
  assert.match(api, /role_check: roleCheck/);
  const verificationAt = api.indexOf("verifyDiscordSwatRole(config, candidateRecipients.map");
  const batchAt = api.indexOf('supabaseRequest(config, "discord_notification_batches"', verificationAt);
  const dmAt = api.indexOf("async function deliverToRecipient(recipient)", verificationAt);
  assert.ok(verificationAt > 0 && batchAt > verificationAt && dmAt > verificationAt);
  assert.match(api, /roleCheck = \{ checked: verification\.checked/);
});

test("saved-message bulk delivery verifies live S.W.A.T. role while a targeted single member is exempt", async () => {
  const saved = await read("../lib/saved-discord-messages.js");
  assert.ok(saved.includes("process.env.DISCORD_ROLE_ID"));
  assert.ok(saved.includes("async function filterSavedMessageBulkRecipientsBySwatRole"));
  assert.ok(saved.includes("roles.includes(requiredRoleId)"));
  assert.ok(saved.includes("Number(error?.status) === 404"));
  const singleAt = saved.indexOf('if (mode === "single")');
  const verifyAt = saved.indexOf('if (String(input?.recipient_mode || "") === "all")');
  assert.ok(singleAt > 0 && verifyAt > singleAt);
  assert.ok(saved.slice(singleAt, verifyAt).includes("return [selected]"));
  assert.ok(saved.slice(verifyAt).includes("filterSavedMessageBulkRecipientsBySwatRole(config, recipients)"));
});
test("announcement channel forwarder also verifies current S.W.A.T. membership and fails closed", async () => {
  const forwarder = await read("../lib/announcement-forwarder.js");
  assert.match(forwarder, /process\.env\.DISCORD_ROLE_ID/);
  assert.match(forwarder, /async function verifyAnnouncementRecipients/);
  assert.match(forwarder, /roles\.includes\(requiredRoleId\)/);
  assert.match(forwarder, /Could not verify current S\.W\.A\.T\. role membership/);
  assert.match(forwarder, /role_required: roleCheck\.roleId/);
});

test("channel publishing remains independent from the DM recipient gate", async () => {
  const api = await read("../api/notifications/send.js");
  const channelAt = api.indexOf("if (channelEnabled)");
  const dmVerificationAt = api.indexOf("verifyDiscordSwatRole(config, candidateRecipients.map");
  const channelBlockEnd = api.indexOf("let sent = 0;", channelAt);
  assert.ok(channelAt > 0 && dmVerificationAt > 0 && channelBlockEnd > channelAt);
  assert.match(api.slice(channelAt, channelBlockEnd), /discordRequest/);
  assert.match(api.slice(dmVerificationAt, channelAt), /recipients = candidateRecipients\.filter/);
});

test("DM eligibility uses the access role rather than the notification-mention role", async () => {
  const api = await read("../api/notifications/send.js");
  const saved = await read("../lib/saved-discord-messages.js");
  const forwarder = await read("../lib/announcement-forwarder.js");
  for (const source of [api, saved, forwarder]) {
    assert.match(source, /process\.env\.DISCORD_ROLE_ID/);
    assert.doesNotMatch(source, /1561561038263029900/);
  }
  assert.match(api, /config\.notificationRoleId/);
});
