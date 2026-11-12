import crypto from "node:crypto";
import { discordApiRequest } from "./discord-rest.js";
import { forwardAuditToDiscord } from "./audit-log.js";
import { buildDiscordMessageContent, DISCORD_ATTACHMENT_SAFE_LIMIT, DISCORD_MESSAGE_CONTENT_LIMIT } from "./discord-message-format.js";

const STORAGE_BUCKET = "swat-discord-messages";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_ID_RE = /^\d{15,22}$/;



function toWellFormedUnicode(value) {
  const input = String(value ?? "");
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
    } else {
      output += input[index];
    }
  }
  return output;
}

function truncateUnicode(value, maxCodePoints) {
  return Array.from(toWellFormedUnicode(value)).slice(0, maxCodePoints).join("");
}


function dbRequest(config, path, options = {}) {
  return fetch(config.base + "/rest/v1/" + path, {
    ...options,
    headers: { apikey: config.serviceKey, Authorization: "Bearer " + config.serviceKey, ...(options.headers || {}) }
  });
}
async function appendSavedMessageAudit(config,user,event) {
  const auditEvent={
    actor_discord_id:String(user?.id||""),
    actor_name:String(user?.displayName||user?.username||"S.W.A.T. Admin").slice(0,100),
    action:String(event?.action||"update"),
    entity_type:String(event?.entity_type||"discord_saved_message"),
    entity_id:event?.entity_id==null?null:String(event.entity_id).slice(0,160),
    details:event?.details&&typeof event.details==="object"?event.details:{}
  };
  try {
    const response=await dbRequest(config,"audit_logs",{
      method:"POST",
      headers:{"Content-Type":"application/json",Prefer:"return=minimal"},
      body:JSON.stringify(auditEvent)
    });
    if(!response.ok) {
      console.error("Saved Discord message audit write failed:",response.status,(await response.text()).slice(0,250));
      return false;
    }
    const delivery=await forwardAuditToDiscord(user,auditEvent);
    if(!delivery?.ok)console.warn("Saved Discord message audit was saved but Discord forwarding is pending:",delivery?.reason||delivery?.failed||"unknown");
    return true;
  } catch(error) {
    console.error("Saved Discord message audit failed:",error?.message||"unknown");
    return false;
  }
}
function storageRequest(config, path, options = {}) {
  return fetch(config.base + "/storage/v1/" + path, {
    ...options,
    headers: { apikey: config.serviceKey, Authorization: "Bearer " + config.serviceKey, ...(options.headers || {}) }
  });
}
function encodeStoragePath(path) {
  return String(path).split("/").map(part => encodeURIComponent(part)).join("/");
}
function storageUrl(config, value) {
  const path = String(value || "");
  return /^https?:\/\//i.test(path) ? path : config.base + "/storage/v1" + (path.startsWith("/") ? path : "/" + path);
}
export function normalizeDiscordLinkButtons(input) {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input) || input.length > 25) {
    throw Object.assign(new Error("يمكن إضافة 25 زرار رابط كحد أقصى لكل رسالة."), { status: 400 });
  }
  const output = [];
  for (const entry of input) {
    const label = String(entry?.label || "").trim();
    const rawUrl = String(entry?.url || "").trim();
    if (!label || label.length > 80) {
      throw Object.assign(new Error("اسم الزرار مطلوب، وبحد أقصى 80 حرفًا."), { status: 400 });
    }
    if (!rawUrl || rawUrl.length > 512) {
      throw Object.assign(new Error("رابط الزرار مطلوب، وبحد أقصى 512 حرفًا."), { status: 400 });
    }
    let parsed;
    try { parsed = new URL(rawUrl); } catch {
      throw Object.assign(new Error("اكتب رابطًا صحيحًا يبدأ بـ https://."), { status: 400 });
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      throw Object.assign(new Error("روابط الأزرار يجب أن تكون HTTPS صالحة، من دون بيانات دخول مضمّنة."), { status: 400 });
    }
    const url = parsed.toString();
    if (url.length > 512) {
      throw Object.assign(new Error("الرابط بعد التحقق أطول من الحد المسموح به في Discord."), { status: 400 });
    }
    output.push({ label, url });
  }
  return output;
}

export function buildDiscordLinkComponents(input) {
  const buttons = normalizeDiscordLinkButtons(input);
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(index, index + 5).map(button => ({
        type: 2,
        style: 5,
        label: button.label,
        url: button.url
      }))
    });
  }
  return rows;
}

