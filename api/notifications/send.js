import crypto from "node:crypto";
import { handleAnnouncementForwarder } from "../../lib/announcement-forwarder.js";
import { requireSameOrigin } from "../../lib/request-security.js";
import { forwardAuditToDiscord } from "../../lib/audit-log.js";
import { discordApiRequest } from "../../lib/discord-rest.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../../lib/portal-admin.js";
import { buildRuleDiscordMessages } from "../../lib/rules-discord.js";
import { buildSiteNoticeDiscordPayload, isSiteNoticeId, normalizeSiteNoticeInput, siteNoticeBatchIsSent } from "../../lib/site-notices.js";

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
  // Manual site notifications use one Discord channel per record family.
  // These defaults are the owner-provided announcement and evidence room IDs.
  const announcementPostChannelId = "1561485863492259840"; // Fixed owner-selected #𝐀𝐍𝐍𝐎𝐔𝐍𝐂𝐄𝐌𝐍𝐄𝐓 room.
  const evidenceChannelId = process.env.DISCORD_EVIDENCE_CHANNEL_ID || "1562393479953518612";
  const notificationRoleId = process.env.DISCORD_NOTIFICATION_ROLE_ID;
  if (!base || !serviceKey) return { error: "storage_not_configured" };
  if (!botToken) return { error: "bot_token_missing" };
  return { base, serviceKey, botToken, notificationChannelId, announcementPostChannelId, evidenceChannelId, notificationRoleId };
}

const SWAT_RULES_CHANNEL_ID = "1561775787152117770";

