import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { discordApiRequest } from "../../lib/discord-rest.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../../lib/portal-admin.js";
import { normalizeBotControlSettings, LOG_CATEGORIES, DEFAULT_LOGGING_EVENTS } from "../../bot/control-settings.mjs";

const STORE_ID = "swat-bot-control";
const DEFAULT_LOG_CHANNEL_ID = "1561771014977753268";
const SNOWFLAKE = /^\d{15,22}$/;

function parseCookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return result;
}
function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const split = raw.lastIndexOf(".");
  const payload = raw.slice(0, split), signature = raw.slice(split + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 ||
      (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { id: user.id, username: user.username, displayName: user.displayName || user.username, isOwner };
}
function bodyOf(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === "string") {
    try { const value = JSON.parse(req.body); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch {}
  }
  return {};
}
function reply(res, status, value) { return res.status(status).json(value); }
function safeReason(value) { return String(value || "").trim().replace(/[\r\n]/g, " ").slice(0, 400); }

async function authorize(req) {
  const user = readSession(req);
  if (!user) throw Object.assign(new Error("سجّل الدخول إلى بوابة S.W.A.T. أولًا."), { status: 401 });
  if (user.isOwner) return user;
  let allowed = false;
  try {
    allowed = await isWebsiteAdmin(user);
    if (allowed) await requireActivePortalStaff(user);
  } catch (error) {
    throw Object.assign(new Error(error?.message || "تعذّر التحقق من صلاحية الإدارة."), { status: error?.status || 503 });
  }
  if (!allowed) throw Object.assign(new Error("لوحة تحكم البوت متاحة للمالك وWebsite Admin فقط."), { status: 403 });
  return { ...user, isWebsiteAdmin: true };
}
function getConfig() {
  const token = String(process.env.DISCORD_BOT_TOKEN || "");
  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!token || !SNOWFLAKE.test(guildId)) throw Object.assign(new Error("إعدادات اتصال Discord غير مكتملة في Cloudflare."), { status: 503 });
  if (!base || !key) throw Object.assign(new Error("اتصال قاعدة البيانات غير مكتمل."), { status: 503 });
  return { token, guildId, base, key };
}
async function discord(cfg, path, init = {}) {
  try {
    return await discordApiRequest(cfg.token, path, init, { maxRetries: 2, maxRetryWaitMs: 6000 });
  } catch (error) {
    const status = Number(error?.status || 502);
    const message = status === 401 ? "رفض Discord توكن البوت."
      : status === 403 ? "البوت لا يملك الصلاحية المطلوبة أو لا يستطيع الوصول إلى هذا العنصر."
      : status === 404 ? "العنصر المطلوب غير موجود داخل السيرفر."
      : status === 429 ? "Discord وضع حدًا مؤقتًا للطلبات. انتظر قليلًا ثم حاول مرة أخرى."
      : "تعذر تنفيذ طلب Discord.";
    throw Object.assign(new Error(message), { status: status === 429 ? 503 : status, discordCode: error?.code || null });
  }
}
async function supabase(cfg, path, init = {}) {
  return fetch(cfg.base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}
async function readStoredSettings(cfg) {
  const query = new URLSearchParams({ id: "eq." + STORE_ID, select: "data,updated_at,updated_by", limit: "1" });
  const response = await supabase(cfg, "app_state?" + query);
  if (!response.ok) throw Object.assign(new Error("تعذرت قراءة إعدادات مركز تحكم البوت."), { status: 502 });
  const rows = await response.json();
  return {
    data: rows[0]?.data && typeof rows[0].data === "object" ? rows[0].data : {},
    updatedAt: rows[0]?.updated_at || null,
    updatedBy: rows[0]?.updated_by || null
  };
}

async function writeStoredSettings(cfg, user, data) {
  const response = await supabase(cfg, "app_state?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      id: STORE_ID,
      data,
      updated_at: new Date().toISOString(),
      updated_by: String(user.id)
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Bot control settings save failed:", response.status, detail.slice(0, 350));
    throw Object.assign(new Error("تعذر حفظ إعدادات البوت في قاعدة البيانات."), { status: 502 });
  }
  const rows = await response.json().catch(() => []);
  return {
    data: rows[0]?.data && typeof rows[0].data === "object" ? rows[0].data : data,
    updatedAt: rows[0]?.updated_at || new Date().toISOString(),
    updatedBy: rows[0]?.updated_by || String(user.id)
  };
}

async function validateBotControlSettings(cfg, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("إعدادات مركز تحكم البوت غير صالحة."), { status: 400 });
  }
  const settings = normalizeBotControlSettings({ botControl: raw }, process.env.DISCORD_LOG_CHANNEL_ID || DEFAULT_LOG_CHANNEL_ID);
  const logging = settings.logging;
  const ids = new Set();
  if (logging.defaultChannelId) ids.add(logging.defaultChannelId);
  for (const value of Object.values(logging.categories)) if (value.channelId) ids.add(value.channelId);
  if (settings.welcome.channelId) ids.add(settings.welcome.channelId);
  if (settings.welcome.goodbyeChannelId) ids.add(settings.welcome.goodbyeChannelId);

  for (const channelId of ids) {
    if (!SNOWFLAKE.test(channelId)) throw Object.assign(new Error("يوجد معرّف روم غير صالح."), { status: 400 });
    const channel = await discord(cfg, "/channels/" + channelId);
    if (String(channel.guild_id || "") !== cfg.guildId || ![0, 5].includes(Number(channel.type))) {
      throw Object.assign(new Error("كل رومات اللوجات والترحيب لازم تكون قنوات نصية من نفس السيرفر."), { status: 400 });
    }
  }

  if (settings.logging.enabled && !settings.logging.defaultChannelId &&
      !Object.values(settings.logging.categories).some(item => item.enabled && item.channelId)) {
    throw Object.assign(new Error("حدد رومًا افتراضيًا للوجات أو رومًا لكل قسم."), { status: 400 });
  }
  if (settings.welcome.enabled && !settings.welcome.channelId) {
    throw Object.assign(new Error("لتفعيل الترحيب، اختر روم الترحيب أولًا."), { status: 400 });
  }
  if (settings.welcome.goodbyeEnabled && (!settings.welcome.goodbyeChannelId || !settings.welcome.goodbyeMessage)) {
    throw Object.assign(new Error("لتفعيل رسالة المغادرة، اختر رومًا واكتب رسالة المغادرة أولًا."), { status: 400 });
  }
  const rawWelcome = raw.welcome || {};
  const rawImage = rawWelcome.image && typeof rawWelcome.image === "object" ? rawWelcome.image : {};
  if ((rawWelcome.imageUrl && !settings.welcome.imageUrl) ||
      (rawImage.backgroundImageUrl && !settings.welcome.image.backgroundImageUrl)) {
    throw Object.assign(new Error("رابط صورة الخلفية لازم يكون HTTPS صالحًا."), { status: 400 });
  }
  if (rawImage.template === "custom" && !settings.welcome.image.backgroundImageUrl) {
    throw Object.assign(new Error("أدخل رابط صورة خلفية صالحًا لاستخدام القالب المخصص."), { status: 400 });
  }
  for (const key of ["backgroundColor", "overlayColor", "accentColor", "nameColor"]) {
    if (rawImage[key] && !/^#[0-9a-f]{6}$/i.test(String(rawImage[key]).trim())) {
      throw Object.assign(new Error("اختَر لونًا صالحًا لصورة الترحيب."), { status: 400 });
    }
  }
  if (rawImage.layout && !["classic", "text", "left", "right"].includes(rawImage.layout)) {
    throw Object.assign(new Error("تخطيط صورة الترحيب غير مدعوم."), { status: 400 });
  }
  if (rawImage.template && !["redline-operator", "custom"].includes(rawImage.template)) {
    throw Object.assign(new Error("قالب صورة الترحيب غير مدعوم."), { status: 400 });
  }
  if (rawImage.avatarShape && !["circle", "square"].includes(rawImage.avatarShape)) {
    throw Object.assign(new Error("شكل صورة العضو غير مدعوم."), { status: 400 });
  }
  if (rawImage.font && !["condensed", "discord", "inter", "arabic", "serif"].includes(rawImage.font)) {
    throw Object.assign(new Error("الخط المختار غير مدعوم."), { status: 400 });
  }
  const numericRanges = {
    avatarX: [0, 100], avatarY: [0, 100], avatarSize: [8, 35],
    nameX: [0, 100], nameY: [0, 100], nameSize: [2, 10], nameWidth: [10, 65]
  };
  for (const [key, [min, max]] of Object.entries(numericRanges)) {
    if (rawImage[key] === undefined) continue;
    const value = Number(rawImage[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw Object.assign(new Error("مكان أو حجم صورة الترحيب غير صالح."), { status: 400 });
    }
  }
  if (rawImage.overlayOpacity !== undefined &&
      (!Number.isInteger(Number(rawImage.overlayOpacity)) || Number(rawImage.overlayOpacity) < 0 || Number(rawImage.overlayOpacity) > 70)) {
    throw Object.assign(new Error("شفافية الطبقة لازم تكون بين 0 و70."), { status: 400 });
  }
  return settings;
}
async function writeAudit(cfg, user, action, entityId, details = {}) {
  const response = await supabase(cfg, "audit_logs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      actor_discord_id: user.id,
      actor_name: user.displayName || user.username,
      action,
      entity_type: "discord_bot_control",
      entity_id: entityId ? String(entityId) : null,
      details
    })
  });
  if (!response.ok) console.error("Bot command center audit insert failed:", response.status, (await response.text()).slice(0, 250));
  return response.ok;
}
function userAvatar(user) {
  if (!user?.id) return null;
  return user.avatar
    ? "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=128"
    : "https://cdn.discordapp.com/embed/avatars/0.png";
}
async function overview(cfg) {
  const [bot, guild, roles, channels, automodResult] = await Promise.all([
    discord(cfg, "/users/@me"),
    discord(cfg, "/guilds/" + cfg.guildId + "?with_counts=true"),
    discord(cfg, "/guilds/" + cfg.guildId + "/roles"),
    discord(cfg, "/guilds/" + cfg.guildId + "/channels"),
    discord(cfg, "/guilds/" + cfg.guildId + "/auto-moderation/rules").then(rules => ({ available: true, rules: Array.isArray(rules) ? rules : [] }))
      .catch(error => {
        if ([403, 404].includes(Number(error?.status))) return { available: false, rules: [] };
        throw error;
      })
  ]);
  const sortedRoles = (Array.isArray(roles) ? roles : [])
    .map(role => ({ id: String(role.id), name: String(role.name), color: Number(role.color || 0), position: Number(role.position || 0), managed: Boolean(role.managed), mentionable: Boolean(role.mentionable) }))
    .sort((a, b) => b.position - a.position);
  const sortedChannels = (Array.isArray(channels) ? channels : [])
    .filter(channel => [0, 2, 4, 5, 13, 15, 16].includes(Number(channel.type)))
    .map(channel => ({ id: String(channel.id), name: String(channel.name || "بدون اسم"), type: Number(channel.type), parentId: channel.parent_id ? String(channel.parent_id) : null, position: Number(channel.position || 0) }))
    .sort((a, b) => a.position - b.position);
  return {
    bot: { id: String(bot.id), username: String(bot.username), globalName: bot.global_name || null, avatar: userAvatar(bot), apiAuthenticated: true },
    guild: {
      id: String(guild.id), name: String(guild.name || "Discord Server"),
      icon: guild.icon ? "https://cdn.discordapp.com/icons/" + guild.id + "/" + guild.icon + ".png?size=128" : null,
      approximateMemberCount: Number(guild.approximate_member_count || 0),
      approximatePresenceCount: Number(guild.approximate_presence_count || 0),
      ownerId: String(guild.owner_id || "")
    },
    roles: sortedRoles,
    channels: sortedChannels,
    automod: {
      available: automodResult.available,
      rules: automodResult.rules.map(rule => ({
        id: String(rule.id),
        name: String(rule.name || ""),
        triggerType: Number(rule.trigger_type || 0),
        eventType: Number(rule.event_type || 0),
        enabled: Boolean(rule.enabled),
        keywordCount: Array.isArray(rule.trigger_metadata?.keyword_filter) ? rule.trigger_metadata.keyword_filter.length : 0,
        mentionLimit: Number(rule.trigger_metadata?.mention_total_limit || 0),
        actions: Array.isArray(rule.actions) ? rule.actions.map(action => Number(action.type)) : []
      }))
    },
    connection: {
      rest: "verified",
      gateway: "not_measured",
      note: "REST authentication is verified. Gateway heartbeat is not yet exposed by the existing bot worker."
    }
  };
}
async function saveBotControlSettings(req, res, user, cfg, body) {
  if (!requireSameOrigin(req, res)) return;
  const settings = await validateBotControlSettings(cfg, body.settings);
  const stored = await readStoredSettings(cfg);
  const data = {
    ...stored.data,
    botControl: {
      logging: settings.logging,
      welcome: settings.welcome
    }
  };
  const saved = await writeStoredSettings(cfg, user, data);
  await writeAudit(cfg, user, "update_bot_control_settings", STORE_ID, {
    type: "تحديث إعدادات اللوجات والترحيب",
    logging_enabled: settings.logging.enabled,
    categories_enabled: Object.fromEntries(Object.entries(settings.logging.categories).map(([key, value]) => [key, value.enabled])),
    welcome_enabled: settings.welcome.enabled,
    goodbye_enabled: settings.welcome.goodbyeEnabled
  });
  return reply(res, 200, {
    ok: true,
    botControl: settings,
    updatedAt: saved.updatedAt,
    updatedBy: saved.updatedBy,
    propagation: "The running bot polls shared settings every 15 seconds."
  });
}