function normalizeRow(row) {
  return {
    id: String(row.id), title: String(row.title || ""), content_preview: String(row.content_preview || ""),
    content_chars: Number(row.content_chars || 0), content_bytes: Number(row.content_bytes || 0),
    created_by_name: String(row.created_by_name || ""), created_at: row.created_at || null,
    updated_at: row.updated_at || null, last_sent_at: row.last_sent_at || null,
    last_sent_channel_id: row.last_sent_channel_id || null, send_count: Number(row.send_count || 0),
    link_buttons: normalizeDiscordLinkButtons(row.link_buttons || [])
  };
}
async function loadMessage(config, id) {
  const query = new URLSearchParams({
    id: "eq." + id,
    select: "id,title,storage_path,content_preview,content_chars,content_bytes,created_by_discord_id,created_by_name,created_at,updated_at,last_sent_at,last_sent_channel_id,last_sent_message_id,send_count,link_buttons",
    limit: "1"
  });
  const response = await dbRequest(config, "discord_saved_messages?" + query.toString());
  if (!response.ok) {
    console.error("Saved Discord message lookup failed:", response.status, (await response.text()).slice(0, 250));
    throw Object.assign(new Error("تعذّر قراءة الرسالة المحفوظة."), { status: 502 });
  }
  const rows = await response.json();
  if (!rows[0]) throw Object.assign(new Error("الرسالة المحفوظة غير موجودة."), { status: 404 });
  return rows[0];
}
async function createSignedUpload(config) {
  const path = "messages/" + crypto.randomUUID() + ".txt";
  const response = await storageRequest(config, "object/upload/sign/" + STORAGE_BUCKET + "/" + encodeStoragePath(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) {
    console.error("Create signed message upload failed:", response.status, data.message || data.error || "");
    throw Object.assign(new Error("تعذّر تجهيز مساحة آمنة لحفظ نص الرسالة."), { status: 502 });
  }
  return { path, signed_url: storageUrl(config, data.url) };
}
async function createSignedDownload(config, path) {
  const response = await storageRequest(config, "object/sign/" + STORAGE_BUCKET + "/" + encodeStoragePath(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 300 })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.signedURL) {
    console.error("Create signed message download failed:", response.status, data.message || data.error || "");
    throw Object.assign(new Error("تعذّر فتح محتوى الرسالة المحفوظة."), { status: 502 });
  }
  return storageUrl(config, data.signedURL);
}
async function removeStoredContent(config, path) {
  if (!path || !/^messages\/[0-9a-f-]{36}\.txt$/i.test(path)) return false;
  const response = await storageRequest(config, "object/" + STORAGE_BUCKET, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [path] })
  });
  if (!response.ok) console.warn("Saved Discord message file cleanup failed:", response.status);
  return response.ok;
}
async function listChannels(config) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!DISCORD_ID_RE.test(String(guildId || ""))) throw Object.assign(new Error("معرّف سيرفر Discord غير مضبوط."), { status: 503 });
  const channels = await discordApiRequest(config.botToken, "/guilds/" + encodeURIComponent(guildId) + "/channels", {}, { maxRetries: 2, maxRetryWaitMs: 5000 });
  let threads = [];
  try {
    const active = await discordApiRequest(config.botToken, "/guilds/" + encodeURIComponent(guildId) + "/threads/active", {}, { maxRetries: 1, maxRetryWaitMs: 2500 });
    threads = Array.isArray(active?.threads) ? active.threads : [];
  } catch (error) { console.warn("Active Discord threads could not be listed:", error?.status || error?.code || "unknown"); }
  const labels = { 0:"نصية",2:"صوتية",4:"تصنيف",5:"إعلانات",10:"سلسلة إعلانات",11:"محادثة عامة",12:"محادثة خاصة",13:"Stage",15:"Forum",16:"Media" };
  const seen = new Set();
  const mapped = [...(Array.isArray(channels) ? channels : []), ...threads].filter(item => {
    const id = String(item?.id || "");
    if (!DISCORD_ID_RE.test(id) || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(item => ({
    id:String(item.id), name:String(item.name || "بدون اسم"), type:Number(item.type),
    type_label:labels[Number(item.type)] || "قناة", parent_id:item.parent_id ? String(item.parent_id) : null,
    position:Number(item.position || 0), category:Number(item.type) === 4
  }));
  const categories = mapped.filter(item => item.category).sort((a,b) => a.position-b.position);
  const categoryNames = new Map(categories.map(item => [item.id,item.name]));
  const resultChannels = mapped.filter(item => !item.category).map(item => ({
    ...item, category_name:item.parent_id ? categoryNames.get(item.parent_id) || null : null
  })).sort((a,b) => (a.category_name || "~~~~").localeCompare(b.category_name || "~~~~") || a.position-b.position || a.name.localeCompare(b.name));
  const guild = await discordApiRequest(config.botToken, "/guilds/" + encodeURIComponent(guildId), {}, { maxRetries:1,maxRetryWaitMs:2500 }).catch(() => null);
  return {
    guild_name:guild?.name || "Discord Server", categories, channels:resultChannels, total:resultChannels.length,
    note:"تظهر القنوات التي يستطيع البوت رؤيتها. التصنيفات للتنظيم فقط وليست وجهات إرسال."
  };
}

let guildRoleCache = { fetchedAt: 0, roles: [] };

async function getGuildMentionOptions(config, queryText = "") {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!DISCORD_ID_RE.test(String(guildId || ""))) {
    throw Object.assign(new Error("معرّف سيرفر Discord غير مضبوط."), { status: 503 });
  }
  if (Date.now() - guildRoleCache.fetchedAt > 60_000 || !Array.isArray(guildRoleCache.roles)) {
    const roleRows = await discordApiRequest(
      config.botToken,
      "/guilds/" + encodeURIComponent(guildId) + "/roles",
      {},
      { maxRetries: 2, maxRetryWaitMs: 5000 }
    );
    guildRoleCache = {
      fetchedAt: Date.now(),
      roles: (Array.isArray(roleRows) ? roleRows : [])
        .filter(role => DISCORD_ID_RE.test(String(role?.id || "")) && String(role.id) !== String(guildId))
        .map(role => ({
          id: String(role.id),
          name: String(role.name || "بدون اسم"),
          position: Number(role.position || 0),
          mentionable: Boolean(role.mentionable),
          managed: Boolean(role.managed),
          color: Number(role.color || 0)
        }))
        .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
    };
  }

  const query = String(queryText || "").trim().slice(0, 64);
  let members = [];
  let membersSearchAvailable = true;
  let membersSearchError = null;
  if (query.length >= 2) {
    const params = new URLSearchParams({ query, limit: "25" });
    try {
      const rows = await discordApiRequest(
        config.botToken,
        "/guilds/" + encodeURIComponent(guildId) + "/members/search?" + params.toString(),
        {},
        { maxRetries: 1, maxRetryWaitMs: 3000 }
      );
      members = (Array.isArray(rows) ? rows : [])
        .filter(member => DISCORD_ID_RE.test(String(member?.user?.id || "")))
        .map(member => ({
          id: String(member.user.id),
          username: String(member.user.username || ""),
          global_name: String(member.user.global_name || ""),
          display_name: String(member.nick || member.user.global_name || member.user.username || "عضو"),
          bot: Boolean(member.user.bot)
        }));
    } catch (error) {
      membersSearchAvailable = false;
      membersSearchError = Number(error?.status || 0) === 403
        ? "Discord لم يسمح للبوت بالبحث عن أعضاء السيرفر. فعّل GUILD_MEMBERS Privileged Intent من Developer Portal."
        : "تعذّر البحث عن الأعضاء حاليًا. رمز الخطأ: " + String(error?.code || error?.status || "unknown");
    }
  }
  return {
    roles: guildRoleCache.roles,
    members,
    members_search_available: membersSearchAvailable,
    members_search_error: membersSearchError,
    query
  };
}

export function normalizeMentionSelections(input) {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input) || input.length > 300) {
    throw Object.assign(new Error("قائمة المنشنات غير صالحة."), { status: 400 });
  }
  const selected = [];
  const keys = new Set();
  const roleIds = [];
  const userIds = [];
  const types = new Set();
  let everyoneHere = false;

  for (const entry of input) {
    const kind = String(entry?.kind || "");
    const id = String(entry?.id || "");
    if (!["everyone", "here", "role", "user", "channel"].includes(kind)) {
      throw Object.assign(new Error("نوع منشن غير مدعوم."), { status: 400 });
    }
    if (["role", "user", "channel"].includes(kind) && !DISCORD_ID_RE.test(id)) {
      throw Object.assign(new Error("معرّف منشن غير صالح."), { status: 400 });
    }
    if (kind === "everyone" || kind === "here") {
      if (everyoneHere) continue;
      everyoneHere = true;
    }
    const key = kind + ":" + id;
    if (keys.has(key)) continue;
    keys.add(key);
    if (kind === "role") roleIds.push(id);
    if (kind === "user") userIds.push(id);
    types.add(kind);
    selected.push({ kind, id });
  }

  if (roleIds.length > 100 || userIds.length > 100) {
    throw Object.assign(new Error("Discord يسمح بحد أقصى 100 رتبة و100 عضو في قائمة المنشن الواحدة."), { status: 400 });
  }
  const content = selected.map(item => {
    if (item.kind === "everyone") return "@everyone";
    if (item.kind === "here") return "@here";
    if (item.kind === "role") return "<@&" + item.id + ">";
    if (item.kind === "user") return "<@" + item.id + ">";
    return "<#" + item.id + ">";
  }).join(" ");
  if (content.length > 2000) {
    throw Object.assign(new Error("عدد المنشنات المختارة تجاوز حد محتوى رسالة Discord. قلّل عددها؛ لن يتم تقسيم الإرسال."), { status: 400 });
  }
  return {
    content,
    allowed_mentions: {
      parse: selected.some(item => item.kind === "everyone" || item.kind === "here") ? ["everyone"] : [],
      roles: roleIds,
      users: userIds,
      replied_user: false
    },
    selected,
    types: Array.from(types),
    role_count: roleIds.length,
    user_count: userIds.length,
    channel_reference_count: selected.filter(item => item.kind === "channel").length,
    includes_everyone: selected.some(item => item.kind === "everyone"),
    includes_here: selected.some(item => item.kind === "here")
  };
}

