import { PermissionsBitField } from "discord.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createGuildLogService } from "./guild-logs.mjs";

function harness(options = {}) {
  const sent = [];
  const warnings = [];
  const channel = {
    id: "72345678901234567",
    guildId: "12345678901234567",
    name: "swat-logs",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => { sent.push(payload); return { id: String(sent.length) }; }
  };
  const client = {
    user: { id: "92345678901234567" },
    channels: { fetch: async () => channel }
  };
  const service = createGuildLogService({
    client,
    guildId: channel.guildId,
    channelId: channel.id,
    enabled: () => options.enabled !== false,
    getSettings: () => options.settings || {},
    logger: { warn: (...values) => warnings.push(values) },
    now: () => new Date("2026-11-25T08:00:00.000Z").getTime()
  });
  return { service, sent, warnings, channel };
}

test("verifies the configured log channel belongs to the expected guild", async () => {
  const { service } = harness();
  assert.deepEqual(await service.verify(), {
    ok: true,
    channelId: "72345678901234567",
    guildId: "12345678901234567",
    category: "messages"
  });
});

test("sends a deleted message log without allowing mentions", async () => {
  const { service, sent } = harness();
  const ok = await service.messageDeleted({
    id: "82345678901234567",
    guildId: "12345678901234567",
    channelId: "72345678901234567",
    channel: { id: "72345678901234567", name: "general" },
    author: { id: "92345678901234567", username: "Member", bot: false },
    content: "hello @everyone",
    attachments: new Map([["1", { name: "image.png" }]])
  });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].title, /حذف رسالة/);
  assert.match(sent[0].embeds[0].fields.find(field => field.name === "محتوى الرسالة").value, /@ everyone/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
});

test("ignores bot messages and message edits that did not change content", async () => {
  const { service, sent } = harness();
  assert.equal(await service.messageDeleted({
    guildId: "12345678901234567",
    author: { id: "1", username: "Bot", bot: true }
  }), false);
  assert.equal(await service.messageUpdated(
    { guildId: "12345678901234567", content: "same" },
    { guildId: "12345678901234567", content: "same", author: { bot: false } }
  ), false);
  assert.equal(sent.length, 0);
});

test("records member role changes from the Discord audit log", async () => {
  const { service, sent } = harness();
  assert.equal(await service.auditLogEntry({
    action: 25,
    executor: { id: "82345678901234567", username: "Moderator" },
    target: { id: "92345678901234567", username: "Member" },
    changes: [{ key: "$add", new_value: [{ id: "role-new", name: "New Role" }] }],
    reason: "Promotion"
  }, { id: "12345678901234567" }), true);
  assert.equal(sent.length, 1);
  const fields = sent[0].embeds[0].fields;
  assert.match(fields.find(field => field.name === "منفذ الإجراء").value, /Moderator/);
  assert.equal(fields.find(field => field.name === "السبب").value, "Promotion");
});

test("logs channel permission overwrite create, update and delete with decoded permissions", async () => {
  const { service, sent } = harness();
  const guild = { id: "12345678901234567" };
  const role = { id: "62345678901234567", name: "REDLINE S.W.A.T" };
  const channel = { id: "72345678901234567", name: "swat-logs" };
  const viewChannel = String(PermissionsBitField.Flags.ViewChannel);

  assert.equal(await service.auditLogEntry({
    action: 13,
    executor: { id: "82345678901234567", username: "Yassin" },
    target: role, targetId: role.id,
    extra: { id: role.id, type: "0", role_name: role.name, channel },
    changes: [{ key: "allow", new_value: viewChannel }, { key: "deny", new_value: "0" }]
  }, guild), true);

  assert.equal(await service.auditLogEntry({
    action: 14,
    executor: { id: "82345678901234567", username: "Yassin" },
    target: role, targetId: role.id,
    extra: { id: role.id, type: "0", role_name: role.name, channel },
    changes: [
      { key: "allow", old_value: "0", new_value: viewChannel },
      { key: "deny", old_value: viewChannel, new_value: "0" }
    ]
  }, guild), true);

  assert.equal(await service.auditLogEntry({
    action: 15,
    executor: { id: "82345678901234567", username: "Yassin" },
    target: role, targetId: role.id,
    extra: { id: role.id, type: "0", role_name: role.name, channel },
    changes: [{ key: "allow", old_value: viewChannel }, { key: "deny", old_value: "0" }]
  }, guild), true);

  assert.equal(sent.length, 3);
  assert.match(sent[0].embeds[0].title, /إضافة صلاحيات/);
  assert.match(sent[1].embeds[0].title, /تعديل صلاحيات/);
  assert.match(sent[2].embeds[0].title, /إزالة صلاحيات/);
  const updateFields = sent[1].embeds[0].fields;
  assert.match(updateFields.find(field => field.name === "القناة").value, /swat-logs/);
  assert.match(updateFields.find(field => field.name === "الرتبة المستهدفة").value, /REDLINE S.W.A.T/);
  assert.match(updateFields.find(field => field.name.includes("المسموح بها")).value, /عرض القناة/);
});

