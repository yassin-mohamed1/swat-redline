import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscordMessageContent,
  DISCORD_MESSAGE_CONTENT_LIMIT,
  safeDiscordMessageFilename
} from "../lib/discord-message-format.js";

test("short saved text is sent as a full-width standard Discord message with a large heading", () => {
  const body = "SWAT message\\nSecond line";
  const result = buildDiscordMessageContent({ title: "Voice Activated", content: body });
  assert.equal(result.useAttachment, false);
  assert.equal(result.content, "# 🔴 Voice Activated\\n\\n" + body);
  assert.equal(result.fileContent, body);
  assert.equal("embed" in result, false);
});

test("long saved text is attached in one file when standard message content exceeds 2000 characters", () => {
  const body = "A".repeat(DISCORD_MESSAGE_CONTENT_LIMIT);
  const result = buildDiscordMessageContent({ title: "Long Notice", content: body });
  assert.equal(result.useAttachment, true);
  assert.match(result.content, /^# 🔴 Long Notice/);
  assert.equal(result.fileContent, body);
  assert.equal(result.filename, "Long-Notice.txt");
});

test("message filenames are safe for Discord attachments", () => {
  const filename = safeDiscordMessageFilename("SWAT: Warning / Voice?");
  assert.ok(filename.endsWith(".txt"));
  assert.equal(filename.includes("/"), false);
  assert.equal(filename.includes(":"), false);
});

test("empty title and body receive a branded fallback instead of an invalid blank embed", () => {
  const result = buildDiscordMessageContent({ title: "", content: "" });
  assert.equal(result.useAttachment, false);
  assert.equal(result.content, "# 🔴 رسالة من S.W.A.T.\\n\\nإشعار إداري من S.W.A.T. REDLINE.");
});