const MAX_SAVED_MESSAGE_DM_RECIPIENTS = 200;

function savedMessageHttpError(message, status = 400, code = null) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

export function selectSavedMessageDmRecipients(input, eligibleRecipients, options = {}) {
  const mode = String(input?.recipient_mode || "");
  const recipientId = String(input?.recipient_id || "");
  const recipients = (Array.isArray(eligibleRecipients) ? eligibleRecipients : [])
    .filter(item =>
      DISCORD_ID_RE.test(String(item?.discord_user_id || "")) &&
      item?.notifications_enabled === true &&
      item?.is_active === true &&
      item?.is_banned !== true
    )
    .map(item => ({
      discord_user_id: String(item.discord_user_id),
      display_name: String(item.display_name || "عضو").slice(0, 100)
    }));

  if (mode === "single") {
    if (!DISCORD_ID_RE.test(recipientId)) {
      throw savedMessageHttpError("اختر عضوًا صحيحًا لإرسال الرسالة الخاصة.", 400);
    }
    const selected = recipients.find(item => item.discord_user_id === recipientId);
    if (!selected) {
      throw savedMessageHttpError("هذا العضو غير مفعّل لاستقبال رسائل البوت أو أن حسابه غير نشط.", 403);
    }
    return [selected];
  }

  if (mode !== "all") {
    throw savedMessageHttpError("حدد مستلم الرسالة الخاصة بشكل صحيح.", 400);
  }
  if (options.dmEnabled !== true) {
    throw savedMessageHttpError("إرسال الرسائل الخاصة متوقف من إعدادات الموقع الحالية. لم يتم تغيير الإعدادات.", 403);
  }
  if (options.broadcastEnabled !== true) {
    throw savedMessageHttpError("الإرسال الجماعي للرسائل الخاصة غير مفعّل في إعدادات البوت. يمكنك اختيار عضو واحد بدلًا من ذلك.", 403);
  }
  if (!recipients.length) {
    throw savedMessageHttpError("لا يوجد أعضاء نشطون فعّلوا استقبال رسائل البوت.", 409);
  }
  if (recipients.length > MAX_SAVED_MESSAGE_DM_RECIPIENTS) {
    throw savedMessageHttpError(
      "عدد المستلمين المؤهلين هو " + recipients.length + ". الحد الآمن للإرسال من طلب واحد هو " +
      MAX_SAVED_MESSAGE_DM_RECIPIENTS + " عضوًا؛ لم يتم إرسال أي رسالة.",
      409
    );
  }
  return recipients;
}