async function publishSavedRuleToDiscord(user, ruleId) {
  const config = getConfig();
  if (config.error === "bot_token_missing") {
    throw Object.assign(new Error("Discord bot is not connected. Add DISCORD_BOT_TOKEN to Vercel."), { status: 503 });
  }
  if (config.error) {
    throw Object.assign(new Error("Rules storage is not configured."), { status: 503 });
  }
  if (!config.notificationRoleId || !/^\d{17,20}$/.test(config.notificationRoleId)) {
    throw Object.assign(new Error("لم يتم ضبط رتبة منشن SWAT في DISCORD_NOTIFICATION_ROLE_ID."), { status: 503 });
  }

  const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
  const stateResponse = await supabaseRequest(config, "app_state?" + stateQuery, { method: "GET" });
  if (!stateResponse.ok) {
    console.error("Rules publication state lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 250));
    throw Object.assign(new Error("تعذر قراءة القوانين المحفوظة من قاعدة البيانات."), { status: 502 });
  }
  const rows = await stateResponse.json();
  const savedRules = Array.isArray(rows[0]?.data?.rules) ? rows[0].data.rules : [];
  const rule = savedRules.find(item => item && !Array.isArray(item) &&
    String(item.id || "") === ruleId && item.type === "law");
  if (!rule) {
    throw Object.assign(new Error("لم يتم العثور على هذا القانون ضمن القوانين المحفوظة. احفظه أولًا ثم أعد الإرسال."), { status: 404 });
  }

  const actor = user.displayName || user.username || "S.W.A.T. Command";
  const messages = buildRuleDiscordMessages(rule, actor);
  const messageIds = [];
  for (let index = 0; index < messages.length; index++) {
    const first = index === 0;
    const payload = {
      ...messages[index],
      content: first ? "<@&" + config.notificationRoleId + ">" : "",
      allowed_mentions: first
        ? { parse: [], roles: [config.notificationRoleId] }
        : { parse: [] }
    };
    try {
      const sent = await discordRequest(config,
        "/channels/" + encodeURIComponent(SWAT_RULES_CHANNEL_ID) + "/messages",
        { method: "POST", body: JSON.stringify(payload) }
      );
      if (sent?.id) messageIds.push(String(sent.id));
    } catch (error) {
      const status = Number(error?.status || 0);
      const message = status === 403
        ? "البوت لا يملك صلاحية إرسال الرسائل أو تضمين الروابط في روم SWAT Rules."
        : status === 404
          ? "لم يتم العثور على روم SWAT Rules أو أن البوت لا يستطيع الوصول إليها."
          : status === 429
            ? "Discord فرض حدًا مؤقتًا للإرسال. أعد المحاولة بعد انتهاء المهلة."
            : "تعذر إرسال القانون إلى Discord. رمز الخطأ: " + String(error?.code || status || "unknown");
      throw Object.assign(new Error(message), {
        status: 502,
        messagesSent: index,
        partial: index > 0,
        messageIds
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
      channel_id: SWAT_RULES_CHANNEL_ID,
      channel_message_ids: messageIds
    }
  };
  try {
    const auditResponse = await supabaseRequest(config, "audit_logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
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

  return { channelId: SWAT_RULES_CHANNEL_ID, messagesSent: messageIds.length, messageIds, roleMentioned: true };
}
async function isActiveStaffForNotifications(config, user) {
  if (user.isOwner) return true;
  const query = new URLSearchParams({
    discord_user_id: "eq." + String(user.id),
    select: "is_active,is_banned",
    limit: "1"
  });
  try {
    const response = await supabaseRequest(config, "staff_profiles?" + query.toString());
    if (!response.ok) {
      console.error("Notification staff authorization lookup failed:", response.status, (await response.text()).slice(0, 250));
      return false;
    }
    const rows = await response.json();
    return Boolean(rows[0]) && rows[0].is_active !== false && !rows[0].is_banned;
  } catch (error) {
    console.error("Notification staff authorization lookup failed:", error?.message || "unknown");
    return false;
  }
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
  try {
    return await discordApiRequest(config.botToken,path,options,{maxRetries:3,maxRetryWaitMs:8000});
  } catch(error) {
    if(error?.status===429){error.message="discord_rate_limited";error.code="rate_limited";}
    throw error;
  }
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
  if (type === "case") {
    return {
      title: "تنبيه بخصوص قضية",
      description: "تم تسجيل قضية جديدة أو تحديثها في بوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "عنوان القضية", value: truncate(record.title || "بدون عنوان", 200) },
        { name: "رقم القضية", value: id || "—", inline: true },
        { name: "النوع", value: truncate(record.caseType || "غير محدد", 100), inline: true },
        { name: "الحالة", value: truncate(record.status || "غير محددة", 80), inline: true },
        { name: "الشخص المرتبط", value: truncate(record.personName || "غير مرتبط", 160), inline: true },
        { name: "التهمة / السبب", value: truncate(record.charge || "غير محدد", 900) }
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
  if (type === "case") return truncate(record.title || "قضية بدون عنوان", 200);
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
  const channelText = channelStatus === "sent" ? "تم نشره في روم Discord المخصصة لنوع التنبيه" : channelStatus === "disabled" ? "النشر في روم Discord المخصصة لنوع التنبيه متوقف بإعدادات المالك" : channelStatus === "failed" ? "فشل نشره في روم Discord المخصصة لنوع التنبيه" : "جارٍ نشره";
  const detail = `أرسل ${actorName} (@${actorUsername}) تنبيه Discord بخصوص «${subjectTitle}» — ${channelText}.`;
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
    channel_id: result.channelId || null,
    channel_label: result.channelLabel || null,
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
    if(rows[0])await forwardAuditToDiscord(user,{action:"create",entity_type:"discord_notification",entity_id:entityId,details});
    return { id: rows[0]?.id || null, details };
  } catch (error) {
    console.error("Discord notification audit insert failed:", error?.message || "unknown");
    return { id: null, details };
  }
}


function getSiteNoticeChannelId() {
  return String(process.env.DISCORD_SITE_NOTICES_CHANNEL_ID || "").trim();
}

async function readSiteNoticeBatch(config, noticeId) {
  const query = new URLSearchParams({
    entity_id: "eq." + noticeId,
    entity_type: "eq.announcement",
    select: "id,batch_key,entity_id,channel_status,channel_message_id,channel_error_code,created_at",
    order: "created_at.desc",
    limit: "1"
  });
  const response = await supabaseRequest(config, "discord_notification_batches?" + query.toString());
  if (!response.ok) {
    console.error("Site notice publication status lookup failed:", response.status, (await response.text()).slice(0, 200));
    throw Object.assign(new Error("تعذّر التحقق من حالة نشر التعميم."), { status: 502 });
  }
  return (await response.json())[0] || null;
}

async function getSiteNoticePublicationStatuses(user, url, res) {
  const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean);
  if (!ids.length) return res.status(200).json({ ok: true, publications: {} });
  if (ids.length > 100 || ids.some(id => !isSiteNoticeId(id))) {
    return res.status(400).json({ error: "Invalid official notice IDs." });
  }
  const config = getConfig();
  if (config.error === "bot_token_missing") {
    return res.status(503).json({ error: "Discord bot is not connected." });
  }
  if (config.error) return res.status(503).json({ error: "Notification storage is not configured." });
  if (!await isActiveStaffForNotifications(config, user)) {
    return res.status(403).json({ error: "This staff account is inactive or could not be verified." });
  }
  const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
  const stateResponse = await supabaseRequest(config, "app_state?" + stateQuery.toString());
  if (!stateResponse.ok) {
    console.error("Official notice archive lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 200));
    return res.status(502).json({ error: "Could not verify official notice IDs." });
  }
  const stateRows = await stateResponse.json();
  const noticeIds = new Set((Array.isArray(stateRows[0]?.data?.siteNotices) ? stateRows[0].data.siteNotices : [])
    .map(item => String(item?.id || "")));
  const allowedIds = ids.filter(id => noticeIds.has(id));
  if (!allowedIds.length) return res.status(200).json({ ok: true, publications: {} });
  const query = new URLSearchParams({
    entity_id: "in.(" + allowedIds.join(",") + ")",
    entity_type: "eq.announcement",
    select: "entity_id,batch_key,channel_status,channel_message_id,channel_error_code,created_at",
    order: "created_at.desc",
    limit: "1000"
  });
  const response = await supabaseRequest(config, "discord_notification_batches?" + query.toString());
  if (!response.ok) {
    console.error("Site notice publication status read failed:", response.status, (await response.text()).slice(0, 200));
    return res.status(502).json({ error: "Could not read official notice publication statuses." });
  }
  const rows = await response.json();
  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  const publications = {};
  for (const row of rows) {
    const noticeId = String(row.entity_id || "");
    if (!noticeId || publications[noticeId]) continue;
    const messageId = String(row.channel_message_id || "");
    const channelId = getSiteNoticeChannelId();
    publications[noticeId] = {
      status: row.channel_status,
      messageId: messageId || null,
      channelId,
      publishedAt: row.channel_status === "sent" ? row.created_at : null,
      errorCode: row.channel_error_code || null,
      messageUrl: messageId && /^\d{17,20}$/.test(guildId) && /^\d{17,20}$/.test(channelId)
        ? "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId
        : null
    };
  }
  return res.status(200).json({ ok: true, publications });
}

async function readSavedSiteNoticeContext(config, noticeId) {
  const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
  const stateResponse = await supabaseRequest(config, "app_state?" + stateQuery.toString());
  if (!stateResponse.ok) {
    console.error("Official notice management state lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 200));
    throw Object.assign(new Error("تعذّر قراءة سجل التعاميم من الموقع."), { status: 502 });
  }
  const stateRows = await stateResponse.json();
  const notices = Array.isArray(stateRows[0]?.data?.siteNotices) ? stateRows[0].data.siteNotices : [];
  const notice = notices.find(item => String(item?.id || "") === noticeId);
  if (!notice) throw Object.assign(new Error("التعميم غير موجود في سجل الموقع."), { status: 404 });
  return { notice, batch: await readSiteNoticeBatch(config, noticeId) };
}

async function writeSiteNoticeAudit(config, user, action, noticeId, title, details) {
  const actor = truncate(user.displayName || user.username || "S.W.A.T. Command", 100);
  const event = {
    actor_discord_id: user.id,
    actor_name: actor,
    action,
    entity_type: "site_notice_management",
    entity_id: noticeId,
    details: {
      type: action === "update" ? "تعديل تعميم رسمي" : "حذف تعميم رسمي",
      detail: actor + (action === "update" ? " عدّل " : " حذف ") + "التعميم «" + String(title || "").slice(0, 180) + "».",
      ...details
    }
  };
  try {
    const response = await supabaseRequest(config, "audit_logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(event)
    });
    if (!response.ok) console.warn("Official notice management audit insert failed:", response.status);
  } catch (error) {
    console.warn("Official notice management audit failed:", error?.message || "unknown");
  }
}

async function updatePublishedSiteNotice(user, noticeId) {
  const config = getConfig();
  if (config.error === "bot_token_missing") throw Object.assign(new Error("Discord bot is not connected."), { status: 503 });
  if (config.error) throw Object.assign(new Error("Notification storage is not configured."), { status: 503 });
  const channelId = getSiteNoticeChannelId();
  if (!/^\\d{17,20}$/.test(channelId)) throw Object.assign(new Error("روم التعميم غير مضبوطة."), { status: 503 });
  if (!await isActiveStaffForNotifications(config, user)) throw Object.assign(new Error("حساب الإدارة غير نشط أو تعذّر التحقق منه."), { status: 403 });

  const { notice, batch } = await readSavedSiteNoticeContext(config, noticeId);
  const normalized = normalizeSiteNoticeInput(notice);
  if (!siteNoticeBatchIsSent(batch)) return { updatedOnPortal: true, updatedOnDiscord: false, notPublished: true };

  const payload = buildSiteNoticeDiscordPayload({
    ...normalized,
    notificationRoleId: config.notificationRoleId,
    roleMentionDisabled: true
  });
  try {
    await discordRequest(config, "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(batch.channel_message_id), {
      method: "PATCH",
      body: JSON.stringify({ embeds: payload.embeds })
    });
  } catch (error) {
    const code = String(error?.code || error?.status || "discord_edit_failed").slice(0, 80);
    await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batch.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ channel_error_code: "edit_" + code })
    }).catch(() => null);
    const message = Number(error?.status) === 404
      ? "رسالة Discord الأصلية غير موجودة. التعديل محفوظ في الموقع، لكن الرسالة لم تعد موجودة في الروم."
      : Number(error?.status) === 403
        ? "البوت لا يملك صلاحية تعديل رسائل التعميم في روم 🔴 SWAT • WARNING."
        : "تم حفظ التعديل في الموقع، لكن تعذّر تحديث رسالة Discord. يمكنك الضغط على تعديل ثم الحفظ لإعادة المحاولة.";
    throw Object.assign(new Error(message), { status: 502, code });
  }

  await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batch.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ channel_error_code: null })
  }).catch(() => null);
  await writeSiteNoticeAudit(config, user, "update", noticeId, normalized.title, {
    channel_id: channelId,
    channel_message_id: batch.channel_message_id
  });
  return { updatedOnPortal: true, updatedOnDiscord: true, channelId, messageId: batch.channel_message_id };
}

