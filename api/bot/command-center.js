import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { discordApiRequest } from "../../lib/discord-rest.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../../lib/portal-admin.js";

const STORE_ID = "swat-bot-control";
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
async function handlePost(req, res, user, cfg) {
  if (!requireSameOrigin(req, res)) return;
  const body = bodyOf(req);
  const action = String(body.action || "");
  if (action === "send_message") {
    const channelId = String(body.channelId || "");
    const content = String(body.content || "").trim();
    if (!SNOWFLAKE.test(channelId) || !content || content.length > 2000) return reply(res, 400, { error: "اختر قناة صحيحة واكتب رسالة من 1 إلى 2000 حرف." });
    const channel = await discord(cfg, "/channels/" + channelId);
    if (String(channel.guild_id || "") !== cfg.guildId || ![0, 5].includes(Number(channel.type))) return reply(res, 400, { error: "يمكن الإرسال إلى قنوات النصوص والإعلانات التابعة لهذا السيرفر فقط." });
    const sent = await discord(cfg, "/channels/" + channelId + "/messages", {
      method: "POST",
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    });
    await writeAudit(cfg, user, "send", sent?.id || channelId, {
      type: "إرسال رسالة من مركز تحكم البوت",
      channel_id: channelId, channel_name: String(channel.name || ""),
      message_id: String(sent?.id || ""), content_preview: content.slice(0, 180)
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
      const [server, stored] = await Promise.all([overview(cfg), readStoredSettings(cfg)]);
      return reply(res, 200, {
        ok: true,
        user: { id: user.id, displayName: user.displayName, isOwner: Boolean(user.isOwner) },
        ...server,
        stored: { data: stored.data, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy },
        capabilities: [
          { id: "member_directory", label: "دليل الأفراد وإدارة الحسابات", status: "existing" },
          { id: "warnings", label: "التحذيرات والقضايا التأديبية", status: "existing" },
          { id: "notifications", label: "إرسال الرسائل والإعلانات", status: "existing" },
          { id: "attendance", label: "البصمة وطلبات الإجازات", status: "existing" },
          { id: "attention_alerts", label: "Attention Alert", status: "existing" },
          { id: "role_management", label: "إضافة وإزالة رتب Discord", status: "available_now" },
          { id: "moderation_actions", label: "Timeout / Kick / Ban", status: "available_now" },
          { id: "welcome_automation", label: "الترحيب والمغادرة الآليان", status: "needs_gateway" },
          { id: "automod", label: "Discord Auto Moderation rules", status: automodResult.available ? "available_now" : "needs_permission" },
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