async function getSavedMessageDmRecipientState(config) {
  const settingsQuery = new URLSearchParams({
    key: "eq.notificationMemberDmEnabled",
    select: "key,value",
    limit: "1"
  });
  const settingsResponse = await dbRequest(config, "site_settings?" + settingsQuery.toString());
  if (!settingsResponse.ok) {
    console.error("Saved message DM setting lookup failed:", settingsResponse.status, (await settingsResponse.text()).slice(0, 250));
    throw savedMessageHttpError("تعذّر التحقق من إعداد استقبال الرسائل الخاصة. لم يتم إرسال أي رسالة.", 502);
  }
  const settingsRows = await settingsResponse.json();
  const dmEnabled = settingsRows.some(row => row.key === "notificationMemberDmEnabled" && row.value === true);
  const broadcastEnabled = process.env.DISCORD_NOTIFICATIONS_BROADCAST_ENABLED === "true";

  const recipientsQuery = new URLSearchParams({
    select: "discord_user_id,display_name,notifications_enabled,is_active,is_banned",
    notifications_enabled: "eq.true",
    is_active: "eq.true",
    is_banned: "eq.false",
    order: "display_name.asc",
    limit: String(MAX_SAVED_MESSAGE_DM_RECIPIENTS + 1)
  });
  const recipientsResponse = await dbRequest(config, "staff_profiles?" + recipientsQuery.toString());
  if (!recipientsResponse.ok) {
    console.error("Saved message DM recipient lookup failed:", recipientsResponse.status, (await recipientsResponse.text()).slice(0, 250));
    throw savedMessageHttpError("تعذّر تحميل أعضاء الرسائل الخاصة المؤهلين.", 502);
  }
  const recipientRows = await recipientsResponse.json();
  const recipients = recipientRows
    .filter(row => DISCORD_ID_RE.test(String(row?.discord_user_id || "")))
    .map(row => ({
      discord_user_id: String(row.discord_user_id),
      display_name: String(row.display_name || "عضو").slice(0, 100),
      notifications_enabled: row.notifications_enabled === true,
      is_active: row.is_active === true,
      is_banned: row.is_banned === true
    }));

  return {
    dm_enabled: dmEnabled,
    broadcast_enabled: broadcastEnabled,
    max_recipients: MAX_SAVED_MESSAGE_DM_RECIPIENTS,
    recipient_count: recipients.length,
    recipients
  };
}