async function sendLogTest(req, res, user, cfg, body) {
  if (!requireSameOrigin(req, res)) return;
  const channelId = String(body.channelId || process.env.DISCORD_LOG_CHANNEL_ID || DEFAULT_LOG_CHANNEL_ID);
  if (!SNOWFLAKE.test(channelId)) return reply(res, 400, { error: "اختر روم لوجات صحيحًا." });
  const channel = await discord(cfg, "/channels/" + channelId);
  if (String(channel.guild_id || "") !== cfg.guildId || ![0, 5].includes(Number(channel.type))) {
    return reply(res, 400, { error: "روم الاختبار يجب أن تكون قناة نصية في نفس السيرفر." });
  }
  const sent = await discord(cfg, "/channels/" + channelId + "/messages", {
    method: "POST",
    body: JSON.stringify({
      embeds: [{
        color: 0x35b779,
        title: "✅ اختبار نظام اللوجات",
        description: "نجح الاتصال من لوحة تحكم S.W.A.T. REDLINE.",
        footer: { text: "S.W.A.T. REDLINE • SERVER LOGS" },
        timestamp: new Date().toISOString()
      }],
      allowed_mentions: { parse: [] }
    })
  });
  await writeAudit(cfg, user, "test_bot_log_channel", channelId, {
    type: "اختبار روم اللوجات",
    channel_id: channelId,
    message_id: String(sent?.id || "")
  });
  return reply(res, 200, { ok: true, messageId: String(sent?.id || ""), channelName: String(channel.name || "") });
}

