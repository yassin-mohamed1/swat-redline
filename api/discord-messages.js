import crypto from "node:crypto";
import { requireSameOrigin } from "../lib/request-security.js";
import { discordApiRequest } from "../lib/discord-rest.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../lib/portal-admin.js";
import { buildDiscordMessageEmbed, DISCORD_ATTACHMENT_SAFE_LIMIT } from "../lib/discord-message-format.js";

const STORAGE_BUCKET = "swat-discord-messages";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_ID_RE = /^\d{15,22}$/;

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
  return { id: user.id, username: user.username, displayName: user.displayName || user.username, isOwner };
}

function getConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!base || !serviceKey) return { error: "storage_not_configured" };
  if (!botToken || !DISCORD_ID_RE.test(String(guildId || ""))) return { error: "bot_not_configured" };
  return { base, serviceKey, botToken, guildId };
}

function jsonHeaders(serviceKey) {
  return { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
}

async function dbRequest(config, path, options = {}) {
  return fetch(config.base + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: config.serviceKey,
      Authorization: "Bearer " + config.serviceKey,
      ...(options.headers || {})
    }
  });
}

async function storageRequest(config, path, options = {}) {
  return fetch(config.base + "/storage/v1/" + path, {
    ...options,
    headers: {
      apikey: config.serviceKey,
      Authorization: "Bearer " + config.serviceKey,
      ...(options.headers || {})
    }
  });
}

function encodeStoragePath(path) {
  return String(path).split("/").map(part => encodeURIComponent(part)).join("/");
}

function storageUrl(config, returnedPath) {
  const value = String(returnedPath || "");
  if (/^https?:\/\//i.test(value)) return value;
  return config.base + "/storage/v1" + (value.startsWith("/") ? value : "/" + value);
}

async function requirePortalAdmin(req, res) {
  const user = readSession(req);
  if (!user) {
    res.status(401).json({ error: "يلزم تسجيل الدخول إلى بوابة S.W.A.T. REDLINE." });
    return null;
  }
  try {
    const allowed = Boolean(user.isOwner) || await isWebsiteAdmin(user);
    if (!allowed) {
      res.status(403).json({ error: "إرسال الرسائل وإدارتها متاحان للمالك وWebsite Admin فقط." });
      return null;
    }
    if (!user.isOwner) await requireActivePortalStaff(user);
    return user;
  } catch (error) {
    res.status(error.status || 503).json({ error: error.message || "تعذّر التحقق من صلاحيات الإدارة." });
    return null;
  }
}

function normalizeMessageRow(row) {
  return {
    id: String(row.id),
    title: String(row.title || ""),
    content_preview: String(row.content_preview || ""),
    content_chars: Number(row.content_chars || 0),
    content_bytes: Number(row.content_bytes || 0),
    created_by_name: String(row.created_by_name || ""),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_sent_at: row.last_sent_at || null,
    last_sent_channel_id: row.last_sent_channel_id || null,
    send_count: Number(row.send_count || 0)
  };
}

async function loadMessage(config, id) {
  const query = new URLSearchParams({
    id: "eq." + id,
    select: "id,title,storage_path,content_preview,content_chars,content_bytes,created_by_discord_id,created_by_name,created_at,updated_at,last_sent_at,last_sent_channel_id,last_sent_message_id,send_count",
    limit: "1"
  });
  const response = await dbRequest(config, "discord_saved_messages?" + query.toString());
  if (!response.ok) {
    console.error("Saved Discord message lookup failed:", response.status, (await response.text()).slice(0, 300));
    throw Object.assign(new Error("تعذّر قراءة الرسالة المحفوظة."), { status: 502 });
  }
  const rows = await response.json();
  if (!rows[0]) throw Object.assign(new Error("الرسالة المحفوظة غير موجودة."), { status: 404 });
  return rows[0];
}

async function createSignedUpload(config) {
  const path = "messages/" + crypto.randomUUID() + ".txt";
  const storagePath = STORAGE_BUCKET + "/" + encodeStoragePath(path);
  const response = await storageRequest(config, "object/upload/sign/" + storagePath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) {
    console.error("Could not create signed message upload URL:", response.status, data.message || data.error || "");
    throw Object.assign(new Error("تعذّر تجهيز مساحة آمنة لحفظ نص الرسالة."), { status: 502 });
  }
  return { path, signed_url: storageUrl(config, data.url) };
}

async function createSignedDownload(config, path) {
  const storagePath = STORAGE_BUCKET + "/" + encodeStoragePath(path);
  const response = await storageRequest(config, "object/sign/" + storagePath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.signedURL) {
    console.error("Could not create signed message download URL:", response.status, data.message || data.error || "");
    throw Object.assign(new Error("تعذّر فتح محتوى الرسالة المحفوظة."), { status: 502 });
  }
  return storageUrl(config, data.signedURL);
}

async function removeStoredContent(config, path) {
  if (!path || !/^messages\/[0-9a-f-]{36}\.txt$/i.test(path)) return false;
  const response = await storageRequest(config, "object/" + STORAGE_BUCKET, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [path] })
  });
  if (!response.ok) console.warn("Saved Discord message file cleanup failed:", response.status);
  return response.ok;
}