async function sendSavedMessageToDirectMessages(config, user, messageId, input = {}) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!DISCORD_ID_RE.test(String(guildId || ""))) {
    throw savedMessageHttpError("معرّف سيرفر Discord غير مضبوط.", 503);
  }
  const recipientState = await getSavedMessageDmRecipientState(config);
  if (recipientState.dm_enabled !== true) {
    throw savedMessageHttpError("إرسال الرسائل الخاصة متوقف من إعدادات الموقع الحالية. لم يتم تغيير الإعدادات.", 403);
  }
  const recipients = selectSavedMessageDmRecipients(input, recipientState.recipients, {
    dmEnabled: recipientState.dm_enabled,
    broadcastEnabled: recipientState.broadcast_enabled
  });
  if (!recipients.length) throw savedMessageHttpError("لم يتم العثور على مستلمين صالحين.", 409);

  const row = await loadMessage(config, messageId);
  if (Number(row.content_bytes || 0) > DISCORD_ATTACHMENT_SAFE_LIMIT) {
    throw savedMessageHttpError("النص المحفوظ أكبر من الحد الآمن لمرفق Discord واحد. لم يتم الإرسال.", 413);
  }
  const download = await storageRequest(config, "object/authenticated/" + STORAGE_BUCKET + "/" + encodeStoragePath(row.storage_path));
  if (!download.ok) {
    console.error("Saved Discord message DM content download failed:", download.status);
    throw savedMessageHttpError("تعذّر قراءة محتوى الرسالة من التخزين.", 502);
  }
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength > DISCORD_ATTACHMENT_SAFE_LIMIT) {
    throw savedMessageHttpError("النص أكبر من الحد الآمن لمرفق Discord واحد. لم يتم الإرسال.", 413);
  }
  const fullText = new TextDecoder("utf-8", { fatal:false }).decode(bytes);
  const formatted = buildDiscordMessageContent({ title:row.title, content:fullText });
  let messageContent = formatted.content;
  let useAttachment = formatted.useAttachment;
  if (messageContent.length > DISCORD_MESSAGE_CONTENT_LIMIT) useAttachment = true;
  if (useAttachment) {
    messageContent = formatted.title
      ? "# " + formatted.title + "\n\n📎 **المحتوى الكامل مرفق في ملف نصي واحد.**"
      : "📎 **المحتوى الكامل مرفق في ملف نصي واحد.**";
  }
  if (messageContent.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
    throw savedMessageHttpError("تعذّر تجهيز الرسالة داخل حد Discord البالغ 2000 حرف.", 400);
  }

  const basePayload = {
    content: messageContent,
    allowed_mentions: { parse: [] },
    ...(Array.isArray(row.link_buttons) && row.link_buttons.length
      ? { components: buildDiscordLinkComponents(row.link_buttons) }
      : {})
  };
  let nextIndex = 0;
  let sent = 0;
  let failed = 0;
  const failureReasons = {};
  const deliveryResults = new Array(recipients.length);

  async function deliver(recipient, index) {
    let status = "failed";
    let errorCode = null;
    try {
      const dm = await discordApiRequest(config.botToken, "/users/@me/channels", {
        method: "POST",
        body: JSON.stringify({ recipient_id: recipient.discord_user_id })
      }, { maxRetries:2, maxRetryWaitMs:5000 });
      if (!dm?.id) throw savedMessageHttpError("تعذّر فتح محادثة Discord الخاصة.", 502, "dm_channel_missing");

      let payload = basePayload;
      if (useAttachment) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(basePayload));
        form.append("files[0]", new Blob([formatted.fileContent], { type:"text/plain;charset=utf-8" }), formatted.filename);
        payload = form;
      }
      await discordApiRequest(config.botToken, "/channels/" + encodeURIComponent(dm.id) + "/messages", {
        method: "POST",
        body: payload instanceof FormData ? payload : JSON.stringify(payload)
      }, { maxRetries:2, maxRetryWaitMs:5000 });
      status = "sent";
      sent += 1;
    } catch (error) {
      errorCode = String(error?.code || error?.status || "delivery_failed").slice(0, 80);
      failed += 1;
      failureReasons[errorCode] = (failureReasons[errorCode] || 0) + 1;
    }
    deliveryResults[index] = { discord_user_id:recipient.discord_user_id, display_name:recipient.display_name, status, error_code:errorCode };
  }

  const workerCount = Math.min(4, recipients.length);
  await Promise.all(Array.from({ length:workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= recipients.length) return;
      await deliver(recipients[index], index);
    }
  }));

  const actor = String(user.displayName || user.username || "S.W.A.T. Admin").slice(0, 100);
  try {
    await dbRequest(config, "discord_saved_messages?id=eq." + encodeURIComponent(messageId), {
      method:"PATCH",
      headers:{"Content-Type":"application/json",Prefer:"return=minimal"},
      body:JSON.stringify({
        last_sent_at:new Date().toISOString(),
        send_count:Number(row.send_count || 0) + 1
      })
    });
    await appendSavedMessageAudit(config,user,{
      action:"create",
      entity_type:"discord_saved_message_dm_delivery",
      entity_id:messageId,
      details:{
        type:"إرسال رسالة محفوظة إلى الرسائل الخاصة",
        detail:actor+" أرسل الرسالة «"+String(row.title || "بدون عنوان").slice(0,160)+"» في الرسائل الخاصة إلى "+recipients.length+" عضوًا؛ نجح "+sent+" وفشل "+failed+".",
        recipient_mode:String(input.recipient_mode || ""),
        recipient_count:recipients.length,
        sent_count:sent,
        failed_count:failed,
        attached_text_file:useAttachment,
        content_chars:Number(row.content_chars || 0),
        content_bytes:bytes.byteLength,
        link_button_count:Array.isArray(row.link_buttons)?row.link_buttons.length:0,
        failure_reasons:failureReasons
      }
    });
  } catch(error) {
    console.warn("Saved message DM audit update failed:", error?.message || "unknown");
  }

  return {
    ok:true,
    delivery:"dm",
    total:recipients.length,
    sent,
    failed,
    single_message:true,
    attached_text_file:useAttachment,
    max_recipients:MAX_SAVED_MESSAGE_DM_RECIPIENTS,
    failure_reasons:failureReasons,
    recipients:deliveryResults.map(item => ({ display_name:item.display_name,status:item.status,error_code:item.error_code }))
  };
}

