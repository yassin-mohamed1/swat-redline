import crypto from "node:crypto";
import { discordApiRequest } from "./discord-rest.js";
import { buildDiscordMessageEmbed, DISCORD_ATTACHMENT_SAFE_LIMIT } from "./discord-message-format.js";

const STORAGE_BUCKET = "swat-discord-messages";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_ID_RE = /^\d{15,22}$/;

function dbRequest(config, path, options = {}) {
  return fetch(config.base + "/rest/v1/" + path, {
    ...options,
    headers: { apikey: config.serviceKey, Authorization: "Bearer " + config.serviceKey, ...(options.headers || {}) }
  });
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
function normalizeRow(row) {
  return {
    id: String(row.id), title: String(row.title || ""), content_preview: String(row.content_preview || ""),
    content_chars: Number(row.content_chars || 0), content_bytes: Number(row.content_bytes || 0),
    created_by_name: String(row.created_by_name || ""), created_at: row.created_at || null,
    updated_at: row.updated_at || null, last_sent_at: row.last_sent_at || null,
    last_sent_channel_id: row.last_sent_channel_id || null, send_count: Number(row.send_count || 0)
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
  if (!Array.isArray(input) || input.length > 200) {
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
  const formatted = buildDiscordMessageEmbed({ title:row.title, content:text });
  const mentions = normalizeMentionSelections(mentionSelections);
  const message = {
    ...(mentions.content ? { content: mentions.content } : {}),
    embeds:[formatted.embed],
    allowed_mentions:mentions.allowed_mentions
  };
  const forum = type === 15 || type === 16;
  const endpoint = forum ? "/channels/" + encodeURIComponent(channelId) + "/threads" : "/channels/" + encodeURIComponent(channelId) + "/messages";
  let payload = forum ? { name:String(row.title || "رسالة S.W.A.T.").slice(0,100), auto_archive_duration:1440, message } : message;
  if (formatted.useAttachment) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", new Blob([bytes],{type:"text/plain;charset=utf-8"}), formatted.filename);
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
    await dbRequest(config,"audit_logs",{
      method:"POST",headers:{"Content-Type":"application/json",Prefer:"return=minimal"},
      body:JSON.stringify({
        actor_discord_id:user.id,actor_name:actor,action:"create",entity_type:"discord_saved_message_delivery",entity_id:messageId,
        details:{
          type:"إرسال رسالة محفوظة إلى Discord",
          detail:actor+" أرسل الرسالة «"+String(row.title || "").slice(0,160)+"» في #"+String(channel.name || "قناة")+".",
          channel_id:channelId,channel_name:channel.name || null,discord_message_id:sentMessageId || null,
          attached_text_file:formatted.useAttachment,content_chars:Number(row.content_chars || 0),content_bytes:bytes.byteLength,
          selected_mention_types:mentions.types,role_mention_count:mentions.role_count,user_mention_count:mentions.user_count,
          channel_reference_count:mentions.channel_reference_count,everyone_mention:mentions.includes_everyone,here_mention:mentions.includes_here
        }
      })
    });
  } catch(error) { console.warn("Saved message audit update failed:",error?.message || "unknown"); }
  return {
    ok:true,channel_id:channelId,channel_name:String(channel.name || ""),message_id:sentMessageId || null,
    message_url:sentMessageId ? "https://discord.com/channels/"+guildId+"/"+sentChannelId+"/"+sentMessageId : null,
    single_message:true,attached_text_file:formatted.useAttachment,
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
    if (isRead && action === "saved_message_content") {
      const id = String(new URL(req.url,"https://swat-redline.vercel.app").searchParams.get("id") || "");
      if (!UUID_RE.test(id)) return res.status(400).json({error:"معرّف الرسالة غير صالح."});
      const row = await loadMessage(config,id);
      return res.status(200).json({ok:true,id,title:row.title,signed_url:await createSignedDownload(config,row.storage_path)});
    }
    if (isRead && action === "saved_message_list") {
      const query = new URLSearchParams({
        select:"id,title,content_preview,content_chars,content_bytes,created_by_name,created_at,updated_at,last_sent_at,last_sent_channel_id,send_count",
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
      const title = String(body.title || "").trim();
      const path = String(body.storage_path || "");
      const preview = String(body.content_preview || "").slice(0,600);
      const chars = Number(body.content_chars), bytes = Number(body.content_bytes);
      if ((id && !UUID_RE.test(id)) || !title || title.length>256 || !/^messages\/[0-9a-f-]{36}\.txt$/i.test(path) ||
          !Number.isSafeInteger(chars) || chars<0 || !Number.isSafeInteger(bytes) || bytes<0) {
        return res.status(400).json({error:"تأكد من اسم الرسالة ورفع المحتوى كاملًا قبل الحفظ."});
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
        return res.status(200).json({ok:true,message:normalizeRow(rows[0])});
      }
      const response=await dbRequest(config,"discord_saved_messages",{
        method:"POST",headers:{"Content-Type":"application/json",Prefer:"return=representation"},
        body:JSON.stringify({
          title,storage_path:path,content_preview:preview,content_chars:chars,content_bytes:bytes,
          created_by_discord_id:user.id,created_by_name:String(user.displayName || user.username || "S.W.A.T. Admin").slice(0,100)
        })
      });
      if (!response.ok) {
        console.error("Saved message insert failed:",response.status,(await response.text()).slice(0,250));
        return res.status(502).json({error:"تعذّر حفظ الرسالة الجديدة."});
      }
      const rows=await response.json();
      return res.status(201).json({ok:true,message:normalizeRow(rows[0])});
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
      return res.status(200).json({ok:true});
    }
    if (!isRead && action === "saved_message_send") {
      const id=String(body.id || ""), channelId=String(body.channel_id || "");
      if (!UUID_RE.test(id) || !DISCORD_ID_RE.test(channelId)) return res.status(400).json({error:"اختر رسالة وقناة صحيحتين."});
      if (!DISCORD_ID_RE.test(String(guildId || ""))) return res.status(503).json({error:"معرّف سيرفر Discord غير مضبوط."});
      return res.status(200).json(await sendSavedMessage(config,user,id,channelId,body.mentions));
    }
    return res.status(400).json({error:"عملية الرسائل المحفوظة غير معروفة."});
  } catch(error) {
    console.error("Saved Discord message action failed:",error?.message || "unknown");
    return res.status(error.status || 500).json({error:error.message || "تعذّر تنفيذ العملية.",code:error.code || null});
  }
}
