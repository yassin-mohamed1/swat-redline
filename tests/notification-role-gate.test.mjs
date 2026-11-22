import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("manual bulk DMs require live S.W.A.T. role verification before any DM is sent", async () => {
  const api = await read("../api/notifications/send.js");
  assert.match(api, /const REQUIRED_SWT_DM_ROLE_ID = "1561561038263029900"/);
  assert.match(api, /async function verifyDiscordSwatRole\(config, discordUserIds\)/);
  assert.match(api, /\/guilds\/.*\/members\//);
  assert.match(api, /roles\.includes\(REQUIRED_SWT_DM_ROLE_ID\)/);
  assert.match(api, /return res\.status\(error\.status \|\| 503\)[\s\S]*dm_sent: 0/);
  const verificationAt = api.indexOf("verifyDiscordSwatRole(config, candidateRecipients.map");
  const batchAt = api.indexOf('supabaseRequest(config, "discord_notification_batches"', verificationAt);
  const dmAt = api.indexOf('"/users/@me/channels"', verificationAt);
  assert.ok(verificationAt > 0 && batchAt > verificationAt && dmAt > verificationAt);
  assert.match(api, /mode: broadcastEnabled \? "broadcast_swat_role_only" : "test_self"/);
});

test("manual specific-member DM remains a separate single-recipient action and bypasses bulk-role filtering", async () => {
  const api = await read("../api/notifications/send.js");
  const start = api.indexOf('if (body.action === "send_dm_to_specific_member")');
  const end = api.indexOf('if (String(body.action || "").startsWith("saved_message_"))', start);
  const action = api.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(action, /recipientIds\.length !== 1/);
  assert.match(action, /recipient_id: recipientId/);
  assert.match(api, /async function verifyDiscordSwatRole/);
});

test("announcement channel forwarder also verifies current S.W.A.T. membership and fails closed", async () => {
  const forwarder = await read("../lib/announcement-forwarder.js");
  assert.match(forwarder, /const REQUIRED_SWT_DM_ROLE_ID = "1561561038263029900"/);
  assert.match(forwarder, /async function verifyAnnouncementRecipients/);
  assert.match(forwarder, /roles\.includes\(REQUIRED_SWT_DM_ROLE_ID\)/);
  assert.match(forwarder, /Could not verify current S\.W\.A\.T\. role membership/);
  assert.match(forwarder, /role_required: REQUIRED_SWT_DM_ROLE_ID/);
});

test("channel publishing remains independent from the DM recipient gate", async () => {
  const api = await read("../api/notifications/send.js");
  const channelAt = api.indexOf("if (channelEnabled)");
  const dmVerificationAt = api.indexOf("verifyDiscordSwatRole(config, candidateRecipients.map");
  assert.ok(channelAt > 0 && dmVerificationAt > 0);
  assert.ok(channelAt < dmVerificationAt);
});