async function checkRoleHierarchy(cfg, targetId, roleId = null) {
  if (!SNOWFLAKE.test(targetId) || targetId === process.env.DISCORD_OWNER_ID) {
    throw Object.assign(new Error("معرّف العضو غير صالح أو محمي من التعديل."), { status: 400 });
  }
  const [bot, roles, target] = await Promise.all([
    discord(cfg, "/users/@me"),
    discord(cfg, "/guilds/" + cfg.guildId + "/roles"),
    discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId)
  ]);
  const botMember = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + bot.id);
  const roleList = Array.isArray(roles) ? roles : [];
  const positionOf = id => Number(roleList.find(role => String(role.id) === String(id))?.position || 0);
  const botTop = Math.max(0, ...(botMember.roles || []).map(positionOf));
  const targetTop = Math.max(0, ...(target.roles || []).map(positionOf));
  if (!botTop) throw Object.assign(new Error("تعذر تحديد ترتيب رتب البوت. تأكد من صلاحياته."), { status: 403 });
  if (targetTop >= botTop) throw Object.assign(new Error("لا يمكن للبوت تعديل عضو رتبته مساوية أو أعلى من أعلى رتبة لديه."), { status: 403 });
  if (roleId) {
    const role = roleList.find(item => String(item.id) === roleId);
    if (!role || role.managed || String(role.id) === cfg.guildId) throw Object.assign(new Error("الرتبة غير متاحة للإدارة."), { status: 400 });
    if (Number(role.position || 0) >= botTop) throw Object.assign(new Error("رتبة البوت يجب أن تكون أعلى من الرتبة المطلوب إدارتها."), { status: 403 });
  }
}