test("routes every known and future audit action to an enabled log category", async () => {
  const { service, sent } = harness();
  const guild = { id: "12345678901234567" };
  assert.equal(await service.auditLogEntry({
    action: 1,
    executor: { id: "82345678901234567", username: "Owner" },
    targetId: guild.id,
    changes: [{ key: "name", old_value: "Old", new_value: "New" }]
  }, guild), true);
  assert.equal(await service.auditLogEntry({
    action: 121,
    executor: { id: "82345678901234567", username: "Owner" },
    targetId: "62345678901234567",
    changes: [{ key: "permissions", old_value: "0", new_value: "1" }]
  }, guild), true);
  assert.equal(await service.auditLogEntry({
    action: 999,
    executor: { id: "82345678901234567", username: "Owner" },
    targetId: "62345678901234567"
  }, guild), true);
  assert.equal(sent.length, 3);
  assert.match(sent[0].embeds[0].title, /إعدادات السيرفر/);
  assert.match(sent[1].embeds[0].title, /صلاحيات أوامر التطبيقات/);
  assert.match(sent[2].embeds[0].fields.find(field => field.name === "رقم نوع الحدث").value, /999/);
});

test("records voice joins, leaves, and moves", async () => {
  const { service, sent } = harness();
  const guild = { id: "12345678901234567" };
  const member = { user: { id: "92345678901234567", username: "Member" } };
  await service.voiceStateUpdated(
    { guild, channelId: null, channel: null, member },
    { guild, channelId: "72345678901234567", channel: { id: "72345678901234567", name: "Waiting" }, member }
  );
  await service.voiceStateUpdated(
    { guild, channelId: "72345678901234567", channel: { id: "72345678901234567", name: "Waiting" }, member },
    { guild, channelId: null, channel: null, member }
  );
  assert.equal(sent.length, 2);
  assert.match(sent[0].embeds[0].title, /دخل/);
  assert.match(sent[1].embeds[0].title, /غادر/);
});

test("can disable one event without disabling the whole category", async () => {
  const { service, sent } = harness({ settings: { enabled: true, events: { messageDelete: false } } });
  assert.equal(await service.messageDeleted({
    guildId: "12345678901234567",
    author: { id: "92345678901234567", username: "Member", bot: false },
    content: "blocked"
  }), false);
  assert.equal(sent.length, 0);
});

test("can disable one category while other categories remain active", async () => {
  const { service, sent } = harness({ settings: { enabled: true, categories: { messages: { enabled: false }, members: { enabled: true } } } });
  assert.equal(await service.messageDeleted({
    guildId: "12345678901234567",
    author: { id: "92345678901234567", username: "Member", bot: false },
    content: "blocked"
  }), false);
  assert.equal(await service.memberJoined({
    guild: { id: "12345678901234567" },
    user: { id: "92345678901234567", username: "Member" }
  }), true);
  assert.equal(sent.length, 1);
});

test("routes categories to their configured channels", async () => {
  const sent = [];
  const channels = new Map();
  for (const id of ["72345678901234567", "82345678901234567"]) {
    channels.set(id, {
      id, guildId: "12345678901234567", name: "logs-" + id,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async payload => { sent.push({ id, payload }); }
    });
  }
  const service = createGuildLogService({
    client: { user: { id: "92345678901234567" }, channels: { fetch: async id => channels.get(id) } },
    guildId: "12345678901234567",
    channelId: "72345678901234567",
    enabled: () => true,
    getSettings: () => ({ enabled: true, defaultChannelId: "72345678901234567", categories: { voice: { enabled: true, channelId: "82345678901234567" } } })
  });
  await service.voiceStateUpdated(
    { guild: { id: "12345678901234567" }, channelId: null, channel: null, member: { user: { id: "92345678901234567", username: "Member" } } },
    { guild: { id: "12345678901234567" }, channelId: "62345678901234567", channel: { id: "62345678901234567", name: "voice" }, member: { user: { id: "92345678901234567", username: "Member" } } }
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "82345678901234567");
});

test("records channel create, update and delete events", async () => {
  const { service, sent } = harness();
  await service.channelCreated({ guildId: "12345678901234567", id: "82345678901234567", name: "new-room", type: 0 });
  await service.channelUpdated(
    { guildId: "12345678901234567", id: "82345678901234567", name: "old-room", topic: null, parentId: null },
    { guildId: "12345678901234567", id: "82345678901234567", name: "new-room", topic: null, parentId: null }
  );
  await service.channelDeleted({ guildId: "12345678901234567", id: "82345678901234567", name: "new-room" });
  assert.equal(sent.length, 3);
});

test("does not send anything while the log service is disabled", async () => {
  const { service, sent } = harness({ enabled: false });
  assert.equal(await service.memberJoined({
    guild: { id: "12345678901234567" },
    user: { id: "92345678901234567", username: "Member" }
  }), false);
  assert.equal(sent.length, 0);
});

test("records moderator and reason from supported audit-log entries", async () => {
  const { service, sent } = harness();
  assert.equal(await service.auditLogEntry({
    action: 22,
    executor: { id: "92345678901234567", username: "Moderator" },
    target: { id: "82345678901234567", username: "Member" },
    reason: "rule violation"
  }, { id: "12345678901234567" }), true);
  assert.equal(sent.length, 1);
  const fields = sent[0].embeds[0].fields;
  assert.match(fields.find(field => field.name === "منفذ الإجراء").value, /Moderator/);
  assert.equal(fields.find(field => field.name === "السبب").value, "rule violation");
});
