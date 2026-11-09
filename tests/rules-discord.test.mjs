import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRuleDiscordMessages } from "../lib/rules-discord.js";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

function embedLength(embed) {
  let total = 0;
  for (const value of [embed.title, embed.description, embed.url, embed.author?.name, embed.footer?.text]) {
    total += String(value ?? "").length;
  }
  for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
    total += String(field.name ?? "").length + String(field.value ?? "").length;
  }
  return total;
}

function sectionText(messages, label) {
  return messages.flatMap(message => message.embeds || [])
    .filter(embed => String(embed.title || "").startsWith(label))
    .map(embed => embed.description || "")
    .join("");
}

test("S.W.A.T. rules Discord messages preserve title, description and body exactly", () => {
  const rule = {
    id: "LAW-000123",
    type: "law",
    title: "  قانون استخدام القوة 🚨\nعنوان كامل  ",
    description: "الوصف الأول\nالسطر الثاني مع رموز 🛡️",
    body: "النص الكامل للقانون\n1- أول بند\n2- ثاني بند\n\nلا يتم حذف المسافات الأخيرة.  "
  };
  const messages = buildRuleDiscordMessages(rule, "Yassin_Ninja", new Date("2026-11-09T19:00:00.000Z"));
  assert.equal(sectionText(messages, "عنوان القانون"), rule.title);
  assert.equal(sectionText(messages, "وصف القانون"), rule.description);
  assert.equal(sectionText(messages, "نص القانون"), rule.body);
});

test("long laws are split without cutting Unicode surrogate pairs or exceeding Discord embed limits", () => {
  const body = ("قاعدة S.W.A.T. 🚔🛡️\n".repeat(1400)) + "نهاية النص — END";
  const messages = buildRuleDiscordMessages({
    id: "LAW-LONG",
    type: "law",
    title: "قانون طويل",
    description: "",
    body
  }, "Website Admin");
  assert.ok(messages.length > 1);
  assert.equal(sectionText(messages, "نص القانون"), body);
  for (const message of messages) {
    assert.ok(message.embeds.length <= 10);
    assert.ok(message.embeds.reduce((sum, embed) => sum + embedLength(embed), 0) <= 6000);
    for (const embed of message.embeds) {
      assert.ok(String(embed.description || "").length <= 4096);
      assert.ok(embedLength(embed) <= 6000);
    }
  }
});

test("optional empty rule fields do not prevent creating a Discord rules announcement", () => {
  const messages = buildRuleDiscordMessages({
    id: "LAW-EMPTY",
    type: "law",
    title: "",
    description: "",
    body: ""
  }, "Owner");
  assert.equal(messages.length, 1);
  assert.ok(messages[0].embeds[0].title.includes("S.W.A.T. REDLINE"));
  assert.ok(messages[0].embeds[0].fields.some(field => field.name === "المحتوى"));
});

test("rules endpoint targets only the configured S.W.A.T. Rules room and restricts posting to portal admins", async () => {
  const api = await read("../api/rules/send.js");
  assert.match(api, /RULES_CHANNEL_ID = "1561775787152117770"/);
  assert.match(api, /isWebsiteAdmin\(user\)/);
  assert.match(api, /requireActivePortalStaff\(user\)/);
  assert.match(api, /user\.isOwner/);
  assert.match(api, /DISCORD_NOTIFICATION_ROLE_ID/);
  assert.match(api, /allowed_mentions: first \? \{ parse: \[\], roles: \[roleId\] \}/);
  assert.match(api, /item\.type === "law"/);
  assert.match(api, /app_state\?id=eq\.main&select=data/);
});

test("rules editor leaves title, description and body optional and only admins get the send action", async () => {
  const html = await read("../index.html");
  assert.doesNotMatch(html, /id="ruleTitle" required/);
  assert.doesNotMatch(html, /id="ruleBody" rows="6" required/);
  assert.match(html, /document\.getElementById\('ruleBody'\)\.required=false/);
  assert.match(html, /currentCanAdmin\?'<button type="button" class="btn rule-send-button"/);
  assert.match(html, /id="rulesSearch"/);
});