async function searchMentionMembers(cfg, query) {
  const params = new URLSearchParams({ query, limit: "25" });
  let members;
  try {
    members = await discord(cfg, "/guilds/" + cfg.guildId + "/members/search?" + params.toString());
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw Object.assign(new Error("البوت غير قادر على البحث عن أعضاء السيرفر. فعّل GUILD_MEMBERS Privileged Intent من Discord Developer Portal ثم جرّب مرة أخرى."), { status: 403 });
    }
    throw error;
  }
  return (Array.isArray(members) ? members : [])
    .filter(member => member?.user?.id && SNOWFLAKE.test(String(member.user.id)))
    .map(member => ({
      id: String(member.user.id),
      username: String(member.user.username || ""),
      displayName: String(member.nick || member.user.global_name || member.user.username || "Discord user")
    }));
}

async function resolveMessageMention(cfg, body) {
  const type = String(body.mentionType || "none");
  const targetId = String(body.mentionTargetId || "");
  if (type === "none") return { type, prefix: "", allowedMentions: { parse: [] }, targetId: "", targetName: "" };
  if (type === "everyone" || type === "here") {
    return {
      type,
      prefix: type === "everyone" ? "@everyone" : "@here",
      allowedMentions: { parse: ["everyone"] },
      targetId: "",
      targetName: type === "everyone" ? "@everyone" : "@here"
    };
  }
  if (type === "role") {
    if (!SNOWFLAKE.test(targetId) || targetId === cfg.guildId) {
      throw Object.assign(new Error("اختر رتبة صحيحة للمنشن."), { status: 400 });
    }
    const roles = await discord(cfg, "/guilds/" + cfg.guildId + "/roles");
    const role = (Array.isArray(roles) ? roles : []).find(item => String(item.id) === targetId);
    if (!role) throw Object.assign(new Error("الرتبة المحددة ليست موجودة في هذا السيرفر."), { status: 400 });
    return {
      type,
      prefix: "<@&" + targetId + ">",
      allowedMentions: { parse: [], roles: [targetId] },
      targetId,
      targetName: String(role.name || "")
    };
  }
  if (type === "user") {
    if (!SNOWFLAKE.test(targetId)) {
      throw Object.assign(new Error("اختر عضوًا صحيحًا للمنشن."), { status: 400 });
    }
    let member;
    try {
      member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId);
    } catch (error) {
      if (Number(error?.status) === 404) {
        throw Object.assign(new Error("العضو المحدد لم يعد موجودًا في هذا السيرفر."), { status: 400 });
      }
      throw error;
    }
    const user = member?.user || {};
    return {
      type,
      prefix: "<@" + targetId + ">",
      allowedMentions: { parse: [], users: [targetId] },
      targetId,
      targetName: String(member.nick || user.global_name || user.username || targetId)
    };
  }
  throw Object.assign(new Error("نوع المنشن المحدد غير مدعوم."), { status: 400 });
}

