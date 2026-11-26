import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID,
  resolveNotificationChannelRoute,
  validateAutomaticNotificationChannelId
} from "../lib/notification-channel-routing.js";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("automatic notification channel accepts valid IDs and rejects the Redline Server room", () => {
  assert.equal(validateAutomaticNotificationChannelId("1561485863492259840"), "1561485863492259840");
  assert.equal(validateAutomaticNotificationChannelId(""), "");
  assert.throws(
    () => validateAutomaticNotificationChannelId(BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID),
    /Redline Server/
  );
  assert.throws(() => validateAutomaticNotificationChannelId("not-a-channel"), /صحيحة/);
});

test("operations, announcements, reports and daily tasks share the configured automatic channel", () => {
  const automaticChannelId = "1561485863492259840";
  for (const type of ["operation", "announcement", "report", "task"]) {
    assert.deepEqual(
      resolveNotificationChannelRoute(type, {
        automaticChannelId,
        evidenceChannelId: "1562393479953518612"
      }),
      { id: automaticChannelId, label: "الإشعارات التلقائية" }
    );
  }
});

test("cases, people and investigations retain their separate evidence channel", () => {
  const evidenceChannelId = "1562393479953518612";
  for (const type of ["person", "case", "investigation"]) {
    assert.deepEqual(
      resolveNotificationChannelRoute(type, {
        automaticChannelId: "1561485863492259840",
        evidenceChannelId
      }),
      { id: evidenceChannelId, label: "الأدلة والملفات" }
    );
  }
});

test("the forbidden room is rejected even if supplied as a stale automatic or evidence setting", () => {
  assert.throws(
    () => resolveNotificationChannelRoute("operation", {
      automaticChannelId: BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID
    }),
    /Redline Server/
  );
  assert.throws(
    () => resolveNotificationChannelRoute("case", {
      evidenceChannelId: BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID
    }),
    /Redline Server/
  );
});

test("the manually selected Send Messages flow remains separate from automatic channel routing", async () => {
  const api = await read("../api/notifications/send.js");
  const savedMessages = await read("../lib/saved-discord-messages.js");
  assert.match(api, /saved_message_/);
  assert.match(api, /handleSavedDiscordMessageRequest/);
  assert.match(savedMessages, /body\.channel_id/);
  assert.match(savedMessages, /sendSavedMessage\(config,user,id,channelId,body\.mentions\)/);
});
