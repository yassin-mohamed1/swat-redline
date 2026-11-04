import crypto from "node:crypto";
import { handleAnnouncementForwarder } from "../../lib/announcement-forwarder.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RECIPIENTS_PER_BATCH = 200;
const MAX_NOTIFICATION_IMAGES = 4;
const MAX_NOTIFICATION_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_NOTIFICATION_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try { out[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
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
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    isOwner
  };
}

function getConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const notificationChannelId = process.env.DISCORD_NOTIFICATION_CHANNEL_ID;
  const notificationRoleId = process.env.DISCORD_NOTIFICATION_ROLE_ID;
  if (!base || !serviceKey) return { error: "storage_not_configured" };
  if (!botToken) return { error: "bot_token_missing" };
  return { base, serviceKey, botToken, notificationChannelId, notificationRoleId };
}

function truncate(value, max = 900) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

async function supabaseRequest(config, path, options = {}) {
  return fetch(config.base + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: config.serviceKey,
      Authorization: "Bearer " + config.serviceKey,
      ...(options.headers || {})
    }
  });
}

async function discordRequest(config, path, options = {}) {
  const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const request = () => fetch(DISCORD_API + path, {
    ...options,
    headers: {
      Authorization: "Bot " + config.botToken,
      ...(!isMultipart ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  let response = await request();
  if (response.status === 429) {
    const rate = await response.json().catch(() => ({}));
    const retryAfter = Number(rate.retry_after ?? response.headers.get("retry-after") ?? 0);
    // Keep this request bounded for serverless execution. Larger waits are reported
    // for a later manual retry rather than holding a serverless function open.
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 2) {
      await new Promise(resolve => setTimeout(resolve, Math.ceil(retryAfter * 1000) + 100));
      response = await request();
    } else {
      const error = new Error("discord_rate_limited");
      error.code = "rate_limited";
      throw error;
    }
  }

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const code = data.code ? String(data.code) : String(response.status);
    const error = new Error("discord_" + code);
    error.code = code;
    throw error;
  }
  return data;
}

function describeRecord(type, record) {
  const id = truncate(record.id, 80);
  if (type === "announcement") {
    return {
      title: "تنبيه بخصوص إعلان",
      description: "تم إرسال إعلان جديد من بوابة S.W.A.T. REDLINE. التفاصيل الكاملة مرفقة في الرسائل التالية.",
      fields: [
        { name: "نوع الإعلان", value: truncate(record.typeLabel || "إعلان", 100), inline: true },
        { name: "رقم الإعلان", value: id || "—", inline: true },
        { name: "المرسل", value: truncate(record.owner || "غير محدد", 120), inline: true },
        { name: "الموعد", value: truncate(record.dateTime ? new Date(record.dateTime).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" }) + " (Riyadh)" : "غير محدد", 120), inline: false }
      ]
    };
  }
  if (type === "task") {
    return {
      title: "تنبيه بخصوص مهمة اليوم",
      description: "تم إرسال تنبيه بخصوص مهمة مسجلة في مهام اليوم ببوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "المهمة", value: truncate(record.text || "مهمة بدون عنوان", 900) },
        { name: "الحالة", value: record.done ? "مكتملة" : "قيد التنفيذ", inline: true }
      ]
    };
  }
  if (type === "person") {
    return {
      title: "تنبيه بخصوص ملف شخص",
      description: "تم إرسال تنبيه إداري جديد من بوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "الاسم", value: truncate(record.name || "غير محدد", 200), inline: true },
        { name: "رقم الملف", value: id || "—", inline: true },
        { name: "الحالة", value: truncate(record.status === "arrested" ? "تم القبض عليه" : record.status === "archived" ? "مؤرشف" : "مطلوب", 80), inline: true },
        { name: "الأولوية", value: truncate(record.priority || "غير محددة", 80), inline: true },
        { name: "التفاصيل", value: truncate(record.charges || record.notes || "لا توجد تفاصيل إضافية.", 900) }
      ]
    };
  }
  if (type === "operation") {
    return {
      title: "تنبيه بخصوص عملية / اجتماع",
      description: "تم إصدار تنبيه بخصوص عملية مسجلة في بوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "اسم العملية", value: truncate(record.name || "غير محدد", 200), inline: true },
        { name: "رقم العملية", value: id || "—", inline: true },
        { name: "الحالة", value: truncate(record.status || "غير محددة", 80), inline: true },
        { name: "المسؤول", value: truncate(record.owner || "غير محدد", 120), inline: true },
        { name: "الموعد / الوقت", value: truncate(record.time || record.scheduledAt || "غير محدد", 120), inline: true }
      ]
    };
  }
    if (type === "report") {
    return {
      title: "تنبيه بخصوص تقرير",
      description: "تم إصدار تنبيه إداري بخصوص تقرير في بوابة S.W.A.T. REDLINE. النص الكامل مرفق في الرسائل التالية على أجزاء مرقّمة.",
      fields: [
        { name: "رقم التقرير", value: id || "—", inline: true },
        { name: "الحالة", value: truncate(record.status || "غير محددة", 80), inline: true },
        { name: "الكاتب", value: truncate(record.owner || "غير محدد", 120), inline: true },
        { name: "التاريخ", value: truncate(record.date || "غير محدد", 80), inline: true }
      ]
    };
  }
  return {
    title: "تنبيه بخصوص ملف تحرٍّ",
    description: "تم إصدار تنبيه بخصوص ملف تحرٍّ في بوابة S.W.A.T. REDLINE.",
    fields: [
      { name: "عنوان الملف", value: truncate(record.title || "بدون عنوان", 200) },
      { name: "رقم الملف", value: id || "—", inline: true },
      { name: "الحالة", value: truncate(record.status || "غير محددة", 100), inline: true },
      { name: "الاسم / الوصف", value: truncate(record.name || "غير محدد", 160), inline: true },
      { name: "ملخص الواقعة", value: truncate(record.incident || record.notes || "لا توجد تفاصيل إضافية.", 900) }
    ]
  };
}

function extractNotificationImages(record) {
  const candidates = Array.isArray(record?.images)
    ? record.images
    : Array.isArray(record?.photos)
      ? record.photos
      : record?.image
        ? [record.image]
        : [];
  const images = [];
  let totalBytes = 0;
  let skipped = 0;

  for (const item of candidates) {
    if (images.length >= MAX_NOTIFICATION_IMAGES) {
      skipped++;
      continue;
    }

    const src = typeof item === "string"
      ? item
      : (item?.src || item?.dataUrl || item?.data || item?.content || "");
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(String(src));
    if (!match) {
      skipped++;
      continue;
    }

    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    if (!buffer.length || buffer.length > MAX_NOTIFICATION_IMAGE_BYTES ||
        totalBytes + buffer.length > MAX_NOTIFICATION_TOTAL_IMAGE_BYTES) {
      skipped++;
      continue;
    }

    totalBytes += buffer.length;
    const extension = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
    const index = images.length + 1;
    const description = typeof item === "object" && item
      ? truncate(item.description || item.caption || "", 700)
      : "";
    images.push({
      buffer,
      mime,
      filename: "swat-evidence-" + String(index).padStart(2, "0") + "." + extension,
      description
    });
  }

  return { images, skipped, totalBytes };
}

function createDiscordMessageBody(payload, images) {
  if (!images.length) return JSON.stringify(payload);

  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  images.forEach((image, index) => {
    form.append("files[" + index + "]", new Blob([image.buffer], { type: image.mime }), image.filename);
  });
  return form;
}

function buildNotificationEmbeds(mainEmbed, images) {
  const embeds = [mainEmbed];
  images.forEach((image, index) => {
    embeds.push({
      color: 0xD92735,
      title: "الدليل المرفق " + (index + 1),
      ...(image.description ? { description: image.description } : {}),
      image: { url: "attachment://" + image.filename },
      footer: { text: "S.W.A.T. REDLINE • EVIDENCE ATTACHMENT" }
    });
  });
  return embeds;
}
 
function splitDiscordText(value, maxLength = 3000) {
  const text = String(value ?? "");
  if (!text) return ["لا يوجد نص للتقرير."];
  const chunks = [];
  for (let start = 0; start < text.length; start += maxLength) {
    chunks.push(text.slice(start, start + maxLength));
  }
  return chunks;
}

function notificationSubjectTitle(type, record) {
  if (type === "operation") return truncate(record.name || record.title || "عملية بدون اسم", 200);
  if (type === "person") return truncate(record.name || record.title || "ملف بدون اسم", 200);
  if (type === "report") return truncate(record.title || "تقرير بدون عنوان", 200);
  if (type === "task") return truncate(record.text || "مهمة بدون عنوان", 200);
  if (type === "announcement") return truncate(record.title || "إعلان بدون عنوان", 200);
  return truncate(record.title || record.name || "ملف تحرٍّ بدون عنوان", 200);
}

async function writeNotificationAudit(config, user, type, entityId, record, batchId, result) {
  const subjectTitle = notificationSubjectTitle(type, record);
  const actorName = truncate(user.displayName || user.username, 100);
  const actorUsername = truncate(user.username, 100);
  const channelStatus = result.channelStatus || "pending";
  const detail = `أرسل ${actorName} (@${actorUsername}) تنبيه Discord بخصوص «${subjectTitle}» — ${channelStatus === "sent" ? "تم نشره في روم الإشعارات" : channelStatus === "failed" ? "فشل نشره في روم الإشعارات" : "جارٍ نشره"}.`;
  const details = {
    type: "إرسال تنبيه Discord",
    detail,
    ref: entityId,
    notification_batch_id: batchId,
    notification_type: type,
    record_title: subjectTitle,
    actor_username: actorUsername,
    channel_status: channelStatus,
    channel_message_id: result.channelMessageId || null,
    channel_error_code: result.channelErrorCode || null,
    dm_total: Number(result.dmTotal || 0),
    dm_sent: Number(result.dmSent || 0),
    dm_failed: Number(result.dmFailed || 0)
  };

  try {
    const response = await supabaseRequest(config, "audit_logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        actor_discord_id: user.id,
        actor_name: actorName,
        action: "create",
        entity_type: "discord_notification",
        entity_id: entityId,
        details
      })
    });
    if (!response.ok) {
      console.error("Discord notification audit insert failed:", response.status, (await response.text()).slice(0, 300));
      return { id: null, details };
    }
    const rows = await response.json();
    return { id: rows[0]?.id || null, details };
  } catch (error) {
    console.error("Discord notification audit insert failed:", error?.message || "unknown");
    return { id: null, details };
  }
}