async function sendSavedMessage(config, user, messageId, channelId, mentionSelections = []) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const row = await loadMessage(config, messageId);
  const channel = await discordApiRequest(config.botToken, "/channels/" + encodeURIComponent(channelId), {}, { maxRetries:2,maxRetryWaitMs:4000 });
  if (String(channel?.guild_id || "") !== String(guildId)) throw Object.assign(new Error("القناة المحددة ليست ضمن سيرفر S.W.A.T."), { status:400 });
  const type = Number(channel.type);
  if (type === 4) throw Object.assign(new Error("اختر قناة داخل التصنيف، وليس التصنيف نفسه."), { status:400 });
  if (Number(row.content_bytes || 0) > DISCORD_ATTACHMENT_SAFE_LIMIT) {
    throw Object.assign(new Error("النص محفوظ، لكن حجمه يتجاوز الحد الآمن لملف Discord واحد. لم يتم تقسيمه ولم تُرسل أي رسالة."), { status:413 });
  }
  const download = await storageRequest(config, "object/authenticated/" + STORAGE_BUCKET + "/" + encodeStoragePath(row.storage_path));
  if (!download.ok) {
    console.error("Saved Discord message file download failed:", download.status);
    throw Object.assign(new Error("تعذّر قراءة محتوى الرسالة من التخزين."), { status:502 });
  }
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength > DISCORD_ATTACHMENT_SAFE_LIMIT) throw Object.assign(new Error("النص أكبر من الحد الآمن لملف Discord واحد. لم يتم الإرسال."), { status:413 });
  const text = new TextDecoder("utf-8",{fatal:false}).decode(bytes);
  const formatted = buildDiscordMessageContent({ title:row.title, content:text });
  const mentions = normalizeMentionSelections(mentionSelections);
  const mentionPrefix = mentions.content ? mentions.content + "\n\n" : "";
  let messageContent = mentionPrefix + formatted.content;
  let useAttachment = formatted.useAttachment;
  if (messageContent.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
    useAttachment = true;
    const attachmentNotice = formatted.title
      ? "# " + formatted.title + "\n\n📎 **المحتوى الكامل مرفق في ملف نصي واحد.**"
      : "📎 **المحتوى الكامل مرفق في ملف نصي واحد.**";
    messageContent = mentionPrefix + attachmentNotice;
    if (messageContent.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
      messageContent = mentions.content;
    }
  }
  if (messageContent.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
    throw Object.assign(new Error("المنشنات المختارة وحدها تجاوزت حد Discord البالغ 2000 حرف."), { status: 400 });
  }
  const message = {
    content: messageContent,
    allowed_mentions:mentions.allowed_mentions,
    ...(Array.isArray(row.link_buttons) && row.link_buttons.length
      ? { components: buildDiscordLinkComponents(row.link_buttons) }
      : {})
  };
  const forum = type === 15 || type === 16;
  if (forum && !String(row.title || "").trim()) {
    throw Object.assign(new Error("قنوات المنتدى في Discord تتطلب عنوانًا للموضوع. أضف عنوانًا أو اختر قناة نصية عادية لإرسال الرسالة بدون عنوان."), { status:400 });
  }
  const endpoint = forum ? "/channels/" + encodeURIComponent(channelId) + "/threads" : "/channels/" + encodeURIComponent(channelId) + "/messages";
  let payload = forum ? { name:String(row.title).slice(0,100), auto_archive_duration:1440, message } : message;
  if (useAttachment) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([formatted.fileContent],{type:"text/plain;charset=utf-8"}), formatted.filename);
    payload = form;
  }
  let sent;
  try {
    sent = await discordApiRequest(config.botToken, endpoint, {
      method:"POST", body:payload instanceof FormData ? payload : JSON.stringify(payload)
    }, {maxRetries:2,maxRetryWaitMs:5000});
  } catch (error) {
    const status = Number(error?.status || 0);
    const needsMentionPermission = mentions.includes_everyone || mentions.includes_here || mentions.role_count > 0;
    const messageText = status === 403
      ? needsMentionPermission
        ? "البوت لا يملك الصلاحية المطلوبة لإرسال الرسالة أو تنفيذ المنشن المختار. راجع Send Messages، وصلاحية Mention Everyone للرتب غير القابلة للمنشن أو @everyone و@here."
        : "البوت لا يملك صلاحية View Channel وSend Messages في القناة المحددة."
      : status === 404
        ? "القناة غير موجودة أو لم يعد البوت يستطيع الوصول إليها."
        : status === 400
          ? "Discord رفض الرسالة أو أحد المنشنات. تأكد أن الرتبة قابلة للمنشن أو أن البوت يملك Mention Everyone، وأن القناة تسمح بالنشر."
          : status === 429
            ? "Discord فرض انتظارًا مؤقتًا بسبب كثرة الطلبات. حاول مرة أخرى بعد انتهاء المهلة."
            : "فشل الإرسال إلى Discord. رمز الخطأ: " + String(error?.code || status || "unknown");
    throw Object.assign(new Error(messageText), { status:502, code:error?.code || status || null });
  }
  const sentMessageId = String(sent?.message?.id || sent?.id || "");
  const sentChannelId = String(sent?.channel_id || (forum ? sent?.id : "") || channelId);
  const actor = String(user.displayName || user.username || "S.W.A.T. Admin").slice(0,100);
  try {
    await dbRequest(config, "discord_saved_messages?id=eq." + encodeURIComponent(messageId), {
      method:"PATCH", headers:{"Content-Type":"application/json",Prefer:"return=minimal"},
      body:JSON.stringify({
        last_sent_at:new Date().toISOString(),last_sent_channel_id:channelId,last_sent_message_id:sentMessageId || null,
        send_count:Number(row.send_count || 0)+1
      })
    });
    await appendSavedMessageAudit(config,user,{
      action:"create",entity_type:"discord_saved_message_delivery",entity_id:messageId,
      details:{
        type:"إرسال رسالة محفوظة إلى Discord",
        detail:actor+" أرسل الرسالة «"+String(row.title || "").slice(0,160)+"» في #"+String(channel.name || "قناة")+".",
        channel_id:channelId,channel_name:channel.name || null,discord_message_id:sentMessageId || null,
        attached_text_file:useAttachment,content_chars:Number(row.content_chars || 0),content_bytes:bytes.byteLength,
        link_button_count:Array.isArray(row.link_buttons)?row.link_buttons.length:0,
        selected_mention_types:mentions.types,role_mention_count:mentions.role_count,user_mention_count:mentions.user_count,
        channel_reference_count:mentions.channel_reference_count,everyone_mention:mentions.includes_everyone,here_mention:mentions.includes_here
      }
    });
  } catch(error) { console.warn("Saved message audit update failed:",error?.message || "unknown"); }
  return {
    ok:true,channel_id:channelId,channel_name:String(channel.name || ""),message_id:sentMessageId || null,
    message_url:sentMessageId ? "https://discord.com/channels/"+guildId+"/"+sentChannelId+"/"+sentMessageId : null,
    single_message:true,attached_text_file:useAttachment,
    link_button_count:Array.isArray(row.link_buttons)?row.link_buttons.length:0,
    mention_summary:{role_count:mentions.role_count,user_count:mentions.user_count,channel_reference_count:mentions.channel_reference_count,everyone:mentions.includes_everyone,here:mentions.includes_here}
  };
}

