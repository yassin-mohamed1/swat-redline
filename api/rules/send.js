import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { discordApiRequest } from "../../lib/discord-rest.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../../lib/portal-admin.js";
import { buildRuleDiscordMessages } from "../../lib/rules-discord.js";
import { forwardAuditToDiscord } from "../../lib/audit-log.js";

const RULES_CHANNEL_ID = "1561775787152117770";

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    try { out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return out;
}

function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;

  const split = raw.lastIndexOf(".");
  const payload = raw.slice(0, split);
  const signature = raw.slice(split + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 ||
      (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;

  return {
    id: String(user.id),
    username: String(user.username),
    displayName: String(user.displayName || user.username),
    isOwner
  };
}

function json(res, status, body) {
  return res.status(status).json(body);
}

async function readSavedLaw() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) {
    throw Object.assign(new Error("التخزين المشترك غير مضبوط في إعدادات الموقع."), { status: 503 });
  }
  const response = await fetch(base + "/rest/v1/app_state?id=eq.main&select=data&limit=1", {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
  });
  if (!response.ok) {
    console.error("Rules Discord post could not read shared state:", response.status, (await response.text()).slice(0, 300));
    throw Object.assign(new Error("تعذر قراءة القوانين المحفوظة من قاعدة البيانات."), { status: 502 });
  }
  const rows = await response.json();
  return rows[0]?.data || null;
}

function discordFailureMessage(error) {
  const status = Number(error?.status || 0);
  if (status === 403) return "البوت لا يملك صلاحية إرسال الرسائل أو تضمين الروابط في روم SWAT Rules.";
  if (status === 404) return "لم يتم العثور على روم SWAT Rules. راجع صلاحية البوت ووصوله إلى الروم.";
  if (status === 429) return "Discord وضع حدًا مؤقتًا للإرسال. أعد المحاولة بعد انتهاء المهلة.";
  return "تعذر إرسال رسالة القانون إلى Discord. رمز الخطأ: " + String(error?.code || status || "unknown");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed." });
  }
  if (!requireSameOrigin(req, res)) return;

  const user = readSession(req);
  if (!user) return json(res, 401, { error: "يلزم تسجيل الدخول إلى بوابة S.W.A.T. REDLINE." });

  let canManageRules = Boolean(user.isOwner);
  try {
    if (!canManageRules) {
      canManageRules = await isWebsiteAdmin(user);
      if (canManageRules) await requireActivePortalStaff(user);
    }
  } catch (error) {
    return json(res, error.status || 503, { error: error.message || "تعذر التحقق من صلاحيات Website Admin." });
  }
  if (!canManageRules) {
    return json(res, 403, { error: "إرسال قوانين Discord متاح للمالك وWebsite Admin فقط." });
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  const roleId = String(process.env.DISCORD_NOTIFICATION_ROLE_ID || "");
  if (!token) return json(res, 503, { error: "اتصال بوت Discord غير مضبوط في إعدادات Vercel." });
  if (!/^\d{15,22}$/.test(roleId)) {
    return json(res, 503, { error: "رتبة منشن SWAT غير مضبوطة. راجع DISCORD_NOTIFICATION_ROLE_ID في Vercel." });
  }

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const ruleId = String(body.ruleId || "").trim();
  if (!ruleId || ruleId.length > 180) return json(res, 400, { error: "معرّف القانون غير صالح." });

  let state;
  try {
    state = await readSavedLaw();
  } catch (error) {
    return json(res, error.status || 502, { error: error.message || "تعذر قراءة القانون." });
  }
  const rules = Array.isArray(state?.rules) ? state.rules : [];
  const rule = rules.find(item => item && !Array.isArray(item) &&
    String(item.id || "") === ruleId && item.type === "law");
  if (!rule) {
    return json(res, 404, { error: "لم يتم العثور على هذا القانون ضمن القوانين المحفوظة. احفظ التعديل أولًا ثم أعد الإرسال." });
  }

  const actor = user.displayName || user.username || "S.W.A.T. Command";
  const messages = buildRuleDiscordMessages(rule, actor);
  const sentMessageIds = [];
  for (let index = 0; index < messages.length; index++) {
    const first = index === 0;
    const payload = {
      ...messages[index],
      ...(first ? { content: "<@&" + roleId + ">" } : { content: "" }),
      allowed_mentions: first ? { parse: [], roles: [roleId] } : { parse: [] }
    };
    try {
      const sent = await discordApiRequest(
        token,
        "/channels/" + encodeURIComponent(RULES_CHANNEL_ID) + "/messages",
        { method: "POST", body: JSON.stringify(payload) },
        { maxRetries: 3, maxRetryWaitMs: 8000 }
      );
      if (sent?.id) sentMessageIds.push(String(sent.id));
    } catch (error) {
      console.error("S.W.A.T. Rules Discord delivery failed:", JSON.stringify({
        status: error?.status || null,
        code: error?.code || null,
        sentMessages: index
      }));
      return json(res, 502, {
        error: discordFailureMessage(error),
        channelId: RULES_CHANNEL_ID,
        messagesSent: index,
        partial: index > 0,
        messageIds: sentMessageIds
      });
    }
  }

  const auditEvent = {
    actor_discord_id: user.id,
    actor_name: actor,
    action: "create",
    entity_type: "discord_rule_post",
    entity_id: ruleId,
    details: {
      type: "نشر قانون في Discord",
      detail: "نشر " + actor + " القانون «" + String(rule.title || "بدون عنوان").slice(0, 140) + "» في روم S.W.A.T. RULES.",
      ref: ruleId,
      channel_id: RULES_CHANNEL_ID,
      channel_message_ids: sentMessageIds
    }
  };
  try {
    const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const auditResponse = await fetch(base + "/rest/v1/audit_logs", {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(auditEvent)
    });
    if (auditResponse.ok) {
      await forwardAuditToDiscord(user, {
        action: auditEvent.action,
        entity_type: auditEvent.entity_type,
        entity_id: auditEvent.entity_id,
        details: auditEvent.details
      });
    } else {
      console.warn("S.W.A.T. rules announcement audit write failed:", auditResponse.status);
    }
  } catch (error) {
    console.warn("S.W.A.T. rules announcement audit failed:", error?.message || "unknown");
  }

  return json(res, 200, {
    ok: true,
    channelId: RULES_CHANNEL_ID,
    messagesSent: sentMessageIds.length,
    messageIds: sentMessageIds,
    roleMentioned: true
  });
}