async function listChannels(config) {
  const channels = await discordApiRequest(
    config.botToken,
    "/guilds/" + encodeURIComponent(config.guildId) + "/channels",
    {},
    { maxRetries: 2, maxRetryWaitMs: 5000 }
  );
  let threads = [];
  try {
    const active = await discordApiRequest(
      config.botToken,
      "/guilds/" + encodeURIComponent(config.guildId) + "/threads/active",
      {},
      { maxRetries: 1, maxRetryWaitMs: 2500 }
    );
    threads = Array.isArray(active?.threads) ? active.threads : [];
  } catch (error) {
    console.warn("Active Discord threads could not be listed:", error?.status || error?.code || "unknown");
  }
  const typeLabels = {
    0: "نصية", 2: "صوتية", 4: "تصنيف", 5: "إعلانات",
    10: "سلسلة إعلانات", 11: "محادثة عامة", 12: "محادثة خاصة",
    13: "Stage", 15: "Forum", 16: "Media"
  };
  const seen = new Set();
  const mapped = [...(Array.isArray(channels) ? channels : []), ...threads].filter(channel => {
    const id = String(channel?.id || "");
    if (!DISCORD_ID_RE.test(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(channel => ({
    id: String(channel.id),
    name: String(channel.name || "بدون اسم"),
    type: Number(channel.type),
    type_label: typeLabels[Number(channel.type)] || "قناة",
    parent_id: channel.parent_id ? String(channel.parent_id) : null,
    position: Number(channel.position || 0),
    category: Number(channel.type) === 4,
    selectable: Number(channel.type) !== 4
  }));
  const categories = mapped.filter(channel => channel.category).sort((a,b) => a.position-b.position);
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const resultChannels = mapped.filter(channel => !channel.category).map(channel => ({
    ...channel,
    category_name: channel.parent_id ? categoryNames.get(channel.parent_id) || null : null
  })).sort((a,b) => {
    const ca = a.category_name || "~~~~";
    const cb = b.category_name || "~~~~";
    return ca.localeCompare(cb) || a.position-b.position || a.name.localeCompare(b.name);
  });
  const guildResponse = await discordApiRequest(
    config.botToken,
    "/guilds/" + encodeURIComponent(config.guildId),
    {},
    { maxRetries: 1, maxRetryWaitMs: 2500 }
  ).catch(() => null);
  return {
    guild_name: guildResponse?.name || "Discord Server",
    categories,
    channels: resultChannels,
    total: resultChannels.length,
    note: "تظهر القنوات التي يستطيع البوت رؤيتها. التصنيفات للتنظيم فقط وليست وجهات إرسال."
  };
}

async function sendSavedMessage(config, user, messageId, channelId) {
  const row = await loadMessage(config, messageId);
  const channel = await discordApiRequest(
    config.botToken,
    "/channels/" + encodeURIComponent(channelId),
    {},
    { maxRetries: 2, maxRetryWaitMs: 4000 }
  );
  if (String(channel?.guild_id || "") !== config.guildId) {
    throw Object.assign(new Error("القناة المحددة ليست ضمن سيرفر S.W.A.T."), { status: 400 });
  }
  const channelType = Number(channel.type);
  if (channelType === 4) {
    throw Object.assign(new Error("اختر قناة داخل التصنيف، وليس التصنيف نفسه."), { status: 400 });
  }
  if (Number(row.content_bytes || 0) > DISCORD_ATTACHMENT_SAFE_LIMIT) {
    throw Object.assign(new Error("النص محفوظ، لكن حجمه يتجاوز الحد الآمن لملف Discord واحد. قلّل حجم الملف قبل الإرسال؛ لم يتم تقسيمه ولم تُرسل أي رسالة."), { status: 413 });
  }

  const download = await storageRequest(config, "object/authenticated/" + STORAGE_BUCKET + "/" + encodeStoragePath(row.storage_path));
  if (!download.ok) {
    console.error("Saved Discord message content download failed:", download.status);
    throw Object.assign(new Error("تعذّر قراءة محتوى الرسالة من التخزين."), { status: 502 });
  }
  const contentBuffer = new Uint8Array(await download.arrayBuffer());
  if (contentBuffer.byteLength > DISCORD_ATTACHMENT_SAFE_LIMIT) {
    throw Object.assign(new Error("النص أكبر من الحد الآمن لملف Discord واحد. لم يتم الإرسال."), { status: 413 });
  }
  const content = new TextDecoder("utf-8", { fatal: false }).decode(contentBuffer);
  const formatted = buildDiscordMessageEmbed({ title: row.title, content });
  const payload = {
    embeds: [formatted.embed],
    allowed_mentions: { parse: [] }
  };
  const useForumThread = channelType === 15 || channelType === 16;
  const endpoint = useForumThread
    ? "/channels/" + encodeURIComponent(channelId) + "/threads"
    : "/channels/" + encodeURIComponent(channelId) + "/messages";
  let requestBody;
  if (formatted.useAttachment) {
    const form = new FormData();
    const multipartPayload = useForumThread
      ? { name: String(row.title || "رسالة S.W.A.T.").slice(0, 100), auto_archive_duration: 1440, message: payload }
      : payload;
    form.append("payload_json", JSON.stringify(multipartPayload));
    form.append("files[0]", new Blob([contentBuffer], { type: "text/plain;charset=utf-8" }), formatted.filename);
    requestBody = form;
  } else if (useForumThread) {
    requestBody = {
      name: String(row.title || "رسالة S.W.A.T.").slice(0, 100),
      auto_archive_duration: 1440,
      message: payload
    };
  } else {
    requestBody = payload;
  }

  let sent;
  try {
    sent = await discordApiRequest(config.botToken, endpoint, {
      method: "POST",
      body: requestBody instanceof FormData ? requestBody : JSON.stringify(requestBody)
    }, { maxRetries: 2, maxRetryWaitMs: 5000 });
  } catch (error) {
    const status = Number(error?.status || 0);
    const message = status === 403
      ? "البوت لا يملك الصلاحية المطلوبة في هذه القناة. راجع View Channel وSend Messages، ومع النص الطويل Attach Files وEmbed Links."
      : status === 404
        ? "القناة غير موجودة أو لم يعد البوت يستطيع الوصول إليها."
        : status === 400 && (channelType === 15 || channelType === 16)
          ? "تعذّر إنشاء منشور في قناة المنتدى/الوسائط. راجع صلاحية Send Messages وأي شروط خاصة بالقناة."
          : status === 429
            ? "Discord فرض انتظارًا مؤقتًا بسبب كثرة الطلبات. حاول مرة أخرى بعد انتهاء المهلة."
            : "فشل الإرسال إلى Discord. رمز الخطأ: " + String(error?.code || status || "unknown");
    throw Object.assign(new Error(message), { status: 502, code: error?.code || status || null });
  }

  const sentMessageId = String(sent?.id || sent?.message?.id || "");
  const sentChannelId = String(sent?.channel_id || sent?.id || channelId);
  const actor = String(user.displayName || user.username || "S.W.A.T. Admin").slice(0, 100);
  try {
    await dbRequest(config, "discord_saved_messages?id=eq." + encodeURIComponent(messageId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        last_sent_at: new Date().toISOString(),
        last_sent_channel_id: channelId,
        last_sent_message_id: sentMessageId || null,
        send_count: Number(row.send_count || 0) + 1
      })
    });
    await dbRequest(config, "audit_logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        actor_discord_id: user.id,
        actor_name: actor,
        action: "create",
        entity_type: "discord_saved_message_delivery",
        entity_id: messageId,
        details: {
          type: "إرسال رسالة محفوظة إلى Discord",
          detail: actor + " أرسل الرسالة «" + String(row.title || "").slice(0, 160) + "» في #" + String(channel.name || "قناة") + ".",
          channel_id: channelId,
          channel_name: channel.name || null,
          discord_message_id: sentMessageId || null,
          attached_text_file: formatted.useAttachment,
          content_chars: Number(row.content_chars || 0),
          content_bytes: contentBuffer.byteLength
        }
      })
    });
  } catch (error) {
    console.warn("Saved Discord message audit/update failed:", error?.message || "unknown");
  }
  return {
    ok: true,
    channel_id: channelId,
    channel_name: String(channel.name || ""),
    message_id: sentMessageId || null,
    message_url: sentMessageId ? "https://discord.com/channels/" + config.guildId + "/" + sentChannelId + "/" + sentMessageId : null,
    single_message: true,
    attached_text_file: formatted.useAttachment
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const user = await requirePortalAdmin(req, res);
  if (!user) return;
  const config = getConfig();
  if (config.error === "bot_not_configured") {
    return res.status(503).json({ error: "اتصال بوت Discord أو معرّف السيرفر غير مضبوط في إعدادات Vercel." });
  }
  if (config.error) return res.status(503).json({ error: "قاعدة البيانات غير مضبوطة." });

  const url = new URL(req.url, "https://swat-redline.vercel.app");
  if (req.method === "GET") {
    const action = url.searchParams.get("action") || "list";
    try {
      if (action === "channels") {
        const data = await listChannels(config);
        return res.status(200).json({ ok: true, ...data });
      }
      if (action === "content") {
        const id = String(url.searchParams.get("id") || "");
        if (!UUID_RE.test(id)) return res.status(400).json({ error: "معرّف الرسالة غير صالح." });
        const row = await loadMessage(config, id);
        const signed_url = await createSignedDownload(config, row.storage_path);
        return res.status(200).json({ ok: true, id, title: row.title, signed_url });
      }
      if (action === "list") {
        const query = new URLSearchParams({
          select: "id,title,content_preview,content_chars,content_bytes,created_by_name,created_at,updated_at,last_sent_at,last_sent_channel_id,send_count",
          order: "created_at.desc",
          limit: "250"
        });
        const response = await dbRequest(config, "discord_saved_messages?" + query.toString());
        if (!response.ok) {
          console.error("Saved Discord message list failed:", response.status, (await response.text()).slice(0, 300));
          return res.status(502).json({ error: "تعذّر تحميل الرسائل المحفوظة." });
        }
        return res.status(200).json({ ok: true, messages: (await response.json()).map(normalizeMessageRow) });
      }
      return res.status(400).json({ error: "طلب GET غير معروف." });
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.message || "تعذّر تنفيذ الطلب." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!requireSameOrigin(req, res)) return;
  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const action = String(body.action || "");

  try {
    if (action === "upload_url") {
      const upload = await createSignedUpload(config);
      return res.status(200).json({ ok: true, ...upload });
    }

    if (action === "save") {
      const id = body.id ? String(body.id) : "";
      if (id && !UUID_RE.test(id)) return res.status(400).json({ error: "معرّف الرسالة غير صالح." });
      const title = String(body.title || "").trim();
      const storagePath = String(body.storage_path || "");
      const contentPreview = String(body.content_preview || "").slice(0, 600);
      const contentChars = Number(body.content_chars);
      const contentBytes = Number(body.content_bytes);
      if (!title || title.length > 256 || !/^messages\/[0-9a-f-]{36}\.txt$/i.test(storagePath) ||
          !Number.isSafeInteger(contentChars) || contentChars < 0 ||
          !Number.isSafeInteger(contentBytes) || contentBytes < 0) {
        return res.status(400).json({ error: "تأكد من اسم الرسالة ورفع المحتوى كاملًا قبل الحفظ." });
      }
      const now = new Date().toISOString();
      if (id) {
        const old = await loadMessage(config, id);
        const response = await dbRequest(config, "discord_saved_messages?id=eq." + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify({
            title,
            storage_path: storagePath,
            content_preview: contentPreview,
            content_chars: contentChars,
            content_bytes: contentBytes,
            updated_at: now
          })
        });
        if (!response.ok) {
          console.error("Saved Discord message update failed:", response.status, (await response.text()).slice(0, 300));
          return res.status(502).json({ error: "تعذّر حفظ تعديلات الرسالة." });
        }
        await removeStoredContent(config, old.storage_path);
        const rows = await response.json();
        return res.status(200).json({ ok: true, message: normalizeMessageRow(rows[0]) });
      }
      const payload = {
        title,
        storage_path: storagePath,
        content_preview: contentPreview,
        content_chars: contentChars,
        content_bytes: contentBytes,
        created_by_discord_id: user.id,
        created_by_name: String(user.displayName || user.username || "S.W.A.T. Admin").slice(0, 100)
      };
      const response = await dbRequest(config, "discord_saved_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        console.error("Saved Discord message insert failed:", response.status, (await response.text()).slice(0, 300));
        return res.status(502).json({ error: "تعذّر حفظ الرسالة الجديدة." });
      }
      const rows = await response.json();
      return res.status(201).json({ ok: true, message: normalizeMessageRow(rows[0]) });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!UUID_RE.test(id)) return res.status(400).json({ error: "معرّف الرسالة غير صالح." });
      const row = await loadMessage(config, id);
      const response = await dbRequest(config, "discord_saved_messages?id=eq." + encodeURIComponent(id), { method: "DELETE" });
      if (!response.ok) {
        console.error("Saved Discord message deletion failed:", response.status, (await response.text()).slice(0, 300));
        return res.status(502).json({ error: "تعذّر حذف الرسالة من السجل." });
      }
      await removeStoredContent(config, row.storage_path);
      return res.status(200).json({ ok: true });
    }

    if (action === "send") {
      const id = String(body.id || "");
      const channelId = String(body.channel_id || "");
      if (!UUID_RE.test(id) || !DISCORD_ID_RE.test(channelId)) {
        return res.status(400).json({ error: "اختر رسالة وقناة صحيحتين." });
      }
      const result = await sendSavedMessage(config, user, id, channelId);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "عملية غير معروفة." });
  } catch (error) {
    console.error("Discord saved messages API failed:", error?.message || "unknown");
    return res.status(error.status || 500).json({
      error: error.message || "تعذّر تنفيذ العملية.",
      code: error.code || null
    });
  }
}