function applyMessageMention(content, mention) {
  let safeContent = String(content || "");
  if (mention.type === "everyone") safeContent = safeContent.replace(/@here/gi, "@\u200Bhere");
  if (mention.type === "here") safeContent = safeContent.replace(/@everyone/gi, "@\u200Beveryone");
  return mention.prefix ? mention.prefix + (safeContent ? "\n" + safeContent : "") : safeContent;
}

async function handlePost(req, res, user, cfg) {
  if (!requireSameOrigin(req, res)) return;
  const body = bodyOf(req);
  const action = String(body.action || "");
  if (action === "save_bot_settings") return saveBotControlSettings(req, res, user, cfg, body);
  if (action === "test_log") return sendLogTest(req, res, user, cfg, body);
  if (action === "search_members") {
    const query = String(body.query || "").trim().slice(0, 80);
    if (query.length < 2) return reply(res, 400, { error: "اكتب حرفين على الأقل للبحث عن عضو." });
    const members = await searchMentionMembers(cfg, query);
    return reply(res, 200, { ok: true, members });
  }
  if (action === "send_message") {
    const channelId = String(body.channelId || "");
    const content = String(body.content || "").trim();
    if (!SNOWFLAKE.test(channelId) || !content || content.length > 2000) return reply(res, 400, { error: "اختر قناة صحيحة واكتب رسالة من 1 إلى 2000 حرف." });
    const channel = await discord(cfg, "/channels/" + channelId);
    if (String(channel.guild_id || "") !== cfg.guildId || ![0, 5].includes(Number(channel.type))) return reply(res, 400, { error: "يمكن الإرسال إلى قنوات النصوص والإعلانات التابعة لهذا السيرفر فقط." });
    const mention = await resolveMessageMention(cfg, body);
    const outgoingContent = applyMessageMention(content, mention);
    if (!outgoingContent || outgoingContent.length > 2000) return reply(res, 400, { error: "محتوى الرسالة بعد إضافة المنشن يجب ألا يتجاوز 2000 حرف." });
    const sent = await discord(cfg, "/channels/" + channelId + "/messages", {
      method: "POST",
      body: JSON.stringify({ content: outgoingContent, allowed_mentions: mention.allowedMentions })
    });
    await writeAudit(cfg, user, "send", sent?.id || channelId, {
      type: "إرسال رسالة من مركز تحكم البوت",
      channel_id: channelId, channel_name: String(channel.name || ""),
      message_id: String(sent?.id || ""), content_preview: outgoingContent.slice(0, 180),
      mention_type: mention.type, mention_target_id: mention.targetId || null, mention_target_name: mention.targetName || null
    });
    return reply(res, 200, { ok: true, messageId: String(sent?.id || ""), channelName: String(channel.name || "") });
  }
  if (action === "send_embed") {
    const channelId = String(body.channelId || "");
    const title = String(body.title || "").trim().slice(0, 256);
    const description = String(body.description || "").trim().slice(0, 4096);
    const footer = String(body.footer || "").trim().slice(0, 2048);
    const colorInput = String(body.color || "#ed3545").trim();
    if (!SNOWFLAKE.test(channelId) || (!title && !description)) {
      return reply(res, 400, { error: "اختر قناة واكتب عنوانًا أو وصفًا للـ Embed." });
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(colorInput)) return reply(res, 400, { error: "لون الـ Embed غير صالح." });
    const channel = await discord(cfg, "/channels/" + channelId);
    if (String(channel.guild_id || "") !== cfg.guildId || ![0, 5].includes(Number(channel.type))) {
      return reply(res, 400, { error: "يمكن الإرسال إلى قنوات النصوص والإعلانات التابعة لهذا السيرفر فقط." });
    }
    const embed = { color: Number.parseInt(colorInput.slice(1), 16) };
    if (title) embed.title = title;
    if (description) embed.description = description;
    if (footer) embed.footer = { text: footer };
    const mention = await resolveMessageMention(cfg, body);
    const sent = await discord(cfg, "/channels/" + channelId + "/messages", {
      method: "POST",
      body: JSON.stringify({ content: mention.prefix || undefined, embeds: [embed], allowed_mentions: mention.allowedMentions })
    });
    await writeAudit(cfg, user, "send_embed", sent?.id || channelId, {
      type: "إرسال Embed من مركز تحكم البوت",
      channel_id: channelId,
      channel_name: String(channel.name || ""),
      message_id: String(sent?.id || ""),
      title: title.slice(0, 120),
      description_preview: description.slice(0, 180),
      mention_type: mention.type, mention_target_id: mention.targetId || null, mention_target_name: mention.targetName || null
    });
    return reply(res, 200, { ok: true, messageId: String(sent?.id || ""), channelName: String(channel.name || "") });
  }
  if (action === "add_role" || action === "remove_role") {
    const targetId = String(body.userId || ""), roleId = String(body.roleId || "");
    if (!SNOWFLAKE.test(roleId)) return reply(res, 400, { error: "اختر رتبة صحيحة." });
    await checkRoleHierarchy(cfg, targetId, roleId);
    const method = action === "add_role" ? "PUT" : "DELETE";
    await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId + "/roles/" + roleId, { method });
    await writeAudit(cfg, user, action === "add_role" ? "assign_role" : "remove_role", targetId, {
      type: action === "add_role" ? "إضافة رتبة" : "إزالة رتبة", target_discord_id: targetId, role_id: roleId
    });
    return reply(res, 200, { ok: true });
  }
  if (action === "create_automod_rule") {
    const name = String(body.name || "").trim().slice(0, 100);
    const kind = String(body.kind || "keyword");
    if (!name) return reply(res, 400, { error: "اكتب اسمًا واضحًا للقاعدة." });
    let triggerType = 1;
    let triggerMetadata = {};
    if (kind === "keyword") {
      const keywords = [...new Set(String(body.keywords || "").split(/[\n,،]/).map(value => value.trim()).filter(Boolean))];
      if (!keywords.length || keywords.length > 100 || keywords.some(value => value.length > 60)) {
        return reply(res, 400, { error: "أدخل من كلمة واحدة إلى 100 كلمة، على ألا تتجاوز الكلمة 60 حرفًا." });
      }
      triggerType = 1;
      triggerMetadata = { keyword_filter: keywords };
    } else if (kind === "mention_spam") {
      const limit = Number(body.mentionLimit || 5);
      if (!Number.isInteger(limit) || limit < 2 || limit > 50) return reply(res, 400, { error: "حد المنشن يجب أن يكون بين 2 و50." });
      triggerType = 5;
      triggerMetadata = { mention_total_limit: limit };
    } else {
      return reply(res, 400, { error: "نوع قاعدة AutoMod غير مدعوم." });
    }
    const actions = [{ type: 1 }];
    const alertChannelId = String(body.alertChannelId || "");
    if (alertChannelId) {
      if (!SNOWFLAKE.test(alertChannelId)) return reply(res, 400, { error: "قناة التنبيه غير صالحة." });
      const channel = await discord(cfg, "/channels/" + alertChannelId);
      if (String(channel.guild_id || "") !== cfg.guildId || ![0, 5].includes(Number(channel.type))) {
        return reply(res, 400, { error: "اختر قناة نصية من نفس السيرفر لإرسال تنبيهات القاعدة." });
      }
      actions.push({ type: 2, metadata: { channel_id: alertChannelId } });
    }
    const created = await discord(cfg, "/guilds/" + cfg.guildId + "/auto-moderation/rules", {
      method: "POST",
      body: JSON.stringify({
        name,
        event_type: 1,
        trigger_type: triggerType,
        trigger_metadata: triggerMetadata,
        actions,
        enabled: true,
        exempt_roles: [],
        exempt_channels: []
      })
    });
    await writeAudit(cfg, user, "create_automod_rule", created?.id, {
      type: "إنشاء قاعدة Auto Moderation",
      rule_name: name,
      trigger_type: triggerType,
      keyword_count: triggerType === 1 ? triggerMetadata.keyword_filter.length : null
    });
    return reply(res, 200, { ok: true, ruleId: String(created?.id || "") });
  }
  if (action === "toggle_automod_rule") {
    const ruleId = String(body.ruleId || "");
    if (!SNOWFLAKE.test(ruleId) || typeof body.enabled !== "boolean") return reply(res, 400, { error: "بيانات القاعدة غير صالحة." });
    const updated = await discord(cfg, "/guilds/" + cfg.guildId + "/auto-moderation/rules/" + ruleId, {
      method: "PATCH", body: JSON.stringify({ enabled: body.enabled })
    });
    await writeAudit(cfg, user, body.enabled ? "enable_automod_rule" : "disable_automod_rule", ruleId, {
      type: body.enabled ? "تفعيل قاعدة AutoMod" : "إيقاف قاعدة AutoMod",
      rule_name: String(updated?.name || "")
    });
    return reply(res, 200, { ok: true });
  }
  if (action === "delete_automod_rule") {
    const ruleId = String(body.ruleId || "");
    if (!SNOWFLAKE.test(ruleId)) return reply(res, 400, { error: "معرّف القاعدة غير صالح." });
    await discord(cfg, "/guilds/" + cfg.guildId + "/auto-moderation/rules/" + ruleId, { method: "DELETE" });
    await writeAudit(cfg, user, "delete_automod_rule", ruleId, { type: "حذف قاعدة AutoMod" });
    return reply(res, 200, { ok: true });
  }
  if (action === "moderate") {
    const targetId = String(body.userId || ""), kind = String(body.kind || "");
    const reason = safeReason(body.reason) || "S.W.A.T. REDLINE moderation";
    if (!SNOWFLAKE.test(targetId) || targetId === process.env.DISCORD_OWNER_ID || targetId === user.id) return reply(res, 400, { error: "معرّف العضو غير صالح أو لا يمكن استهداف هذا الحساب." });
    const auditHeaders = { "X-Audit-Log-Reason": encodeURIComponent(reason) };
    if (kind === "unban") {
      await discord(cfg, "/guilds/" + cfg.guildId + "/bans/" + targetId, { method: "DELETE", headers: auditHeaders });
    } else {
      await checkRoleHierarchy(cfg, targetId);
      if (kind === "timeout") {
        const minutes = Number(body.minutes || 10);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) return reply(res, 400, { error: "مدة Timeout يجب أن تكون من دقيقة إلى 28 يومًا." });
        const until = new Date(Date.now() + minutes * 60_000).toISOString();
        await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
          method: "PATCH", headers: auditHeaders,
          body: JSON.stringify({ communication_disabled_until: until })
        });
      } else if (kind === "kick") {
        await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, { method: "DELETE", headers: auditHeaders });
      } else if (kind === "ban") {
        await discord(cfg, "/guilds/" + cfg.guildId + "/bans/" + targetId, {
          method: "PUT", headers: auditHeaders,
          body: JSON.stringify({ delete_message_seconds: 0 })
        });
      } else {
        return reply(res, 400, { error: "إجراء إشراف غير معروف." });
      }
    }
    await writeAudit(cfg, user, kind, targetId, {
      type: "إجراء إشرافي من مركز تحكم البوت",
      target_discord_id: targetId, reason,
      timeout_minutes: kind === "timeout" ? Number(body.minutes || 10) : null
    });
    return reply(res, 200, { ok: true });
  }
  return reply(res, 400, { error: "إجراء غير مدعوم." });
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  let user, cfg;
  try { user = await authorize(req); cfg = getConfig(); }
  catch (error) { return reply(res, error?.status || 500, { error: error?.message || "تعذر التحقق من صلاحيات مركز التحكم." }); }
  if (req.method === "GET") {
    try {
      const stored = await readStoredSettings(cfg);
      let server;
      let serverError = null;
      try {
        server = await overview(cfg);
      } catch (error) {
        serverError = error?.message || "Discord REST unavailable";
        server = {
          bot: null,
          guild: { id: cfg.guildId, name: "Discord server", approximateMemberCount: 0, approximatePresenceCount: 0 },
          roles: [],
          channels: [],
          automod: { available: false, rules: [] },
          connection: { rest: "unavailable", gateway: "not_measured", error: serverError }
        };
      }
      const botControl = normalizeBotControlSettings(stored.data, process.env.DISCORD_LOG_CHANNEL_ID || DEFAULT_LOG_CHANNEL_ID);
      return reply(res, 200, {
        ok: true,
        user: { id: user.id, displayName: user.displayName, isOwner: Boolean(user.isOwner) },
        ...server,
        botControl,
        stored: { data: stored.data, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy },
        capabilities: [
          { id: "member_directory", label: "دليل الأفراد وإدارة الحسابات", status: "existing" },
          { id: "warnings", label: "التحذيرات والقضايا التأديبية", status: "existing" },
          { id: "notifications", label: "إرسال الرسائل والإعلانات", status: "existing" },
          { id: "attendance", label: "البصمة وطلبات الإجازات", status: "existing" },
          { id: "attention_alerts", label: "Attention Alert", status: "existing" },
          { id: "logging_control", label: "التحكم الكامل في اللوجات", status: "available_now" },
          { id: "welcome_automation", label: "الترحيب والمغادرة الآليان", status: "available_now" },
          { id: "role_management", label: "إضافة وإزالة رتب Discord", status: "available_now" },
          { id: "moderation_actions", label: "Timeout / Kick / Ban", status: "available_now" },
          { id: "automod", label: "Discord Auto Moderation rules", status: server.automod?.available ? "available_now" : "needs_permission" },
          { id: "tickets", label: "نظام التذاكر", status: "needs_gateway" },
          { id: "leveling", label: "المستويات وXP", status: "needs_gateway" },
          { id: "social_feeds", label: "YouTube / Twitch / Kick / RSS", status: "needs_integrations" }
        ]
      });
    } catch (error) {
      return reply(res, error?.status || 502, { error: error?.message || "تعذر تحميل بيانات Discord." });
    }
  }
  if (req.method === "POST") {
    try { return await handlePost(req, res, user, cfg); }
    catch (error) {
      console.error("Bot command center action failed:", error?.status || error?.message || "unknown");
      return reply(res, error?.status || 502, { error: error?.message || "تعذر تنفيذ العملية." });
    }
  }
  res.setHeader("Allow", "GET, POST");
  return reply(res, 405, { error: "Method not allowed." });
}
