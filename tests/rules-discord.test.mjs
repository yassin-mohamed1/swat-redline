import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

function ruleBodyFromMessages(messages) {
  const embeds = messages.flatMap(message => message.embeds || []);
  const first = String(embeds[0]?.description || "").split("**القانون**\n")[1] || "";
  const continuations = embeds.slice(1).map(embed => {
    const description = String(embed.description || "");
    const newline = description.indexOf("\n");
    return newline < 0 ? "" : description.slice(newline + 1);
  });
  return [first, ...continuations].join("");
}

test("a normal law is delivered as one Discord embed with its name and full text together", () => {
  const rule = {
    id: "LAW-000123",
    type: "law",
    title: "قانون استخدام القوة 🚨\nعنوان كامل",
    body: "النص الكامل للقانون\n1- أول بند\n2- ثاني بند\n\nلا يتم حذف المسافات الأخيرة.  "
  };
  const messages = buildRuleDiscordMessages(rule, "Yassin_Ninja", new Date("2026-11-09T19:00:00.000Z"));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].embeds.length, 1);
  const embed = messages[0].embeds[0];
  assert.ok(embed.description.includes("**اسم القانون**\n" + rule.title));
  assert.ok(embed.description.includes("**القانون**\n" + rule.body));
  assert.ok(!/وصف القانون|عنوان القانون|نص القانون/.test(embed.description));
});

test("only very long laws continue across identically styled single-embed messages", () => {
  const body = ("قاعدة S.W.A.T. 🚔🛡️\n".repeat(1400)) + "نهاية النص — END";
  const messages = buildRuleDiscordMessages({
    id: "LAW-LONG",
    type: "law",
    title: "قانون طويل",
    description: "",
    body
  }, "Website Admin");
  assert.ok(messages.length > 1);
  assert.ok(messages.every(message => message.embeds.length === 1));
  assert.equal(ruleBodyFromMessages(messages), body);
  for (const message of messages) {
    const embed = message.embeds[0];
    assert.ok(String(embed.description || "").length <= 4096);
    assert.ok(embedLength(embed) <= 6000);
    assert.ok(embed.title.includes("S.W.A.T. REDLINE"));
  }
});

test("empty law content still produces one clean embed with placeholders", () => {
  const messages = buildRuleDiscordMessages({
    id: "LAW-EMPTY",
    type: "law",
    title: "",
    description: "",
    body: ""
  }, "Owner");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].embeds.length, 1);
  assert.ok(messages[0].embeds[0].description.includes("**اسم القانون**\nبدون اسم"));
  assert.ok(messages[0].embeds[0].description.includes("لم تتم إضافة نص القانون بعد."));
});

test("rules publishing shares the existing notification function and stays within Hobby limits", async () => {
  const api = await read("../api/notifications/send.js");
  const html = await read("../index.html");
  const apiFiles = [];
  async function walk(directory) {
    for (const entry of await readdir(new URL(directory, import.meta.url), { withFileTypes: true })) {
      const relative = directory + "/" + entry.name;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && entry.name.endsWith(".js")) apiFiles.push(relative);
    }
  }
  await walk("../api");
  assert.equal(apiFiles.length, 12);
  assert.match(api, /SWAT_RULES_CHANNEL_ID = "1561775787152117770"/);
  assert.match(api, /isWebsiteAdmin\(user\)/);
  assert.match(api, /requireActivePortalStaff\(user\)/);
  assert.match(api, /user\.isOwner/);
  assert.match(api, /DISCORD_NOTIFICATION_ROLE_ID/);
  assert.match(api, /content: first \? "<@&" \+ config\.notificationRoleId/);
  assert.match(api, /allowed_mentions: first\s*\? \{ parse: \[\], roles: \[config\.notificationRoleId\] \}/);
  assert.match(api, /roleMentioned: true/);
  assert.doesNotMatch(api, /first && destination === "city"/);
  assert.match(api, /item\.type === "law"/);
  assert.match(api, /new URLSearchParams\(\{ id: "eq\.main", select: "data", limit: "1" \}\)/);
  assert.match(api, /body\.action === "publish_rule"/);
  assert.match(html, /fetch\('\/api\/notifications\/send'/);
  assert.doesNotMatch(html, /fetch\('\/api\/rules\/send'/);
});

test("rules editor exposes only law name and law text", async () => {
  const html = await read("../index.html");
  assert.match(html, /id="ruleTitleLabel"[^>]*>اسم القانون/);
  assert.match(html, /id="ruleBodyLabel"[^>]*>القانون/);
  assert.doesNotMatch(html, /id="ruleDescription(Field|Label)?"/);
  assert.doesNotMatch(html, /وصف القانون/);
  assert.match(html, /currentCanAdmin\?'<button type="button" class="btn rule-send-button"/);
  assert.match(html, /id="rulesSearch"/);
});

test("rules publishing supports two isolated Discord destinations", async () => {
  const api = await read("../api/notifications/send.js");
  const html = await read("../index.html");
  const builder = await read("../lib/rules-discord.js");
  assert.match(api, /SWAT_RULES_CHANNEL_ID = "1561775787152117770"/);
  assert.match(api, /SERVER_RULES_CHANNEL_ID = "1561481977591242812"/);
  assert.match(api, /body\.destination === undefined \? "city" : String\(body\.destination\)/);
  assert.match(api, /destination === "server" \? SERVER_RULES_CHANNEL_ID : SWAT_RULES_CHANNEL_ID/);
  assert.match(api, /first && destination === "city"/);
  assert.match(api, /encodeURIComponent\(channelId\)/);
  assert.match(api, /channel_id: channelId/);
  assert.match(html, /Send to City Rules/);
  assert.match(html, /Send to Server Rules/);
  assert.match(html, /destination:target/);
  assert.match(builder, /destination === "server" \? "SERVER RULES" : "S\.W\.A\.T\. CITY RULES"/);
  const serverMessages = buildRuleDiscordMessages({
    id: "SERVER-LAW-01", type: "law", title: "Server Code", body: "Follow server rules."
  }, "Website Admin", new Date("2026-11-11T12:00:00.000Z"), { destination: "server" });
  const cityMessages = buildRuleDiscordMessages({
    id: "CITY-LAW-01", type: "law", title: "City Code", body: "Follow city rules."
  }, "Website Admin");
  assert.match(serverMessages[0].embeds[0].title, /SERVER RULES/);
  assert.match(serverMessages[0].embeds[0].footer.text, /SERVER RULES/);
  assert.match(cityMessages[0].embeds[0].title, /OFFICIAL CITY RULES/);
  assert.match(cityMessages[0].embeds[0].footer.text, /S\.W\.A\.T\. CITY RULES/);
});