async function deleteSiteNoticePublication(user, noticeId) {
  const config = getConfig();
  if (config.error === "bot_token_missing") throw Object.assign(new Error("Discord bot is not connected."), { status: 503 });
  if (config.error) throw Object.assign(new Error("Notification storage is not configured."), { status: 503 });
  const channelId = getSiteNoticeChannelId();
  if (!/^\\d{17,20}$/.test(channelId)) throw Object.assign(new Error("روم التعميم غير مضبوطة."), { status: 503 });
  if (!await isActiveStaffForNotifications(config, user)) throw Object.assign(new Error("حساب الإدارة غير نشط أو تعذّر التحقق منه."), { status: 403 });

  const { notice, batch } = await readSavedSiteNoticeContext(config, noticeId);
  if (batch?.channel_status === "pending") {
    throw Object.assign(new Error("لا يمكن حذف التعميم أثناء وجود عملية نشر قيد التنفيذ."), { status: 409 });
  }
  let discordDeleted = false;
  if (siteNoticeBatchIsSent(batch)) {
    try {
      await discordRequest(config, "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(batch.channel_message_id), {
        method: "DELETE"
      });
      discordDeleted = true;
    } catch (error) {
      if (Number(error?.status) !== 404) {
        const message = Number(error?.status) === 403
          ? "البوت لا يملك صلاحية حذف الرسائل من روم 🔴 SWAT • WARNING."
          : "تعذّر حذف رسالة Discord؛ لم يتم حذف سجل التعميم من الموقع.";
        throw Object.assign(new Error(message), { status: 502, code: error?.code || error?.status || "discord_delete_failed" });
      }
      discordDeleted = true;
    }

    const ledgerUpdate = await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batch.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ channel_status: "deleted", channel_error_code: null })
    });
    if (!ledgerUpdate.ok) {
      console.error("Deleted official notice message but failed to update delivery ledger:", ledgerUpdate.status, (await ledgerUpdate.text()).slice(0, 200));
      throw Object.assign(new Error("تم حذف رسالة Discord، لكن تعذّر تحديث سجل النشر. حدّث الصفحة قبل المحاولة مرة أخرى."), { status: 502 });
    }
  }
  await writeSiteNoticeAudit(config, user, "delete", noticeId, notice.title, {
    channel_id: channelId,
    channel_message_id: batch?.channel_message_id || null,
    discord_deleted: discordDeleted
  });
  return { deletedFromDiscord: discordDeleted };
}

