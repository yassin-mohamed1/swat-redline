import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscordMessageEmbed,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  safeDiscordMessageFilename
} from "../lib/discord-message-format.js";

test("short saved text is rendered fully inside one branded Discord embed", () => {
  const body = "SWAT message\nSecond line";
  const result = buildDiscordMessageEmbed({ title: "Voice Activated", content: body });
  assert.equal(result.useAttachment, false);
  assert.equal(result.embed.title, "Voice Activated");
  assert.equal(result.embed.description, body);
  assert.equal(result.embed.color, 0xD92735);
});

test("long saved text stays one message and uses one text attachment", () => {
  const body = "A".repeat(DISCORD_EMBED_DESCRIPTION_LIMIT + 1);
  const result = buildDiscordMessageEmbed({ title: "Long Notice", content: body });
  assert.equal(result.useAttachment, true);
  assert.equal(result.embed.description, "المحتوى الكامل مرفق في ملف نصي واحد مع هذه الرسالة.");
  assert.equal(result.filename, "Long-Notice.txt");
});

test("message filenames are safe for Discord attachments", () => {
  const filename = safeDiscordMessageFilename('SWAT: Warning / Voice?');
  assert.match(filename, /^[^\\/:*?"<>|]+\\.txt$/);
});