export async function handleSavedDiscordMessageRequest(req,res,user,config,action,body={}) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const isRead = req.method === "GET";
  try {
    if (isRead && action === "saved_message_channels") {
      return res.status(200).json({ok:true,...await listChannels(config)});
    }
    if (isRead && action === "saved_message_mentions") {
      const query = new URL(req.url,"https://swat-redline.vercel.app").searchParams.get("q") || "";
      return res.status(200).json({ok:true,...await getGuildMentionOptions(config,query)});
    }
    if (isRead && action === "saved_message_dm_recipients") {
      const state = await getSavedMessageDmRecipientState(config);
      return res.status(200).json({
        ok:true,
        dm_enabled:state.dm_enabled,
        broadcast_enabled:state.broadcast_enabled,
        max_recipients:state.max_recipients,
        recipient_count:state.recipient_count,
        recipients:state.recipients.map(item => ({
          discord_user_id:item.discord_user_id,
          display_name:item.display_name
        }))
      });
    }
    if (isRead && action === "saved_message_content") {
      const id = String(new URL(req.url,"https://swat-redline.vercel.app").searchParams.get("id") || "");
      if (!UUID_RE.test(id)) return res.status(400).json({error:"معرّف الرسالة غير صالح."});
      const row = await loadMessage(config,id);
      return res.status(200).json({ok:true,id,title:row.title,signed_url:await createSignedDownload(config,row.storage_path)});
    }
    if (isRead && action === "saved_message_list") {
      const query = new URLSearchParams({
        select:"id,title,content_preview,content_chars,content_bytes,created_by_name,created_at,updated_at,last_sent_at,last_sent_channel_id,send_count,link_buttons",
        order:"created_at.desc",limit:"250"
      });
      const response = await dbRequest(config,"discord_saved_messages?"+query.toString());
      if (!response.ok) {
        console.error("Saved message list failed:",response.status,(await response.text()).slice(0,250));
        return res.status(502).json({error:"تعذّر تحميل الرسائل المحفوظة."});
      }
      return res.status(200).json({ok:true,messages:(await response.json()).map(normalizeRow)});
    }
    if (!isRead && action === "saved_message_upload_url") {
      return res.status(200).json({ok:true,...await createSignedUpload(config)});
    }
    if (!isRead && action === "saved_message_discard_upload") {
      const path = String(body.storage_path || "");
      if (!/^messages\/[0-9a-f-]{36}\.txt$/i.test(path)) return res.status(400).json({error:"مسار الملف غير صالح."});
      return res.status(200).json({ok:true,removed:await removeStoredContent(config,path)});
    }
    if (!isRead && action === "saved_message_save") {
      const id = body.id ? String(body.id) : "";
      const title = toWellFormedUnicode(String(body.title || "").trim());
      const path = String(body.storage_path || "");
      const preview = truncateUnicode(body.content_preview || "", 600);
      const chars = Number(body.content_chars), bytes = Number(body.content_bytes);
      if ((id && !UUID_RE.test(id)) || title.length>256 || !/^messages\/[0-9a-f-]{36}\.txt$/i.test(path) ||
          !Number.isSafeInteger(chars) || chars<0 || !Number.isSafeInteger(bytes) || bytes<0) {
        return res.status(400).json({error:"تأكد من صحة بيانات الرسالة واكتمال رفع محتواها قبل الحفظ."});
      }
      if (id) {
        const old = await loadMessage(config,id);
        const response = await dbRequest(config,"discord_saved_messages?id=eq."+encodeURIComponent(id),{
          method:"PATCH",headers:{"Content-Type":"application/json",Prefer:"return=representation"},
          body:JSON.stringify({title,storage_path:path,content_preview:preview,content_chars:chars,content_bytes:bytes,updated_at:new Date().toISOString()})
        });
        if (!response.ok) {
          console.error("Saved message update failed:",response.status,(await response.text()).slice(0,250));
          return res.status(502).json({error:"تعذّر حفظ تعديلات الرسالة."});
        }
        await removeStoredContent(config,old.storage_path);
        const rows=await response.json();
        await appendSavedMessageAudit(config,user,{
          action:"update",entity_type:"discord_saved_message",entity_id:id,
          details:{type:"تعديل قالب رسالة محفوظة",detail:"تم تعديل قالب الرسالة «"+title.slice(0,160)+"».",content_chars:chars,content_bytes:bytes}
        });
        return res.status(200).json({ok:true,message:normalizeRow(rows[0])});
      }
      const response = await dbRequest(config,"discord_saved_messages",{
        method:"POST",
        headers:{"Content-Type":"application/json",Prefer:"return=representation"},
        body:JSON.stringify({
          title,storage_path:path,content_preview:preview,content_chars:chars,content_bytes:bytes,
          created_by_discord_id:user.id,created_by_name:truncateUnicode(user.displayName || user.username || "S.W.A.T. Admin", 100)
        })
      });
      if (!response.ok) {
        console.error("Saved message insert failed:",response.status,(await response.text()).slice(0,250));
        return res.status(502).json({error:"تعذّر حفظ الرسالة الجديدة."});
      }
      const rows=await response.json();
      await appendSavedMessageAudit(config,user,{
        action:"create",entity_type:"discord_saved_message",entity_id:rows[0]?.id||null,
        details:{type:"إنشاء قالب رسالة محفوظة",detail:"تم إنشاء قالب رسالة محفوظة «"+title.slice(0,160)+"».",content_chars:chars,content_bytes:bytes}
      });
      return res.status(201).json({ok:true,message:normalizeRow(rows[0])});
    }
    if (!isRead && action === "saved_message_update_link_buttons") {
      const id = String(body.id || "");
      if (!UUID_RE.test(id)) return res.status(400).json({error:"معرّف الرسالة غير صالح."});
      const linkButtons = normalizeDiscordLinkButtons(body.link_buttons);
      const response = await dbRequest(config,"discord_saved_messages?id=eq."+encodeURIComponent(id),{
        method:"PATCH",
        headers:{"Content-Type":"application/json",Prefer:"return=representation"},
        body:JSON.stringify({link_buttons:linkButtons,updated_at:new Date().toISOString()})
      });
      if (!response.ok) {
        console.error("Saved Discord link buttons update failed:",response.status,(await response.text()).slice(0,250));
        return res.status(502).json({error:"تعذّر حفظ أزرار الروابط."});
      }
      const rows = await response.json();
      if (!rows[0]) return res.status(404).json({error:"قالب الرسالة غير موجود."});
      await appendSavedMessageAudit(config,user,{
        action:"update",entity_type:"discord_saved_message_links",entity_id:id,
        details:{type:"تعديل أزرار روابط رسالة محفوظة",detail:"تم تحديث أزرار الروابط في قالب «"+String(rows[0].title||"بدون عنوان").slice(0,160)+"».",link_button_count:linkButtons.length,link_labels:linkButtons.map(item=>item.label)}
      });
      return res.status(200).json({ok:true,message:normalizeRow(rows[0])});
    }
    if (!isRead && action === "saved_message_delete") {
      const id=String(body.id || "");
      if (!UUID_RE.test(id)) return res.status(400).json({error:"معرّف الرسالة غير صالح."});
      const row=await loadMessage(config,id);
      const response=await dbRequest(config,"discord_saved_messages?id=eq."+encodeURIComponent(id),{method:"DELETE"});
      if (!response.ok) {
        console.error("Saved message delete failed:",response.status,(await response.text()).slice(0,250));
        return res.status(502).json({error:"تعذّر حذف الرسالة من السجل."});
      }
      await removeStoredContent(config,row.storage_path);
      await appendSavedMessageAudit(config,user,{
        action:"delete",entity_type:"discord_saved_message",entity_id:id,
        details:{type:"حذف قالب رسالة محفوظة",detail:"تم حذف قالب الرسالة «"+String(row.title||"بدون عنوان").slice(0,160)+"» من الموقع."}
      });
      return res.status(200).json({ok:true});
    }
    if (!isRead && action === "saved_message_send") {
      const id=String(body.id || ""), channelId=String(body.channel_id || "");
      if (!UUID_RE.test(id) || !DISCORD_ID_RE.test(channelId)) return res.status(400).json({error:"اختر رسالة وقناة صحيحتين."});
      if (!DISCORD_ID_RE.test(String(guildId || ""))) return res.status(503).json({error:"معرّف سيرفر Discord غير مضبوط."});
      return res.status(200).json(await sendSavedMessage(config,user,id,channelId,body.mentions));
    }
    if (!isRead && action === "saved_message_send_dm") {
      const id=String(body.id || "");
      if (!UUID_RE.test(id)) return res.status(400).json({error:"معرّف الرسالة غير صالح."});
      if (!DISCORD_ID_RE.test(String(guildId || ""))) return res.status(503).json({error:"معرّف سيرفر Discord غير مضبوط."});
      return res.status(200).json(await sendSavedMessageToDirectMessages(config,user,id,{
        recipient_mode:body.recipient_mode,
        recipient_id:body.recipient_id
      }));
    }
    return res.status(400).json({error:"عملية الرسائل المحفوظة غير معروفة."});
  } catch(error) {
    console.error("Saved Discord message action failed:",error?.message || "unknown");
    return res.status(error.status || 500).json({error:error.message || "تعذّر تنفيذ العملية.",code:error.code || null});
  }
}