async function publishSavedSiteNotice(user, noticeId, { allowResend = false } = {}) {
  const config = getConfig();
  if (config.error === "bot_token_missing") {
    throw Object.assign(new Error("Discord bot is not connected. Add DISCORD_BOT_TOKEN to Vercel."), { status: 503 });
  }
  if (config.error) throw Object.assign(new Error("Notification storage is not configured."), { status: 503 });
  const channelId = getSiteNoticeChannelId();
  if (!/^\d{17,20}$/.test(channelId)) {
    throw Object.assign(new Error("روم التعاميم 🔴 SWAT • WARNING غير مضبوطة. راجع DISCORD_SITE_NOTICES_CHANNEL_ID في Vercel."), { status: 503 });
  }
  if (!await isActiveStaffForNotifications(config, user)) {
    throw Object.assign(new Error("حساب الإدارة غير نشط أو تعذّر التحقق منه."), { status: 403 });
  }

  const settingsQuery = new URLSearchParams({
    key: "in.(notificationChannelEnabled,notificationRoleMentionDisabled)",
    select: "key,value"
  });
  const settingsResponse = await supabaseRequest(config, "site_settings?" + settingsQuery.toString());
  if (!settingsResponse.ok) {
    console.error("Site notice delivery settings lookup failed:", settingsResponse.status, (await settingsResponse.text()).slice(0, 200));
    throw Object.assign(new Error("تعذّر التحقق من إعدادات النشر. لم يتم إرسال التعميم."), { status: 502 });
  }
  const settings = new Map((await settingsResponse.json()).map(row => [row.key, row.value]));
  if (settings.get("notificationChannelEnabled") !== true) {
    throw Object.assign(new Error("النشر في روم 🔴 SWAT • WARNING متوقف من إعدادات الموقع. فعّل السماح بالنشر أولًا."), { status: 409 });
  }

  const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
  const stateResponse = await supabaseRequest(config, "app_state?" + stateQuery.toString());
  if (!stateResponse.ok) {
    console.error("Site notice state lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 200));
    throw Object.assign(new Error("تعذّر قراءة التعاميم المحفوظة في الموقع."), { status: 502 });
  }
  const stateRows = await stateResponse.json();
  const notices = Array.isArray(stateRows[0]?.data?.siteNotices) ? stateRows[0].data.siteNotices : [];
  const notice = notices.find(item => String(item?.id || "") === noticeId);
  if (!notice) throw Object.assign(new Error("التعميم غير موجود في سجل الموقع. احفظه أولًا ثم أعد المحاولة."), { status: 404 });
  let normalized;
  try {
    normalized = normalizeSiteNoticeInput(notice);
  } catch (error) {
    throw Object.assign(new Error(error.message || "بيانات التعميم غير صالحة."), { status: 400 });
  }

  let batch = await readSiteNoticeBatch(config, noticeId);
  let batchId = null;
  if (siteNoticeBatchIsSent(batch) && !allowResend) {
    const messageId = String(batch.channel_message_id);
    const guildId = String(process.env.DISCORD_GUILD_ID || "");
    return {
      alreadySent: true,
      channelId,
      messageId,
      messageUrl: /^\d{17,20}$/.test(guildId)
        ? "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId
        : null
    };
  }
  if (batch?.channel_status === "pending") {
    throw Object.assign(new Error("يوجد طلب نشر لهذا التعميم قيد التنفيذ بالفعل. حدّث القائمة قبل المحاولة مرة أخرى."), { status: 409 });
  }
  if (batch?.channel_status === "failed") {
    const claim = await supabaseRequest(config,
      "discord_notification_batches?id=eq." + encodeURIComponent(batch.id) + "&channel_status=eq.failed",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ channel_status: "pending", channel_error_code: null })
      }
    );
    if (!claim.ok) {
      console.error("Site notice retry claim failed:", claim.status, (await claim.text()).slice(0, 200));
      throw Object.assign(new Error("تعذّر تجهيز إعادة نشر التعميم."), { status: 502 });
    }
    const claimedRows = await claim.json();
    if (!claimedRows.length) {
      throw Object.assign(new Error("يوجد طلب نشر آخر يعمل على هذا التعميم. حدّث القائمة."), { status: 409 });
    }
    batchId = batch.id;
  } else {
    const create = await supabaseRequest(config, "discord_notification_batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        batch_key: batch?.batch_key ? crypto.randomUUID() : noticeId,
        actor_discord_id: user.id,
        entity_type: "announcement",
        entity_id: noticeId,
        total_recipients: 0
      })
    });
    if (!create.ok) {
      const detail = (await create.text()).slice(0, 250);
      if (create.status === 409 || create.status === 23505) {
        batch = await readSiteNoticeBatch(config, noticeId);
        if (siteNoticeBatchIsSent(batch)) {
          return { alreadySent: true, channelId, messageId: batch.channel_message_id || null };
        }
        throw Object.assign(new Error(batch?.channel_status === "pending"
          ? "يوجد طلب نشر لهذا التعميم قيد التنفيذ بالفعل."
          : "تعذّر حجز طلب نشر فريد لهذا التعميم. حدّث القائمة وحاول مرة أخرى."), { status: 409 });
      }
      console.error("Site notice batch creation failed:", create.status, detail);
      throw Object.assign(new Error("تعذّر بدء تسجيل عملية نشر التعميم."), { status: 502 });
    }
    const createdRows = await create.json();
    batchId = createdRows[0]?.id;
    if (!batchId) throw Object.assign(new Error("لم يتم تأكيد إنشاء سجل النشر."), { status: 502 });
  }

  const roleMentionDisabled = settings.get("notificationRoleMentionDisabled") !== false;
  const payload = buildSiteNoticeDiscordPayload({
    ...normalized,
    notificationRoleId: config.notificationRoleId,
    roleMentionDisabled
  });
  let sentMessage;
  try {
    sentMessage = await discordRequest(config, "/channels/" + encodeURIComponent(channelId) + "/messages", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!sentMessage?.id) throw Object.assign(new Error("Discord did not return a message ID."), { code: "message_id_missing" });
  } catch (error) {
    const code = String(error?.code || error?.status || error?.message || "discord_publish_failed").slice(0, 80);
    await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batchId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ channel_status: "failed", channel_error_code: code })
    }).catch(() => null);
    const message = Number(error?.status) === 403
      ? "البوت لا يملك صلاحية إرسال الرسائل أو التضمينات في روم 🔴 SWAT • WARNING."
      : Number(error?.status) === 404
        ? "لم يتم العثور على روم 🔴 SWAT • WARNING أو أن البوت لا يستطيع الوصول إليها."
        : Number(error?.status) === 429
          ? "Discord فرض حدًا مؤقتًا للإرسال. حاول مرة أخرى بعد انتهاء المهلة."
          : "تعذّر نشر التعميم في Discord. رمز الخطأ: " + code;
    throw Object.assign(new Error(message), { status: 502, code });
  }

  const messageId = String(sentMessage.id);
  const savedBatch = await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batchId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ channel_status: "sent", channel_message_id: messageId, channel_error_code: null })
  });
  if (!savedBatch.ok) {
    console.error("Site notice sent but publication ledger update failed:", savedBatch.status, (await savedBatch.text()).slice(0, 200));
  }

  const actor = truncate(user.displayName || user.username || "S.W.A.T. Command", 100);
  const auditEvent = {
    actor_discord_id: user.id,
    actor_name: actor,
    action: "create",
    entity_type: "site_notice_publication",
    entity_id: noticeId,
    details: {
      type: "نشر تعميم رسمي على Discord",
      detail: "نشر " + actor + " التعميم «" + normalized.title.slice(0, 180) + "» في روم 🔴 SWAT • WARNING.",
      channel_id: channelId,
      channel_message_id: messageId
    }
  };
  try {
    const auditResponse = await supabaseRequest(config, "audit_logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
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
      console.warn("Site notice publication audit insert failed:", auditResponse.status);
    }
  } catch (error) {
    console.warn("Site notice publication audit failed:", error?.message || "unknown");
  }

  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  return {
    alreadySent: false,
    channelId,
    messageId,
    messageUrl: /^\d{17,20}$/.test(guildId)
      ? "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId
      : null,
    publicationRecorded: savedBatch.ok
  };
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
  const statusUrl = new URL(req.url, "https://swat-redline.vercel.app");
  if (req.method === "GET" && statusUrl.searchParams.get("site_notice_status") === "1") {
    try {
      return await getSiteNoticePublicationStatuses(user, statusUrl, res);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.message || "Could not read official notice publication status." });
    }
  }

  let websiteAdminAccess = Boolean(user.isOwner);
  try {
    if (!websiteAdminAccess) {
      websiteAdminAccess = await isWebsiteAdmin(user);
      if (websiteAdminAccess) await requireActivePortalStaff(user);
    }
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message || "Could not verify Website Admin access." });
  }
  if (!websiteAdminAccess) {
    return res.status(403).json({ error: "Website Admin permission required to send Discord notifications." });
  }

  if (req.method === "GET") {
    const token = process.env.DISCORD_BOT_TOKEN;
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!token || !guildId) {
      return res.status(503).json({ ok: false, botTokenConfigured: Boolean(token), guildConfigured: Boolean(guildId), error: "Bot token or server ID is missing." });
    }
    try {
      let botData;
      try { botData = await discordRequest({botToken:token}, "/users/@me"); }
      catch(error) {
        const code = String(error?.code || error?.status || "unknown");
        return res.status(200).json({
          ok: false, botTokenConfigured: true, guildConfigured: true,
          tokenValid: false, botInGuild: false, errorCode: code,
          message: code === "50014" || code === "40001"
            ? "Bot Token is invalid. Update DISCORD_BOT_TOKEN in Vercel."
            : "Could not authenticate the Discord bot."
        });
      }
      let guildData;
      try { guildData = await discordRequest({botToken:token}, "/guilds/" + encodeURIComponent(guildId)); }
      catch(error) {
        guildData = {code:error?.code||error?.status||"unknown"};

        return res.status(200).json({
          ok: true, tokenValid: true, botInGuild: false,
          botUsername: botData.username || null,
          errorCode: String(guildData.code || error?.status || "unknown"),
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

  if (!requireSameOrigin(req, res)) return;

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  if (body.action === "edit_site_notice" || body.action === "delete_site_notice" || body.action === "resend_site_notice") {
    const noticeId = typeof body.noticeId === "string" ? body.noticeId.trim() : "";
    if (!isSiteNoticeId(noticeId)) return res.status(400).json({ error: "معرّف التعميم غير صالح." });
    try {
      if (body.action === "edit_site_notice") {
        const result = await updatePublishedSiteNotice(user, noticeId);
        return res.status(200).json({ ok: true, ...result });
      }
      if (body.action === "delete_site_notice") {
        const result = await deleteSiteNoticePublication(user, noticeId);
        return res.status(200).json({ ok: true, ...result });
      }
      const result = await publishSavedSiteNotice(user, noticeId, { allowResend: true });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      return res.status(error.status || 502).json({
        error: error.message || "تعذّر تنفيذ العملية على التعميم.",
        code: error.code || null
      });
    }
  }

  if (body.action === "publish_site_notice") {
    const noticeId = typeof body.noticeId === "string" ? body.noticeId.trim() : "";
    if (!isSiteNoticeId(noticeId)) {
      return res.status(400).json({ error: "معرّف التعميم غير صالح." });
    }
    try {
      const result = await publishSavedSiteNotice(user, noticeId);
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      return res.status(error.status || 502).json({
        error: error.message || "تعذّر نشر التعميم إلى Discord.",
        code: error.code || null
      });
    }
  }

  if (body.action === "publish_rule") {
    const ruleId = typeof body.ruleId === "string" ? body.ruleId.trim() : "";
    if (!ruleId || ruleId.length > 180) {
      return res.status(400).json({ error: "معرّف القانون غير صالح." });
    }
    try {
      const result = await publishSavedRuleToDiscord(user, ruleId);
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      return res.status(error.status || 502).json({
        error: error.message || "تعذر نشر القانون إلى Discord.",
        messagesSent: Number(error.messagesSent || 0),
        partial: Boolean(error.partial),
        messageIds: Array.isArray(error.messageIds) ? error.messageIds : []
      });
    }
  }

  const type = body.entity_type;
  const entityId = typeof body.entity_id === "string" ? body.entity_id.trim() : "";
  const batchKey = typeof body.batch_key === "string" ? body.batch_key : "";

  if (!["person", "case", "operation", "report", "investigation", "task", "announcement"].includes(type) ||
      !entityId || entityId.length > 100 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchKey)) {
    return res.status(400).json({ error: "Invalid notification request." });
  }

  const config = getConfig();
  if (config.error === "bot_token_missing") {
    return res.status(503).json({ error: "Discord bot is not connected yet. Add DISCORD_BOT_TOKEN to Vercel Production." });
  }
  if (config.error) return res.status(503).json({ error: "Notification storage is not configured." });
  if (!await isActiveStaffForNotifications(config, user)) {
    return res.status(403).json({ error: "This staff account is inactive or could not be verified. Sign in again or contact the portal owner." });
  }

  const channelRoute = type === "announcement"
    ? { id: config.announcementPostChannelId, label: "الإعلانات" }
    : ["person", "case", "investigation"].includes(type)
      ? { id: config.evidenceChannelId, label: "الأدلة والملفات" }
      : { id: config.notificationChannelId, label: "الإشعارات العامة" };
  const targetChannelId = String(channelRoute.id || "").trim();
  if (!/^\d{17,20}$/.test(targetChannelId)) {
    const variable = type === "announcement"
      ? "DISCORD_ANNOUNCEMENT_POST_CHANNEL_ID"
      : ["person", "case", "investigation"].includes(type)
        ? "DISCORD_EVIDENCE_CHANNEL_ID"
        : "DISCORD_NOTIFICATION_CHANNEL_ID";
    return res.status(503).json({ error: "وجهة روم Discord غير صالحة. راجع " + variable + " في إعدادات Vercel." });
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
    const sourceKey = ({ person: "people", case: "cases", operation: "operations", report: "reports", investigation: "investigations", announcement: "announcements" })[type];
    const records = type === "task" ? (Array.isArray(state.tasks) ? state.tasks : []) : (Array.isArray(state[sourceKey]) ? state[sourceKey] : []);
    const record = type === "task" ? records[Number(entityId)] : records.find(item => String(item?.id ?? "") === entityId);
    if (!record) return res.status(404).json({ error: "The selected record was not found. Refresh the portal and try again." });
    if (type === "task" && (typeof body.task_text !== "string" || !body.task_text.trim() || body.task_text.trim() !== String(record.text || "").trim())) {
      return res.status(409).json({ error: "The selected task changed. Refresh the portal and try again." });
    }

    const deliverySettingsQuery = new URLSearchParams({
      key: "in.(notificationRoleMentionDisabled,notificationChannelEnabled,notificationMemberDmEnabled)",
      select: "key,value"
    });
    const deliverySettingsResponse = await supabaseRequest(config, "site_settings?" + deliverySettingsQuery, { method: "GET" });
    if (!deliverySettingsResponse.ok) {
      console.error("Notification delivery settings lookup failed:", deliverySettingsResponse.status, (await deliverySettingsResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not verify the owner notification delivery settings. No alert was sent." });
    }
    const deliverySettingsRows = await deliverySettingsResponse.json();
    const deliverySettings = new Map(deliverySettingsRows.map(row => [row.key, row.value]));
    const notificationRoleMentionDisabled = deliverySettings.get("notificationRoleMentionDisabled") !== false;
    // Both delivery channels start disabled until the owner explicitly enables them.
    const channelEnabled = deliverySettings.get("notificationChannelEnabled") === true;
    const memberDmEnabled = deliverySettings.get("notificationMemberDmEnabled") === true;

    const ownerDiscordId = String(process.env.DISCORD_OWNER_ID || "");
    if (!/^\d{17,20}$/.test(ownerDiscordId)) {
      return res.status(503).json({ error: "The protected owner Discord ID is not configured; no notification was sent." });
    }

    // Personal opt-out applies to every account, including the portal owner.
    // When broadcast is disabled, only the owner is considered, and only if the
    // owner's own private-notification preference remains enabled.
    const broadcastEnabled = process.env.DISCORD_NOTIFICATIONS_BROADCAST_ENABLED === "true";
    const recipientQuery = new URLSearchParams({
      select: "discord_user_id,display_name",
      notifications_enabled: "eq.true",
      is_active: "eq.true",
      is_banned: "eq.false",
      order: "created_at.asc"
    });
    if (!memberDmEnabled || !broadcastEnabled) {
      recipientQuery.set("discord_user_id", "eq." + ownerDiscordId);
    }
    const recipientResponse = await supabaseRequest(config, "staff_profiles?" + recipientQuery, { method: "GET" });
    if (!recipientResponse.ok) {
      console.error("Notification recipient lookup failed:", recipientResponse.status, (await recipientResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not load notification recipients." });
    }
    const recipientRows = await recipientResponse.json();
    const recipients = recipientRows
      .filter(row => /^\d{17,20}$/.test(String(row.discord_user_id || "")))
      .sort((a, b) => String(a.discord_user_id).localeCompare(String(b.discord_user_id)));
    const ownerIncluded = recipients.some(row => String(row.discord_user_id) === ownerDiscordId);

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
      case: "قضية",
      operation: "عملية / اجتماع",
      report: "تقرير إداري",
      investigation: "ملف تحرٍّ",
      task: "مهمة اليوم",
      announcement: "إعلان إداري"
    })[type] || "إشعار إداري";
    const announcementDateText = record.dateTime
      ? new Date(record.dateTime).toLocaleString("ar-SA", {
          timeZone: "Asia/Riyadh",
          dateStyle: "full",
          timeStyle: "short"
        }) + " (توقيت الرياض)"
      : "لم يتم تحديد موعد";
    const reportTitleText = type === "report" ? String(record.title || "").trim() : "";
    const reportBodyText = type === "report"
      ? String(record.content || record.body || record.description || record.text || "").trim()
      : "";
    const reportFullText = type === "report"
      ? [
          reportTitleText ? "عنوان التقرير: " + reportTitleText : "",
          record.reportType ? "نوع التقرير: " + String(record.reportType) : "",
          record.summary ? "الملخص: " + String(record.summary) : "",
          reportBodyText && reportBodyText !== reportTitleText ? "التفاصيل الكاملة: " + reportBodyText : "",
          record.findings ? "النتائج والملاحظات: " + String(record.findings) : "",
          record.recommendations ? "التوصيات: " + String(record.recommendations) : "",
          record.linkedEntityLabel ? "السجل المرتبط: " + String(record.linkedEntityLabel) : ""
        ].filter(Boolean).join("\n\n")
      : "";

    // One shared visual system for every site-generated notification:
    // strong title, readable main description, compact metadata, red accent and footer.
    const notificationBodyText = type === "announcement"
      ? String(record.description || "").trim()
      : type === "person"
        ? String(record.charges || record.notes || record.description || "").trim()
        : type === "case"
        ? [
            record.charge ? "التهمة / سبب القضية: " + String(record.charge).trim() : "",
            record.summary ? "ملخص القضية: " + String(record.summary).trim() : "",
            record.details ? "التفاصيل والإجراءات:\n" + String(record.details).trim() : ""
          ].filter(Boolean).join("\n\n")
        : type === "operation"
          ? [
              record.description ? "الوصف: " + String(record.description).trim() : "",
              record.details ? "تفاصيل العملية:\n" + String(record.details).trim() : ""
            ].filter(Boolean).join("\n\n") || "تم تسجيل العملية في بوابة S.W.A.T. REDLINE."
          : type === "report"
            ? reportFullText || "تم إنشاء تقرير إداري في بوابة S.W.A.T. REDLINE."
            : type === "task"
              ? String(record.text || "").trim()
              : String(record.incident || record.notes || record.description || "").trim();

    const notificationBody = notificationBodyText || "لا توجد تفاصيل إضافية.";
    const notificationBodyChunks = splitDiscordText(notificationBody, 3800);
    const mainDescription = notificationBodyChunks[0] || "لا توجد تفاصيل إضافية.";

    const titleByType = {
      announcement: (record.type === "meeting" ? "📅 اجتماع | " : "📣 إعلان | ") + String(record.title || "إعلان جديد"),
      person: "👤 ملف شخص | " + String(record.name || "بدون اسم"),
      case: "📁 قضية | " + String(record.title || "قضية جديدة"),
      operation: "🎯 عملية | " + String(record.name || record.title || "عملية جديدة"),
      report: "📄 تقرير إداري | " + String(record.title || "تقرير جديد").slice(0, 175),
      task: "✅ مهمة اليوم",
      investigation: "🔎 ملف تحرٍّ | " + String(record.title || record.name || "ملف جديد")
    };
    const notificationTitle = truncate(titleByType[type] || ("📣 " + subjectKind), 240);

    const metadataFields = type === "announcement"
      ? [
          { name: "🗓️ الموعد", value: truncate(announcementDateText, 180), inline: true },
          { name: "📌 النوع", value: truncate(record.typeLabel || "إعلان", 100), inline: true }
        ]
      : type === "case"
        ? [
            { name: "🔢 رقم القضية", value: truncate(record.id || "—", 80), inline: true },
            { name: "🏷️ نوع القضية", value: truncate(record.caseType || "غير محدد", 100), inline: true },
            { name: "🚦 الحالة", value: truncate(record.status || "مفتوحة", 80), inline: true },
            { name: "👤 الشخص المرتبط", value: truncate(record.personName || "غير مرتبط", 120), inline: true },
            { name: "🎖️ المسؤول", value: truncate(record.assignedTo || record.owner || "غير محدد", 120), inline: true }
          ]
        : type === "operation"
          ? [
            { name: "🕒 وقت بدء العملية", value: truncate(record.time || record.scheduledAt || "غير محدد", 180), inline: true },
            { name: "🚦 الحالة", value: truncate(record.status || "غير محددة", 80), inline: true },
            { name: "🎖️ المسؤول", value: truncate(record.owner || "غير محدد", 120), inline: true },
            { name: "🔢 رقم العملية", value: truncate(record.id || "—", 80), inline: true }
          ]
        : summary.fields.filter(field =>
            !/^(الاسم|اسم العملية|عنوان الملف|اسم التقرير|المهمة|التفاصيل|ملخص الواقعة)$/i.test(String(field.name || "").trim())
          );

    metadataFields.unshift({
      name: "👤 أُرسل بواسطة",
      value: "**" + truncate(user.displayName || user.username, 100) + "**\n@" + truncate(user.username, 100),
      inline: true
    });

    const embed = {
      author: { name: "S.W.A.T. REDLINE  •  الإشعارات الرسمية" },
      title: notificationTitle,
      description: "**التفاصيل**\n\n" + truncate(mainDescription, 4000),
      color: 0xD92735,
      fields: metadataFields,
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
    // Long descriptions continue with the same official visual identity.
    notificationBodyChunks.slice(1).forEach((chunk, index) => {
      notificationMessages.push({
        embeds: [{
          author: { name: "S.W.A.T. REDLINE  •  الإشعارات الرسمية" },
          title: "استكمال | " + notificationTitle + " — " + (index + 2) + "/" + notificationBodyChunks.length,
          description: "**استكمال التفاصيل**\n\n" + chunk,
          color: 0xD92735,
          footer: { text: "S.W.A.T. REDLINE  •  SECURE COMMAND CENTER" },
          timestamp: new Date().toISOString()
        }],
        images: [],
        components: siteComponents,
        content: "",
        allowedMentions: { parse: [] }
      });
    });


    // Every manual alert is published once to the channel selected for its record type.
    // The DM recipient list, opt-ins, batching and delivery flow remain unchanged.
    // This is independent from per-member DM preferences.
    let channelSent = false;
    let channelMessageId = null;
    let channelErrorCode = null;
    let channelStatus = "disabled";
    if (channelEnabled) {
      channelStatus = "failed";
      try {
        for (let partIndex = 0; partIndex < notificationMessages.length; partIndex++) {
          const part = notificationMessages[partIndex];
          const channelMessage = await discordRequest(
            config,
            "/channels/" + encodeURIComponent(targetChannelId) + "/messages",
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
        channelStatus = "sent";
      } catch (error) {
        channelErrorCode = String(error?.code || error?.message || "channel_delivery_failed").slice(0, 80);
        console.error("Discord notification channel delivery failed:", channelErrorCode);
      }
    }

    let sent = 0;
    let failed = 0;
    let ownerDmSent = false;
    let ownerDmErrorCode = null;
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
        if (String(recipient.discord_user_id) === ownerDiscordId) ownerDmSent = true;
      } catch (error) {
        failed++;
        errorCode = String(error?.code || error?.message || "delivery_failed").slice(0, 80);
        if (String(recipient.discord_user_id) === ownerDiscordId) ownerDmErrorCode = errorCode;
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
        channel_status: channelStatus,
        channel_message_id: channelMessageId,
        channel_error_code: channelErrorCode
      })
    });
    if (!updateBatch.ok) {
      console.error("Notification batch summary update failed:", updateBatch.status, (await updateBatch.text()).slice(0, 200));
    }
    // Insert the final notification audit only after all deliveries finish.
    // audit_logs is intentionally append-only; the sender must never UPDATE it.
    await writeNotificationAudit(
      config, user, type, entityId, record, batchId,
      { channelStatus, channelMessageId, channelErrorCode, channelId: targetChannelId, channelLabel: channelRoute.label, dmTotal: recipients.length, dmSent: sent, dmFailed: failed }
    );

    return res.status(200).json({
      ok: true,
      total: recipients.length,
      sent,
      failed,
      channel_sent: channelSent,
      channel_enabled: channelEnabled,
      channel_disabled: !channelEnabled,
      members_dm_enabled: memberDmEnabled && broadcastEnabled,
      members_dm_disabled: !(memberDmEnabled && broadcastEnabled),
      owner_included: ownerIncluded,
      owner_dm_sent: ownerDmSent,
      owner_dm_error_code: ownerDmErrorCode,
      role_ping_sent: channelSent && !notificationRoleMentionDisabled,
      channel_error_code: channelErrorCode,
      channel_id: targetChannelId,
      channel_label: channelRoute.label,
      failure_reasons: {
        no_mutual_guild: failureReasons["50278"] || 0,
        recipient_dm_blocked: failureReasons["50007"] || 0,
        other: Object.entries(failureReasons).filter(([code]) => !["50278", "50007"].includes(code)).reduce((sum, [, count]) => sum + count, 0)
      },
      mode: broadcastEnabled ? "broadcast" : "test_self",
      message: !recipients.length
        ? "No eligible recipients have private notifications enabled."
        : channelStatus === "disabled"
          ? `Channel publishing is disabled by the owner. ${sent} private messages sent.`
          : channelStatus === "failed"
            ? `Channel publishing failed; ${sent} private messages sent and ${failed} failed independently.`
            : failed
              ? `Channel post published; ${sent} private messages sent and ${failed} failed.`
              : `Channel post published; ${sent} private messages sent.`
    });
  } catch (error) {
    console.error("Notification send failed:", error instanceof Error ? error.message : "unknown");
    return res.status(500).json({ error: "The notification batch could not be completed." });
  }
}
