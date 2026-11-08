import crypto from "node:crypto";
import { requireSameOrigin } from "../lib/request-security.js";

const DISCORD_API = "https://discord.com/api/v10";
const RANKS = [
  { key: "swatcommander", aliases: ["swatcommender"], label: "S.W.A.T COMMANDER" },
  { key: "deputyswatcommander", label: "DEPUTY S.W.A.T COMMANDER" },
  { key: "swatteamleader", label: "S.W.A.T TEAM LEADER" },
  { key: "swatsupervisor", label: "S.W.A.T SUPERVISOR" },
  { key: "swatsenioroperator", label: "S.W.A.T SENIOR OPERATOR" },
  { key: "swatoperator", label: "S.W.A.T OPERATOR" },
  { key: "swatrecruit", label: "S.W.A.T RECRUIT" }
];

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function session(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), signature = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 || (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { id: user.id, username: user.username || "Discord user", displayName: user.displayName || user.username || "Discord user", isOwner };
}
function config() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!base || !key || !token || !/^\d{15,22}$/.test(String(guildId || ""))) {
    return { error: "لم يتم إعداد ربط Discord وقاعدة البيانات للتعيينات." };
  }
  return { base, key, token, guildId };
}
function send(res, status, body) { return res.status(status).json(body); }
async function db(cfg, path, init = {}) {
  return fetch(cfg.base + "/rest/v1/" + path, { ...init, headers: {
    apikey: cfg.key, Authorization: "Bearer " + cfg.key,
    "Content-Type": "application/json", ...(init.headers || {})
  }});
}
async function rpc(cfg, name, body) {
  const response = await db(cfg, "rpc/" + name, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error("تعذّر حفظ سجل التعيين في قاعدة البيانات.");
    error.detail = detail;
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function discord(cfg, path, init = {}) {
  const response = await fetch(DISCORD_API + path, { ...init, headers: {
    Authorization: "Bot " + cfg.token,
    "Content-Type": "application/json",
    ...(init.headers || {})
  }});
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error("فشل طلب Discord (رمز الخطأ: " + String(data.code || response.status) + ").");
    error.status = response.status;
    error.code = String(data.code || response.status);
    throw error;
  }
  return data;
}
function rankKey(roleName) {
  const normalized = String(roleName || "").normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9]/g, "").replace(/^\d+/, "");
  const match = RANKS.find(rank => rank.key === normalized || (rank.aliases || []).includes(normalized));
  return match?.key || null;
}
function rankList(roles, botTopPosition) {
  return roles
    .map(role => {
      const key = rankKey(role.name);
      if (!key) return null;
      const definition = RANKS.find(item => item.key === key);
      return {
        id: role.id,
        name: role.name,
        label: definition.label,
        position: Number(role.position || 0),
        managed: Boolean(role.managed),
        assignable: !role.managed && Number(role.position || 0) < botTopPosition
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.position - a.position);
}
function avatarUrl(member, guildId) {
  const user = member?.user || {};
  const id = String(user.id || "");
  const valid = value => typeof value === "string" && /^[a-zA-Z0-9_]+$/.test(value);
  if (valid(member?.avatar) && /^\d{15,22}$/.test(id)) {
    const ext = member.avatar.startsWith("a_") ? "gif" : "png";
    return "https://cdn.discordapp.com/guilds/" + guildId + "/users/" + id + "/avatars/" + member.avatar + "." + ext + "?size=128";
  }
  if (valid(user.avatar) && /^\d{15,22}$/.test(id)) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return "https://cdn.discordapp.com/avatars/" + id + "/" + user.avatar + "." + ext + "?size=128";
  }
  if (/^\d{15,22}$/.test(id)) {
    return "https://cdn.discordapp.com/embed/avatars/" + Number((BigInt(id) >> 22n) % 6n) + ".png";
  }
  return null;
}
function memberName(member, fallback = "Discord user") {
  return member?.nick || member?.user?.global_name || member?.user?.username || fallback;
}
async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}
function portalComponents() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.SITE_URL || "swat-redline.vercel.app";
  const url = /^https?:\/\//i.test(host) ? host : "https://" + host;
  return [{ type: 1, components: [{
    type: 2, style: 5, label: "فتح بوابة S.W.A.T. REDLINE", url
  }] }];
}
function appointmentEmbed({ assigned, name, discordId, avatar, rankName, callsign, actor, reference }) {
  return {
    color: assigned ? 0xD92735 : 0x737B87,
    author: { name: "S.W.A.T. REDLINE • PERSONNEL COMMAND" },
    title: assigned ? "🎖️ OFFICIAL APPOINTMENT" : "📋 APPOINTMENT ENDED",
    description: assigned
      ? "تم اعتماد تعيينك الجديد في S.W.A.T. REDLINE من خلال بوابة القيادة."
      : "تم إنهاء تعيينك الحالي في S.W.A.T. REDLINE وإزالة رتبة التعيين من حسابك.",
    ...(avatar ? { thumbnail: { url: avatar } } : {}),
    fields: [
      { name: "العضو", value: String(name || "Discord member").slice(0, 180), inline: true },
      { name: "Discord ID", value: discordId, inline: true },
      { name: "الرتبة", value: assigned ? String(rankName).slice(0, 100) : "تم إنهاء التعيين", inline: true },
      { name: "كود النداء", value: assigned ? (callsign || "لم يتم تعيين كود نداء") : "تم إلغاء كود النداء السابق", inline: true },
      { name: "صدر بواسطة", value: String(actor || "S.W.A.T. REDLINE Command").slice(0, 120), inline: true },
      { name: "الرقم المرجعي", value: reference, inline: false }
    ],
    footer: { text: "S.W.A.T. REDLINE • PERSONNEL & APPOINTMENTS" },
    timestamp: new Date().toISOString()
  };
}
async function sendAppointmentDm(cfg, targetId, embed) {
  const dm = await discord(cfg, "/users/@me/channels", {
    method: "POST", body: JSON.stringify({ recipient_id: targetId })
  });
  if (!dm?.id) throw Object.assign(new Error("تعذّر فتح محادثة خاصة مع العضو."), { status: 502, code: "dm_channel_missing" });
  const message = await discord(cfg, "/channels/" + dm.id + "/messages", {
    method: "POST",
    body: JSON.stringify({ embeds: [embed], components: portalComponents(), allowed_mentions: { parse: [] } })
  });
  if (!message?.id) throw Object.assign(new Error("لم يؤكد Discord إرسال رسالة التعيين."), { status: 502, code: "dm_message_missing" });
  return { channelId: dm.id, messageId: message.id };
}
async function deleteDm(cfg, dm) {
  if (!dm?.channelId || !dm?.messageId) return;
  await discord(cfg, "/channels/" + dm.channelId + "/messages/" + dm.messageId, { method: "DELETE" });
}
async function loadGuildContext(cfg) {
  const [roles, botUser] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/roles"),
    discord(cfg, "/users/@me")
  ]);
  const botMember = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + botUser.id);
  const byId = new Map(roles.map(role => [role.id, role]));
  const botTop = (botMember.roles || []).map(id => byId.get(id)).filter(Boolean)
    .reduce((top, role) => !top || Number(role.position) > Number(top.position) ? role : top, null);
  if (!botTop) throw Object.assign(new Error("تعذّر تحديد أعلى رتبة للبوت في السيرفر."), { status: 503 });
  const botPermissions = (botMember.roles || []).map(id => byId.get(id)).filter(Boolean)
    .reduce((value, role) => value | BigInt(role.permissions || "0"), 0n);
  const canManageRoles = (botPermissions & (1n << 28n)) !== 0n || (botPermissions & (1n << 3n)) !== 0n;
  return { roles, byId, botTop, canManageRoles, botUser };
}
async function loadRegisteredMembers(cfg) {
  const [profilesResponse, assignmentsResponse] = await Promise.all([
    db(cfg, "staff_profiles?select=discord_user_id,display_name,username,avatar_url,is_active,is_banned,created_at&order=display_name.asc"),
    db(cfg, "staff_assignments?select=discord_user_id,rank_role_id,rank_role_name,callsign,status,assigned_by_name,updated_at")
  ]);
  if (!profilesResponse.ok) throw new Error("تعذّر تحميل أعضاء الموقع المسجلين.");
  if (!assignmentsResponse.ok) throw new Error("تعذّر تحميل سجل التعيينات.");
  const profiles = await profilesResponse.json();
  const assignments = await assignmentsResponse.json();
  const byAssignment = new Map(assignments.map(item => [String(item.discord_user_id), item]));
  return profiles.map(profile => ({ ...profile, assignment: byAssignment.get(String(profile.discord_user_id)) || null }));
}
async function fetchDiscordMember(cfg, id) {
  try {
    const member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + id);
    return { inGuild: true, roles: member.roles || [], name: memberName(member), avatarUrl: avatarUrl(member, cfg.guildId) };
  } catch (error) {
    if (error.status === 404) return { inGuild: false, roles: [], name: null, avatarUrl: null };
    throw error;
  }
}
function validateCallsign(value) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(/^(?:Alpha\s*)?(0|[1-9][0-9]{0,39})$/i);
  if (!match) throw Object.assign(new Error("كود النداء يجب أن يكون Alpha متبوعًا برقم صحيح يبدأ من 0."), { status: 400 });
  return "Alpha " + match[1];
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req);
  if (!user) return send(res, 401, { error: "يجب تسجيل الدخول أولًا." });
  if (!user.isOwner) return send(res, 403, { error: "إدارة التعيينات متاحة للمالك فقط." });
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "طريقة الطلب غير مسموح بها." });
  }
  if (req.method === "POST" && !requireSameOrigin(req, res)) return;
  const cfg = config();
  if (cfg.error) return send(res, 503, { error: cfg.error });

  try {
    if (req.method === "GET") {
      const [members, guild] = await Promise.all([loadRegisteredMembers(cfg), loadGuildContext(cfg)]);
      const recognizedRoles = rankList(guild.roles, Number(guild.botTop.position));
      const memberRows = await mapLimit(members, 5, async item => {
        const live = await fetchDiscordMember(cfg, item.discord_user_id);
        const currentRanks = recognizedRoles.filter(role => live.roles.includes(role.id));
        return {
          ...item,
          live_name: live.name,
          avatar_url: live.avatarUrl || item.avatar_url || null,
          in_guild: live.inGuild,
          current_roles: live.roles,
          current_rank_roles: currentRanks,
          account_status: item.is_banned ? "banned" : item.is_active === false ? "inactive" : "active"
        };
      });
      return send(res, 200, {
        members: memberRows,
        roles: recognizedRoles,
        bot: { can_manage_roles: guild.canManageRoles, top_role: guild.botTop.name },
        callsign_presets: Array.from({ length: 16 }, (_, index) => "Alpha " + index)
      });
    }

    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const targetId = String(body.discord_user_id || "");
    const action = body.action === "remove" ? "remove" : body.action === "assign" ? "assign" : "";
    if (!action || !/^\d{15,22}$/.test(targetId)) {
      return send(res, 400, { error: "اختر عضوًا وإجراءً صحيحًا." });
    }

    const profileResponse = await db(cfg, "staff_profiles?discord_user_id=eq." + encodeURIComponent(targetId) +
      "&select=discord_user_id,display_name,username,avatar_url,is_active,is_banned&limit=1");
    if (!profileResponse.ok) return send(res, 503, { error: "تعذّر التحقق من تسجيل العضو في الموقع." });
    const profileRows = await profileResponse.json();
    const profile = profileRows[0];
    if (!profile) return send(res, 404, { error: "هذا الحساب غير مسجل في الموقع." });
    if (profile.is_active === false || profile.is_banned) {
      return send(res, 409, { error: "لا يمكن تعيين حساب موقوف أو محظور من الموقع." });
    }

    const guild = await loadGuildContext(cfg);
    if (!guild.canManageRoles) return send(res, 409, { error: "البوت لا يمتلك صلاحية Manage Roles في سيرفر Discord." });
    const allRankRoles = rankList(guild.roles, Number(guild.botTop.position));
    const targetRoleId = action === "assign" ? String(body.rank_role_id || "") : null;
    const targetRole = targetRoleId ? allRankRoles.find(role => role.id === targetRoleId) : null;
    if (action === "assign" && (!targetRole || !targetRole.assignable)) {
      return send(res, 409, { error: "الرتبة المختارة غير موجودة ضمن رتب S.W.A.T المعتمدة أو أعلى من رتبة البوت." });
    }
    const callsign = action === "assign" ? validateCallsign(body.callsign) : null;
    if (action === "assign" && !targetRole) return send(res, 400, { error: "اختر رتبة S.W.A.T من القائمة." });

    const member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId);
    const originalRoles = [...(member.roles || [])];
    const allRankIds = allRankRoles.map(role => role.id);
    const blockingRole = allRankRoles.find(role => originalRoles.includes(role.id) && !role.assignable);
    if (blockingRole) {
      return send(res, 409, { error: "رتبة العضو الحالية «" + blockingRole.name + "» أعلى من رتبة البوت أو مُدارة، ولا يمكن استبدالها." });
    }
    const nextRoles = new Set(originalRoles);
    for (const roleId of allRankIds) nextRoles.delete(roleId);
    if (action === "assign") nextRoles.add(targetRole.id);
    const desiredRoles = [...nextRoles];
    const roleChanges = originalRoles.join(",") !== desiredRoles.join(",");
    if (roleChanges) {
      await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
        method: "PATCH", body: JSON.stringify({ roles: desiredRoles })
      });
    }

    const reference = crypto.randomUUID();
    const displayName = memberName(member, profile.display_name || "Discord user");
    const rankName = action === "assign" ? targetRole.label : null;
    const embed = appointmentEmbed({
      assigned: action === "assign",
      name: displayName,
      discordId: targetId,
      avatar: avatarUrl(member, cfg.guildId) || profile.avatar_url || null,
      rankName,
      callsign,
      actor: user.displayName,
      reference
    });
    let dm = null;
    try {
      dm = await sendAppointmentDm(cfg, targetId, embed);
    } catch (error) {
      if (roleChanges) {
        try {
          await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
            method: "PATCH", body: JSON.stringify({ roles: originalRoles })
          });
        } catch (rollbackError) {
          console.error("Assignment role rollback failed after DM failure:", rollbackError.code || rollbackError.message);
          return send(res, 502, { error: "فشل إرسال الخاص وفشل التراجع عن تغيير الرتب. راجع رتب العضو يدويًا." });
        }
      }
      return send(res, 502, { error: error.message || "تعذّر إرسال رسالة التعيين الخاصة. تم التراجع عن تعديل الرتبة." });
    }

    try {
      const result = await rpc(cfg, "save_staff_assignment", {
        p_discord_user_id: targetId,
        p_display_name: displayName,
        p_username: member.user?.username || profile.username || "",
        p_avatar_url: avatarUrl(member, cfg.guildId) || profile.avatar_url || "",
        p_rank_role_id: action === "assign" ? targetRole.id : null,
        p_rank_role_name: action === "assign" ? targetRole.label : null,
        p_callsign: callsign,
        p_status: action === "assign" ? "assigned" : "unassigned",
        p_actor_discord_id: user.id,
        p_actor_name: user.displayName
      });
      return send(res, 200, {
        ok: true,
        action,
        assignment: result.after,
        dm_status: "sent",
        dm_message_id: dm.messageId,
        reference
      });
    } catch (error) {
      let rollbackFailed = false;
      if (roleChanges) {
        try {
          await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
            method: "PATCH", body: JSON.stringify({ roles: originalRoles })
          });
        } catch (rollbackError) {
          rollbackFailed = true;
          console.error("Assignment role rollback failed after database failure:", rollbackError.code || rollbackError.message);
        }
      }
      try { await deleteDm(cfg, dm); } catch (deleteError) {
        console.error("Could not withdraw assignment DM after database failure:", deleteError.code || deleteError.message);
      }
      return send(res, 502, {
        error: rollbackFailed
          ? "فشل حفظ التعيين وفشل التراجع عن رتب Discord. يلزم مراجعة العضو يدويًا."
          : "تعذّر حفظ سجل التعيين؛ تم التراجع عن تغيير رتب Discord ومحاولة حذف الرسالة الخاصة.",
        rollback_failed: rollbackFailed
      });
    }
  } catch (error) {
    console.error("Staff assignments API failed:", error?.detail || error?.message || "unknown");
    return send(res, error.status || 502, { error: error.message || "تعذّرت خدمة التعيينات." });
  }
}