async function updateNotificationAudit(config, auditEntry, user, type, entityId, record, batchId, result) {
  if (!auditEntry?.id) return;
  const subjectTitle = notificationSubjectTitle(type, record);
  const actorName = truncate(user.displayName || user.username, 100);
  const actorUsername = truncate(user.username, 100);
  const sent = Number(result.dmSent || 0);
  const failed = Number(result.dmFailed || 0);
  const total = Number(result.dmTotal || 0);
  const channelStatus = result.channelStatus || "sent";
  const statusText = channelStatus === "failed"
    ? "فشل نشره في روم الإشعارات"
    : `تم نشره في روم الإشعارات؛ الرسائل الخاصة: ${sent} ناجحة من ${total}، وفشل ${failed}`;
  const details = {
    ...auditEntry.details,
    detail: `أرسل ${actorName} (@${actorUsername}) تنبيه Discord بخصوص «${subjectTitle}» — ${statusText}.`,
    channel_status: channelStatus,
    channel_message_id: result.channelMessageId || null,
    channel_error_code: result.channelErrorCode || null,
    dm_total: total,
    dm_sent: sent,
    dm_failed: failed
  };
  try {
    const query = new URLSearchParams({ id: "eq." + String(auditEntry.id) });
    const response = await supabaseRequest(config, "audit_logs?" + query, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ details })
    });
    if (!response.ok) {
      console.error("Discord notification audit update failed:", response.status, (await response.text()).slice(0, 300));
    }
  } catch (error) {
    console.error("Discord notification audit update failed:", error?.message || "unknown");
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "GET" && req.headers["x-announcement-sync-secret"] !== undefined) {
    return handleAnnouncementForwarder(req, res);
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Unauthorized." });
  if (req.method === "GET" && !user.isOwner) return res.status(403).json({ error: "Only the portal owner can inspect notification diagnostics." });

  if (req.method === "GET") {
    const token = process.env.DISCORD_BOT_TOKEN;
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!token || !guildId) {
      return res.status(503).json({ ok: false, botTokenConfigured: Boolean(token), guildConfigured: Boolean(guildId), error: "Bot token or server ID is missing." });
    }
    try {
      const botResponse = await fetch(DISCORD_API + "/users/@me", {
        headers: { Authorization: "Bot " + token }
      });
      const botData = await botResponse.json().catch(() => ({}));
      if (!botResponse.ok) {
        const code = String(botData.code || botResponse.status);
        return res.status(200).json({
          ok: false, botTokenConfigured: true, guildConfigured: true,
          tokenValid: false, botInGuild: false, errorCode: code,
          message: code === "50014" || code === "40001"
            ? "Bot Token is invalid. Update DISCORD_BOT_TOKEN in Vercel."
            : "Could not authenticate the Discord bot."
        });
      }
      const guildResponse = await fetch(DISCORD_API + "/guilds/" + encodeURIComponent(guildId), {
        headers: { Authorization: "Bot " + token }
      });
      const guildData = await guildResponse.json().catch(() => ({}));
      if (!guildResponse.ok) {
        return res.status(200).json({
          ok: true, tokenValid: true, botInGuild: false,
          botUsername: botData.username || null,
          errorCode: String(guildData.code || guildResponse.status),
          message: "The bot is not installed in the server configured for portal login, or it cannot access that server."
        });
      }
      return res.status(200).json({
        ok: true, tokenValid: true, botInGuild: true,
        botUsername: botData.username || null,
        guildName: guildData.name || null,
        message: "The Discord bot is installed in the portal's configured server."
      });
    } catch (error) {
      console.error("Discord bot diagnostics failed:", error instanceof Error ? error.message : "unknown");
      return res.status(503).json({ ok: false, error: "Could not reach Discord to inspect the bot." });
    }
  }

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const type = body.entity_type;
  const entityId = typeof body.entity_id === "string" ? body.entity_id.trim() : "";
  const batchKey = typeof body.batch_key === "string" ? body.batch_key : "";

  if (!["person", "operation", "report", "investigation", "task", "announcement"].includes(type) ||
      !entityId || entityId.length > 100 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchKey)) {
    return res.status(400).json({ error: "Invalid notification request." });
  }

  const config = getConfig();
  if (config.error === "bot_token_missing") {
    return res.status(503).json({ error: "Discord bot is not connected yet. Add DISCORD_BOT_TOKEN to Vercel Production." });
  }
  if (config.error) return res.status(503).json({ error: "Notification storage is not configured." });
  if (!config.notificationChannelId || !/^\d{17,20}$/.test(config.notificationChannelId)) {
    return res.status(503).json({ error: "Set DISCORD_NOTIFICATION_CHANNEL_ID in Vercel to the ID of #swat-notification-website. No DM will be sent until the channel target is configured." });
  }
  if (!config.notificationRoleId || !/^\d{17,20}$/.test(config.notificationRoleId)) {
    return res.status(503).json({ error: "Set DISCORD_NOTIFICATION_ROLE_ID in Vercel to the exact SWAT role ID. No notification will be sent until the role ping is configured." });
  }

  try {
    const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
    const stateResponse = await supabaseRequest(config, "app_state?" + stateQuery, { method: "GET" });
    if (!stateResponse.ok) {
      console.error("Notification state lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not read the selected portal record." });
    }
    const stateRows = await stateResponse.json();
    const state = stateRows[0]?.data || {};
    const sourceKey = ({ person: "people", operation: "operations", report: "reports", investigation: "investigations", announcement: "announcements" })[type];
    const records = type === "task" ? (Array.isArray(state.tasks) ? state.tasks : []) : (Array.isArray(state[sourceKey]) ? state[sourceKey] : []);
    const record = type === "task" ? records[Number(entityId)] : records.find(item => String(item?.id ?? "") === entityId);
    if (!record) return res.status(404).json({ error: "The selected record was not found. Refresh the portal and try again." });
    if (type === "task" && (typeof body.task_text !== "string" || !body.task_text.trim() || body.task_text.trim() !== String(record.text || "").trim())) {
      return res.status(409).json({ error: "The selected task changed. Refresh the portal and try again." });
    }

    const mentionSettingsQuery = new URLSearchParams({ key: "eq.notificationRoleMentionDisabled", select: "value", limit: "1" });
    const adsSettingsResponse = await supabaseRequest(config, "site_settings?" + mentionSettingsQuery, { method: "GET" });
    if (!adsSettingsResponse.ok) {
      console.error("Notification mention setting lookup failed:", adsSettingsResponse.status, (await adsSettingsResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not verify the notification mention setting. No alert was sent." });
    }
    const mentionSettingsRows = await adsSettingsResponse.json();
    // Safe by default during testing: missing preference means role mentions are disabled.
    const notificationRoleMentionDisabled = mentionSettingsRows[0]?.value !== false;

    // Production broadcast is enabled. Members receive DMs by default;
    // the member-level notifications_enabled preference is the opt-out switch.
    // Keep the environment flag as an emergency owner-side kill switch.
    const broadcastEnabled = process.env.DISCORD_NOTIFICATIONS_BROADCAST_ENABLED === "true";
    const recipientQuery = new URLSearchParams({
      select: "discord_user_id,display_name",
      notifications_enabled: "eq.true",
      is_active: "eq.true",
      is_banned: "eq.false",
      order: "created_at.asc"
    });
    if (!broadcastEnabled) {
      // During testing, never address any other profile, even if it opted in.
      recipientQuery.set("discord_user_id", "eq." + user.id);
    }
    const recipientResponse = await supabaseRequest(config, "staff_profiles?" + recipientQuery, { method: "GET" });
    if (!recipientResponse.ok) {
      console.error("Notification recipient lookup failed:", recipientResponse.status, (await recipientResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not load opted-in notification recipients." });
    }
    const recipientRows = await recipientResponse.json();
    const recipients = [...new Map(recipientRows
      .filter(row => /^\d{17,20}$/.test(String(row.discord_user_id || "")))
      .map(row => [String(row.discord_user_id), row])).values()];

    if (recipients.length > MAX_RECIPIENTS_PER_BATCH) {
      return res.status(409).json({
        error: `This manual batch has ${recipients.length} opted-in recipients. The safe single-request limit is ${MAX_RECIPIENTS_PER_BATCH}; use a queued delivery workflow before sending to a larger group.`
      });
    }

    const batchResponse = await supabaseRequest(config, "discord_notification_batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        batch_key: batchKey,
        actor_discord_id: user.id,
        actor_display_name: user.displayName || user.username,
        actor_username: user.username,
        entity_type: type,
        entity_id: entityId,
        total_recipients: recipients.length
      })
    });
    if (batchResponse.status === 409 || batchResponse.status === 23505) {
      return res.status(409).json({ error: "This notification request has already been submitted." });
    }
    if (!batchResponse.ok) {
      console.error("Notification batch creation failed:", batchResponse.status, (await batchResponse.text()).slice(0, 300));
      return res.status(502).json({ error: "Could not start the notification batch." });
    }
    const batchRows = await batchResponse.json();
    const batchId = batchRows[0]?.id;
    if (!batchId) return res.status(502).json({ error: "Could not confirm the notification batch." });

    const summary = describeRecord(type, record);
    const { images: notificationImages, skipped: skippedImageCount } = extractNotificationImages(record);
    const siteHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.SITE_URL || "swat-redline.vercel.app";
    const siteUrl = siteHost
      ? (siteHost.startsWith("http") ? siteHost : "https://" + siteHost)
      : "";
    const embedFields = summary.fields.map(field => ({
      name: truncate(field.name, 256),
      value: truncate(field.value || "—", 1024),
      inline: Boolean(field.inline)
    }));
    if (notificationImages.length) {
      embedFields.push({
        name: "📎 المرفقات",
        value: `تم إرفاق ${notificationImages.length} صورة من أدلة السجل.`,
        inline: true
      });
    }
    if (skippedImageCount) {
      embedFields.push({
        name: "ملاحظة المرفقات",
        value: "تعذّر إرفاق بعض الصور بسبب نوع الملف أو حد الحجم الآمن.",
        inline: true
      });
    }
    const subjectTitle = notificationSubjectTitle(type, record);
    const senderDisplayName = truncate(user.displayName || user.username, 100);
    const senderUsername = truncate(user.username, 100);
    embedFields.unshift({
      name: "👤 أرسل بواسطة",
      value: `**${senderDisplayName}**\n@${senderUsername}\nDiscord ID: ${user.id}`,
      inline: false
    });
    const subjectKind = ({
      person: "ملف شخص",
      operation: "عملية / اجتماع",
      report: "تقرير إداري",
      investigation: "ملف تحرٍّ",
      task: "مهمة اليوم",
      announcement: "إعلان إداري"
    })[type] || "إشعار إداري";
    const embed = {
      author: { name: "S.W.A.T. REDLINE  •  COMMAND PORTAL" },
      title: type === "report" ? "🚨 تنبيه بخصوص تقرير إداري" : "🚨 " + truncate(subjectTitle, 240),
      description: "**" + subjectKind + "  •  إشعار إداري جديد**\n" + truncate(summary.description, 1250),
      color: 0xD92735,
      fields: embedFields,
      footer: { text: "S.W.A.T. REDLINE  •  SECURE COMMAND CENTER" },
      timestamp: new Date().toISOString(),
      ...(siteUrl ? { url: siteUrl } : {})
    };
    const notificationEmbeds = buildNotificationEmbeds(embed, notificationImages);
    const siteComponents = siteUrl ? [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: "فتح بوابة S.W.A.T. REDLINE",
        url: siteUrl
      }]
    }] : [];

    // A report's title field may contain the complete narrative. Never squeeze it
    // into Discord's 256-character embed title or a 1024-character field value.
    const reportTitleText = type === "report" ? String(record.title || "") : "";
    const reportBodyText = type === "report"
      ? String(record.content || record.body || record.description || record.text || "")
      : "";
    const reportFullText = type === "report"
      ? [
          reportTitleText ? "عنوان التقرير:\n" + reportTitleText : "",
          reportBodyText && reportBodyText !== reportTitleText ? "محتوى التقرير:\n" + reportBodyText : ""
        ].filter(Boolean).join("\n\n")
      : "";
    const reportChunks = type === "report" ? splitDiscordText(reportFullText) : [];
    const announcementFullText = type === "announcement"
      ? [
          "نوع الإعلان: " + String(record.typeLabel || "إعلان"),
          "اسم الإعلان: " + String(record.title || ""),
          record.dateTime ? "الموعد: " + new Date(record.dateTime).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" }) + " (Riyadh)" : "الموعد: غير محدد",
          "المرسل: " + String(record.owner || "غير محدد"),
          "",
          String(record.description || "")
        ].join("\\n")
      : "";
    const announcementChunks = type === "announcement" ? splitDiscordText(announcementFullText) : [];
    const notificationMessages = [{
      embeds: notificationEmbeds,
      images: notificationImages,
      components: siteComponents,
      content: notificationRoleMentionDisabled ? "" : "<@&" + config.notificationRoleId + ">",
      allowedMentions: {
        parse: [],
        roles: notificationRoleMentionDisabled ? [] : [config.notificationRoleId]
      }
    }];
    reportChunks.forEach((chunk, index) => {
      notificationMessages.push({
        embeds: [{
          author: { name: "S.W.A.T. REDLINE  •  COMMAND PORTAL" },
          title: "📄 النص الكامل للتقرير — الجزء " + (index + 1) + "/" + reportChunks.length,
          description: chunk,
          color: 0xD92735,
          footer: { text: "S.W.A.T. REDLINE  •  استكمال التقرير" },
          timestamp: new Date().toISOString()
        }],
        images: [],
        components: [],
        content: "",
        allowedMentions: { parse: [] }
      });
    });
    announcementChunks.forEach((chunk, index) => {
      notificationMessages.push({
        embeds: [{
          author: { name: "S.W.A.T. REDLINE  •  COMMAND PORTAL" },
          title: "📣 تفاصيل الإعلان — الجزء " + (index + 1) + "/" + announcementChunks.length,
          description: chunk,
          color: 0xD92735,
          footer: { text: "S.W.A.T. REDLINE  •  تفاصيل الإعلان" },
          timestamp: new Date().toISOString()
        }],
        images: [],
        components: [],
        content: "",
        allowedMentions: { parse: [] }
      });
    });

    // Every manual alert is first published to exactly one configured channel.
    // DISCORD_NOTIFICATION_CHANNEL_ID is the only channel destination; DM delivery remains opt-in.
    // This is independent from per-member DM preferences.
    let channelSent = false;
    let channelMessageId = null;
    let channelErrorCode = null;
    try {
      for (let partIndex = 0; partIndex < notificationMessages.length; partIndex++) {
        const part = notificationMessages[partIndex];
        const channelMessage = await discordRequest(
          config,
          "/channels/" + encodeURIComponent(config.notificationChannelId) + "/messages",
          {
            method: "POST",
            body: createDiscordMessageBody({
              ...(part.content ? { content: part.content } : {}),
              embeds: part.embeds,
              ...(part.components.length ? { components: part.components } : {}),
              allowed_mentions: part.allowedMentions
            }, part.images)
          }
        );
        if (partIndex === 0) channelMessageId = channelMessage.id || null;
      }
      channelSent = true;
    } catch (error) {
      channelErrorCode = String(error?.code || error?.message || "channel_delivery_failed").slice(0, 80);
      console.error("Discord notification channel delivery failed:", channelErrorCode);
    }

    if (!channelSent) {
      const failedBatch = await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batchId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          sent_count: 0,
          failed_count: 0,
          channel_status: "failed",
          channel_message_id: null,
          channel_error_code: channelErrorCode
        })
      });
      if (!failedBatch.ok) {
        console.error("Failed to record channel delivery failure:", failedBatch.status, (await failedBatch.text()).slice(0, 200));
      }
      const failedAudit = await writeNotificationAudit(
        config, user, type, entityId, record, batchId,
        { channelStatus: "failed", channelErrorCode, dmTotal: 0, dmSent: 0, dmFailed: 0 }
      );
      await updateNotificationAudit(
        config, failedAudit, user, type, entityId, record, batchId,
        { channelStatus: "failed", channelErrorCode, dmTotal: 0, dmSent: 0, dmFailed: 0 }
      );
      return res.status(502).json({
        error: "The notification was not sent. Discord could not publish it in #swat-notification-website, so no direct messages were sent either.",
        channel_sent: false,
        channel_error_code: channelErrorCode
      });
    }

    const notificationAudit = await writeNotificationAudit(
      config, user, type, entityId, record, batchId,
      { channelStatus: "sent", channelMessageId, dmTotal: recipients.length, dmSent: 0, dmFailed: 0 }
    );
    let sent = 0;
    let failed = 0;
    const failureReasons = {};

    async function deliverToRecipient(recipient) {
      let status = "failed";
      let errorCode = null;
      try {
        const dm = await discordRequest(config, "/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: recipient.discord_user_id })
        });
        if (!dm.id) throw Object.assign(new Error("discord_dm_channel_missing"), { code: "dm_channel_missing" });

        for (const part of notificationMessages) {
          await discordRequest(config, "/channels/" + encodeURIComponent(dm.id) + "/messages", {
            method: "POST",
            body: createDiscordMessageBody({
              ...(part.content ? { content: part.content } : {}),
              embeds: part.embeds,
              ...(part.components.length ? { components: part.components } : {}),
              allowed_mentions: { parse: [] }
            }, part.images)
          });
        }
        status = "sent";
        sent++;
      } catch (error) {
        failed++;
        errorCode = String(error?.code || error?.message || "delivery_failed").slice(0, 80);
        failureReasons[errorCode] = (failureReasons[errorCode] || 0) + 1;
      }

      try {
        const deliveryWrite = await supabaseRequest(config, "discord_notification_deliveries", {
          method: "POST",
          headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            batch_id: batchId,
            recipient_discord_id: recipient.discord_user_id,
            status,
            error_code: errorCode
          })
        });
        if (!deliveryWrite.ok) {
          console.error("Notification delivery audit insert failed:", deliveryWrite.status, (await deliveryWrite.text()).slice(0, 200));
        }
      } catch (error) {
        console.error("Notification delivery audit insert failed:", error?.message || "unknown");
      }
    }

    // Use a small worker pool to reach every opted-in member without creating
    // a burst of Discord requests or processing a large guild serially.
    let nextRecipientIndex = 0;
    const workerCount = Math.min(4, recipients.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextRecipientIndex++;
        if (index >= recipients.length) return;
        await deliverToRecipient(recipients[index]);
      }
    }));

    const updateBatch = await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batchId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        sent_count: sent,
        failed_count: failed,
        channel_status: channelSent ? "sent" : "failed",
        channel_message_id: channelMessageId,
        channel_error_code: channelErrorCode
      })
    });
    if (!updateBatch.ok) {
      console.error("Notification batch summary update failed:", updateBatch.status, (await updateBatch.text()).slice(0, 200));
    }
    await updateNotificationAudit(
      config, notificationAudit, user, type, entityId, record, batchId,
      { channelStatus: "sent", channelMessageId, dmTotal: recipients.length, dmSent: sent, dmFailed: failed }
    );

    return res.status(200).json({
      ok: true,
      total: recipients.length,
      sent,
      failed,
      channel_sent: channelSent,
      role_ping_sent: channelSent && !notificationRoleMentionDisabled,
      channel_error_code: channelErrorCode,
      failure_reasons: {
        no_mutual_guild: failureReasons["50278"] || 0,
        recipient_dm_blocked: failureReasons["50007"] || 0,
        other: Object.entries(failureReasons).filter(([code]) => !["50278", "50007"].includes(code)).reduce((sum, [, count]) => sum + count, 0)
      },
      mode: broadcastEnabled ? "broadcast" : "test_self",
      message: !channelSent
        ? "The channel post failed. No direct messages were sent."
        : recipients.length === 0
          ? "The alert was published to the notification channel. No active portal members currently have private alerts enabled."
          : failed
            ? `Channel post published; ${sent} DMs sent and ${failed} failed.`
            : `Channel post published; ${sent} DMs sent.`
    });
  } catch (error) {
    console.error("Notification send failed:", error instanceof Error ? error.message : "unknown");
    return res.status(500).json({ error: "The notification batch could not be completed." });
  }
}
