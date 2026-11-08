import crypto from "node:crypto";
import { requireSameOrigin } from "../lib/request-security.js";

const DISCORD_API = "https://discord.com/api/v10";
const WARNING_LEVELS = [1, 2];

function cookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function readSession(req) {
  const secret = process.env.SESSION_SECRET, raw = cookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), signature = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 || user.issuedAt > Date.now() + 60000 ||
      (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { id: user.id, username: user.username, displayName: user.displayName || user.username, isOwner };
}
function json(res, status, body) { return res.status(status).json(body); }
function config() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const channelId = process.env.DISCORD_WARNINGS_CHANNEL_ID;
  const managerRoleId = process.env.DISCORD_WARNING_MANAGER_ROLE_ID;
  const botRoleId = process.env.DISCORD_BOT_ROLE_ID;
  const notificationRoleId = process.env.DISCORD_NOTIFICATION_ROLE_ID;
  const warningRoles = {
    1: process.env.DISCORD_WARNING_ROLE_1_ID,
    2: process.env.DISCORD_WARNING_ROLE_2_ID
  };
  if (!base || !key || !token || !guildId || !channelId || !managerRoleId ||
      WARNING_LEVELS.some(level => !/^\d{15,22}$/.test(String(warningRoles[level] || "")))) {
    return { error: "لم يتم إعداد نظام التحذيرات بالكامل." };
  }
  if (!/^\d{17,20}$/.test(String(notificationRoleId || ""))) {
    return { error: "تعذر تحديد رتبة SWAT الخاصة بمنشن الإعلانات. راجع إعداد DISCORD_NOTIFICATION_ROLE_ID." };
  }
  return { base, key, token, guildId, channelId, managerRoleId, botRoleId, notificationRoleId, warningRoles };
}
async function db(cfg, path, init = {}) {
  return fetch(cfg.base + "/rest/v1/" + path, { ...init, headers: {
    apikey: cfg.key, Authorization: "Bearer " + cfg.key, "Content-Type": "application/json",
    ...(init.headers || {})
  }});
}
async function rpc(cfg, name, body) {
  const r = await db(cfg, "rpc/" + name, { method: "POST", body: JSON.stringify(body) });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 500);
    const error = new Error("فشل تنفيذ عملية قاعدة البيانات.");
    error.detail = detail;
    throw error;
  }
  return r.json();
}
async function discord(cfg, path, init = {}) {
  const r = await fetch(DISCORD_API + path, { ...init, headers: {
    Authorization: "Bot " + cfg.token,
    "Content-Type": "application/json",
    ...(init.headers || {})
  }});
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!r.ok) {
    const e = new Error("فشل طلب ديسكورد (رمز الخطأ: " + String(data.code || r.status) + ").");
    e.status = r.status;
    e.code = String(data.code || r.status);
    throw e;
  }
  return data;
}
function discordName(member) {
  return member.nick || member.user?.global_name || member.user?.username || "Discord user";
}
function discordAvatarUrl(member, guildId) {
  const user = member?.user || {};
  const userId = String(user.id || "");
  const guildHash = member?.avatar;
  const userHash = user.avatar;
  const validHash = value => typeof value === "string" && /^[a-zA-Z0-9_]+$/.test(value);
  if (validHash(guildHash) && /^\d{15,22}$/.test(userId)) {
    const ext = guildHash.startsWith("a_") ? "gif" : "png";
    return "https://cdn.discordapp.com/guilds/" + guildId + "/users/" + userId + "/avatars/" + guildHash + "." + ext + "?size=256";
  }
  if (validHash(userHash) && /^\d{15,22}$/.test(userId)) {
    const ext = userHash.startsWith("a_") ? "gif" : "png";
    return "https://cdn.discordapp.com/avatars/" + userId + "/" + userHash + "." + ext + "?size=256";
  }
  if (/^\d{15,22}$/.test(userId)) {
    const defaultIndex = Number((BigInt(userId) >> 22n) % 6n);
    return "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }
  return null;
}
async function requireActiveStaff(cfg, user) {
  if (user.isOwner) return;
  const q = new URLSearchParams({ discord_user_id: "eq." + user.id, select: "is_active,is_banned", limit: "1" });
  const profile = await db(cfg, "staff_profiles?" + q);
  if (!profile.ok) throw Object.assign(new Error("تعذّر التحقق من حساب الموظف."), { status: 503 });
  const rows = await profile.json();
  if (!rows[0] || rows[0].is_active === false || rows[0].is_banned) {
    throw Object.assign(new Error("يجب أن يكون حساب الموظف نشطًا."), { status: 403 });
  }
}
async function requireManager(cfg, user) {
  await requireActiveStaff(cfg, user);
  if (user.isOwner) return;
  const member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + user.id);
  if (!Array.isArray(member.roles) || !member.roles.includes(cfg.managerRoleId)) {
    throw Object.assign(new Error("حسابك لا يمتلك رتبة إدارة التحذيرات (المعرّف: " + cfg.managerRoleId + "). أضف هذه الرتبة إلى حسابك لإصدار التحذيرات."), { status: 403 });
  }
}
function unionPermissions(roleList) {
  return roleList.reduce((value, role) => value | BigInt(role?.permissions || "0"), 0n);
}
function channelPermissions(base, overwrites, memberId, memberRoles) {
  const administrator = (base & (1n << 3n)) !== 0n;
  if (administrator) return (1n << 60n) - 1n;
  let value = base;
  const everyone = overwrites.find(item => item.type === 0 && item.id === memberRoles.guildId);
  if (everyone) value = (value & ~BigInt(everyone.deny || "0")) | BigInt(everyone.allow || "0");
  const roleOverwrites = overwrites.filter(item => item.type === 0 && memberRoles.ids.includes(item.id));
  const deny = roleOverwrites.reduce((sum, item) => sum | BigInt(item.deny || "0"), 0n);
  const allow = roleOverwrites.reduce((sum, item) => sum | BigInt(item.allow || "0"), 0n);
  value = (value & ~deny) | allow;
  const memberOverwrite = overwrites.find(item => item.type === 1 && item.id === memberId);
  if (memberOverwrite) value = (value & ~BigInt(memberOverwrite.deny || "0")) | BigInt(memberOverwrite.allow || "0");
  return value;
}
async function warningDiagnostics(cfg, user) {
  await requireActiveStaff(cfg, user);
  const [roles, accountMember, botUser] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/roles"),
    discord(cfg, "/guilds/" + cfg.guildId + "/members/" + user.id),
    discord(cfg, "/users/@me")
  ]);
  const botMember = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + botUser.id);
  const byId = new Map(roles.map(role => [role.id, role]));
  const memberRoles = (accountMember.roles || []).map(id => byId.get(id)).filter(Boolean);
  const botRoles = (botMember.roles || []).map(id => byId.get(id)).filter(Boolean);
  const botTop = botRoles.reduce((top, role) => !top || role.position > top.position ? role : top, null);
  const managerRole = byId.get(cfg.managerRoleId);
  const botRole = cfg.botRoleId ? byId.get(cfg.botRoleId) : null;
  const warningRoles = Object.entries(cfg.warningRoles).map(([level,id]) => {
    const role = byId.get(id);
    return { level: Number(level), id, exists: Boolean(role), name: role?.name || null,
      position: role?.position ?? null, manageableByBot: Boolean(role && !role.managed && botTop && role.position < botTop.position) };
  });
  const guildBase = unionPermissions(roles.filter(role => role.id === cfg.guildId || (botMember.roles || []).includes(role.id)));
  const botPerms = channelPermissions(guildBase, [], botUser.id, { guildId: cfg.guildId, ids: botMember.roles || [] });
  let channel = null, channelError = null, channelPerms = 0n;
  try {
    channel = await discord(cfg, "/channels/" + cfg.channelId);
    channelPerms = channelPermissions(guildBase, channel.permission_overwrites || [], botUser.id,
      { guildId: cfg.guildId, ids: botMember.roles || [] });
  } catch (error) {
    channelError = error.code || error.message || "channel_unavailable";
  }
  const bit = (flag) => (channelPerms & (1n << BigInt(flag))) !== 0n;
  return {
    account: { id: user.id, isConfiguredOwner: user.isOwner,
      assignedRoles: memberRoles.map(role => ({ id: role.id, name: role.name })) },
    managerAuthorization: { requiredRoleId: cfg.managerRoleId,
      roleExists: Boolean(managerRole), roleName: managerRole?.name || null,
      accountHasRole: (accountMember.roles || []).includes(cfg.managerRoleId) },
    bot: { id: botUser.id, username: botUser.username,
      configuredRoleId: cfg.botRoleId || null,
      configuredRoleExists: Boolean(botRole),
      configuredRoleAssigned: Boolean(cfg.botRoleId && (botMember.roles || []).includes(cfg.botRoleId)),
      configuredRoleName: botRole?.name || null, configuredRolePosition: botRole?.position ?? null,
      topRoleId: botTop?.id || null, topRoleName: botTop?.name || null,
      topRolePosition: botTop?.position ?? null,
      hasManageRoles: (botPerms & (1n << 28n)) !== 0n || (botPerms & (1n << 3n)) !== 0n },
    warningRoles,
    announcements: { channelId: cfg.channelId, channelName: channel?.name || null,
      channelAccessible: Boolean(channel), channelError,
      canViewChannel: bit(10), canSendMessages: bit(11), canEmbedLinks: bit(14) }
  };
}
async function listData(cfg) {
  const [staffResponse, subjectResponse, actionResponse] = await Promise.all([
    db(cfg, "staff_profiles?select=discord_user_id,display_name,username,avatar_url,is_active,is_banned&order=display_name.asc"),
    db(cfg, "disciplinary_subjects?select=discord_user_id,display_name,username,avatar_url,warning_level,status,last_reason,last_action_at,warning_expires_at,created_at,updated_at&order=updated_at.desc"),
    db(cfg, "disciplinary_actions?select=id,discord_user_id,target_name,action_type,warning_level,reason,details,actor_name,status,role_sync_status,dm_status,dm_message_id,channel_status,channel_message_id,warning_expires_at,expired_at,created_at&order=created_at.desc&limit=500")
  ]);
  if (!staffResponse.ok || !subjectResponse.ok || !actionResponse.ok) throw new Error("تعذّر تحميل سجلات التحذيرات.");
  return { members: await staffResponse.json(), subjects: await subjectResponse.json(), actions: await actionResponse.json() };
}
async function loadGuildRoleData(cfg) {
  const [roles, botUser] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/roles"),
    discord(cfg, "/users/@me")
  ]);
  const botMember = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + botUser.id);
  const byId = new Map(roles.map(role => [role.id, role]));
  const botTop = (botMember.roles || []).map(id => byId.get(id)).filter(Boolean)
    .reduce((top, role) => !top || role.position > top.position ? role : top, null);
  if (!botTop) throw Object.assign(new Error("تعذّر تحديد رتبة البوت في هذا السيرفر."), { status: 503 });
  if (cfg.botRoleId && (!byId.has(cfg.botRoleId) || !(botMember.roles || []).includes(cfg.botRoleId))) {
    throw Object.assign(new Error("رتبة البوت المحددة غير موجودة أو غير مُسندة إلى حساب البوت. راجع إعداد معرّف رتبة البوت."), { status: 503 });
  }
  const guildPermissions = unionPermissions(
    roles.filter(role => role.id === cfg.guildId || (botMember.roles || []).includes(role.id))
  );
  const hasManageRoles = (guildPermissions & (1n << 28n)) !== 0n ||
    (guildPermissions & (1n << 3n)) !== 0n;
  if (!hasManageRoles) {
    throw Object.assign(new Error(
      "البوت لا يمتلك صلاحية إدارة الرتب. افتح إعدادات السيرفر ثم الرتب، واختر رتبة البوت وفعّل صلاحية إدارة الرتب ثم احفظ. اترك رتبة البوت أعلى من رتبتي الإنذار الأول والإنذار الثاني."
    ), { status: 409 });
  }
  return { roles, byId, botTop };
}
function cronAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || "");
  if (!expected || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function processExpiredWarningRoles(cfg) {
  const due = await rpc(cfg, "claim_expired_warning_roles", { p_limit: 25 });
  if (!Array.isArray(due) || due.length === 0) {
    return { ok: true, processed: 0, removed: 0, failed: 0 };
  }
  let hierarchy;
  try {
    hierarchy = await loadGuildRoleData(cfg);
  } catch (error) {
    for (const item of due) {
      await rpc(cfg, "complete_expired_warning_role", {
        p_discord_user_id: item.discord_user_id,
        p_warning_level: item.warning_level,
        p_warning_expires_at: item.warning_expires_at,
        p_success: false,
        p_error_code: String(error.code || error.message || "bot_hierarchy_failed").slice(0, 120)
      });
    }
    return { ok: false, processed: due.length, removed: 0, failed: due.length, error: "تعذّر التحقق من ترتيب رتب البوت." };
  }

  let removed = 0, failed = 0;
  const results = [];
  for (const item of due) {
    try {
      let member;
      try {
        member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + item.discord_user_id);
      } catch (error) {
        if (error.status === 404) {
          await rpc(cfg, "complete_expired_warning_role", {
            p_discord_user_id: item.discord_user_id,
            p_warning_level: item.warning_level,
            p_warning_expires_at: item.warning_expires_at,
            p_success: true,
            p_error_code: null
          });
          results.push({ discord_user_id: item.discord_user_id, status: "member_left_server" });
          continue;
        }
        throw error;
      }

      const roleId = cfg.warningRoles[Number(item.warning_level)];
      const role = hierarchy.byId.get(roleId);
      if (!role || role.managed || role.position >= hierarchy.botTop.position) {
        throw new Error("لا يستطيع البوت إدارة رتبة الإنذار المنتهي رقم " + item.warning_level + " role.");
      }

      const roles = new Set(member.roles || []);
      const hadRole = roles.has(roleId);
      if (hadRole) {
        roles.delete(roleId);
        await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + item.discord_user_id, {
          method: "PATCH",
          body: JSON.stringify({ roles: [...roles] })
        });
        removed++;
      }

      await rpc(cfg, "complete_expired_warning_role", {
        p_discord_user_id: item.discord_user_id,
        p_warning_level: item.warning_level,
        p_warning_expires_at: item.warning_expires_at,
        p_success: true,
        p_error_code: null
      });
      results.push({ discord_user_id: item.discord_user_id, status: hadRole ? "role_removed" : "role_already_absent" });
    } catch (error) {
      failed++;
      const code = String(error.code || error.message || "warning_expiry_failed").slice(0, 120);
      await rpc(cfg, "complete_expired_warning_role", {
        p_discord_user_id: item.discord_user_id,
        p_warning_level: item.warning_level,
        p_warning_expires_at: item.warning_expires_at,
        p_success: false,
        p_error_code: code
      });
      results.push({ discord_user_id: item.discord_user_id, status: "retry_scheduled", error: code });
    }
  }
  return { ok: failed === 0, processed: due.length, removed, failed, results };
}
async function updateMemberRoles(cfg, targetId, level, dismiss) {
  const [member, guild] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId),
    loadGuildRoleData(cfg)
  ]);
  const originalRoles = [...(member.roles || [])];
  const current = new Set(originalRoles);
  const warningIds = Object.values(cfg.warningRoles);
  if (!dismiss) {
    const targetRole = cfg.warningRoles[level], role = guild.byId.get(targetRole);
    const unmanageableWarningRoles = warningIds.filter(id => {
      const configuredRole = guild.byId.get(id);
      return !configuredRole || configuredRole.managed || configuredRole.position >= guild.botTop.position;
    });
    if (!role) throw Object.assign(new Error("رتبة الإنذار المحددة غير موجودة في سيرفر ديسكورد."), { status: 503 });
    if (unmanageableWarningRoles.length) {
      throw Object.assign(new Error("ارفع رتبة البوت في إعدادات السيرفر لتكون أعلى من رتبتي الإنذار الأول والإنذار الثاني."), { status: 409 });
    }
    for (const id of warningIds) current.delete(id);
    current.add(targetRole);
  } else {
    if (targetId === process.env.DISCORD_OWNER_ID) {
      throw Object.assign(new Error("لا يمكن فصل مالك السيرفر المحمي."), { status: 403 });
    }
    const unmanageable = originalRoles.map(id => guild.byId.get(id)).filter(role =>
      !role || role.managed || role.position >= guild.botTop.position
    );
    if (unmanageable.length) {
      const names = unmanageable.map(role => role?.name || "Unknown/managed role").join(", ");
      throw Object.assign(new Error("Dismissal cannot be completed because the bot cannot remove these roles: " + names + ". Move the bot higher or remove managed roles manually first."), { status: 409 });
    }
    for (const id of originalRoles) current.delete(id);
  }
  const roles = [...current];
  await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
    method: "PATCH", body: JSON.stringify({ roles })
  });
  return {
    member, originalRoles, appliedRoles: roles,
    removedRoleCount: originalRoles.filter(id => !current.has(id)).length
  };
}
async function restoreMemberRoles(cfg, targetId, originalRoles) {
  await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
    method: "PATCH", body: JSON.stringify({ roles: originalRoles })
  });
}
function warningValidityDays(level) {
  return Number(level) === 2 ? 60 : 30;
}
function formatRiyadhDate(value) {
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: "Asia/Riyadh",
    calendar: "gregory",
    numberingSystem: "latn",
    dateStyle: "long",
    timeStyle: "short"
  }).format(new Date(value)) + " بتوقيت الرياض";
}
function buildDisciplinaryEmbed(action, level, target, reason, details, actor, actionId, expiresAt) {
  const dismissed = action === "dismissal";
  const actionLabel = dismissed ? "DISMISSAL" : "WARNING " + level;
  const fields = [
    { name: "العضو", value: String(target.name || "Discord member").slice(0, 200), inline: true },
    { name: "Discord ID", value: target.id, inline: true },
    { name: "الإجراء التأديبي", value: actionLabel, inline: true },
    { name: "سبب الإجراء", value: String(reason).slice(0, 1000), inline: false },
    ...(details ? [{ name: "تفاصيل إضافية", value: String(details).slice(0, 1000), inline: false }] : []),
    { name: "صدر بواسطة", value: String(actor).slice(0, 150), inline: true },
    { name: "الرقم المرجعي", value: String(actionId), inline: true }
  ];
  if (dismissed) {
    fields.push({ name: "الحالة", value: "تم فصل العضو وإزالة الرتب التي يستطيع البوت إزالتها.", inline: false });
  } else {
    fields.push({ name: "مدة الإنذار", value: warningValidityDays(level) + " يومًا", inline: true });
    fields.push({ name: "تاريخ الانتهاء", value: formatRiyadhDate(expiresAt), inline: true });
  }
  return {
    ...(target.avatarUrl ? { thumbnail: { url: target.avatarUrl } } : {}),
    author: { name: "S.W.A.T. REDLINE • OFFICIAL DISCIPLINARY RECORD" },
    title: dismissed ? "⛔ MEMBER DISMISSED" : "⚠️ OFFICIAL " + actionLabel,
    description: dismissed
      ? "تم تسجيل قرار فصل العضو من إدارة S.W.A.T. REDLINE."
      : "تم إصدار وتسجيل إنذار رسمي وفقًا للوائح S.W.A.T. REDLINE.",
    color: dismissed ? 0xB4232D : 0xD99A24,
    fields,
    footer: { text: "S.W.A.T. REDLINE • DISCIPLINARY & COMPLIANCE" },
    timestamp: new Date().toISOString()
  };
}
function disciplinaryNoticeEmbed(action, level, target, reason, details, actor, actionId, expiresAt) {
  return buildDisciplinaryEmbed(action, level, target, reason, details, actor, actionId, expiresAt);
}
async function sendDirectNotice(cfg, targetId, embed) {
  const dm = await discord(cfg, "/users/@me/channels", {
    method: "POST", body: JSON.stringify({ recipient_id: targetId })
  });
  if (!dm?.id) throw Object.assign(new Error("لم يتمكن ديسكورد من إنشاء محادثة خاصة مع هذا العضو."), { code: "dm_channel_missing" });
  const sent = await discord(cfg, "/channels/" + dm.id + "/messages", {
    method: "POST",
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
  });
  if (!sent?.id) throw Object.assign(new Error("لم يؤكد ديسكورد إرسال الرسالة الخاصة."), { code: "dm_message_missing" });
  return { channelId: dm.id, messageId: sent.id };
}
async function deleteDirectNotice(cfg, dm) {
  if (!dm?.channelId || !dm?.messageId) return;
  await discord(cfg, "/channels/" + dm.channelId + "/messages/" + dm.messageId, { method: "DELETE" });
}
function announcementEmbed(action, level, target, reason, details, actor, actionId, expiresAt) {
  return buildDisciplinaryEmbed(action, level, target, reason, details, actor, actionId, expiresAt);
}
async function loadDisciplinaryMentionSettings(cfg) {
  const query = new URLSearchParams({
    select: "key,value",
    key: "in.(notificationRoleMentionDisabled,disciplinaryTargetMentionEnabled)"
  });
  const response = await db(cfg, "site_settings?" + query.toString());
  if (!response.ok) {
    throw Object.assign(new Error("Could not load disciplinary mention settings."), { status: 503 });
  }
  const rows = await response.json();
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    swatRoleMentionEnabled: values.notificationRoleMentionDisabled === false,
    targetMentionEnabled: values.disciplinaryTargetMentionEnabled !== false
  };
}
async function sendAnnouncement(cfg, embed, targetId) {
  const mentionSettings = await loadDisciplinaryMentionSettings(cfg);
  const roleMention = mentionSettings.swatRoleMentionEnabled ? "<@&" + cfg.notificationRoleId + ">" : null;
  const memberMention = mentionSettings.targetMentionEnabled ? "<@" + targetId + ">" : null;
  const content = [roleMention, memberMention].filter(Boolean).join(" ");
  return discord(cfg, "/channels/" + cfg.channelId + "/messages", {
    method: "POST",
    body: JSON.stringify({
      ...(content ? { content } : {}),
      embeds: [embed],
      allowed_mentions: {
        parse: [],
        roles: mentionSettings.swatRoleMentionEnabled ? [cfg.notificationRoleId] : [],
        users: mentionSettings.targetMentionEnabled ? [targetId] : []
      }
    })
  });
}
async function appendAudit(cfg, user, action, subjectId, actionId, extra) {
  const r = await db(cfg, "audit_logs", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      actor_discord_id: user.id, actor_name: user.displayName,
      action: action === "dismissal" ? "delete" : "create",
      entity_type: "disciplinary_action", entity_id: actionId,
      details: { target_discord_id: subjectId, action_type: action, ...extra }
    })
  });
  if (!r.ok) console.error("Disciplinary audit append failed:", r.status);
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const requestUrl = new URL(req.url, "https://portal.invalid");
  if (requestUrl.searchParams.get("task") === "expire") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "طريقة الطلب غير مسموح بها." });
    }
    if (!cronAuthorized(req)) return json(res, 401, { error: "يلزم التحقق من صلاحية مهمة الجدولة." });
    const cronCfg = config();
    if (cronCfg.error) return json(res, 503, { error: cronCfg.error });
    try {
      return json(res, 200, await processExpiredWarningRoles(cronCfg));
    } catch (error) {
      console.error("Warning expiry cron failed:", error?.detail || error?.message || "unknown");
      return json(res, 502, { error: "فشلت معالجة انتهاء صلاحية الإنذارات." });
    }
  }
  const user = readSession(req);
  if (!user) return json(res, 401, { error: "يجب تسجيل الدخول أولًا." });
  const cfg = config();
  if (cfg.error) return json(res, 503, { error: cfg.error });
  try {
    const params = new URL(req.url, "https://portal.invalid").searchParams;
    if (req.method === "GET" && params.get("diagnostics") === "1") {
      const diagnostics = await warningDiagnostics(cfg, user);
      return json(res, 200, diagnostics);
    }
    await requireManager(cfg, user);
    if (req.method === "GET" && new URL(req.url, "https://portal.invalid").searchParams.get("access") === "1") {
      return json(res, 200, { authorized: true });
    }
    if (req.method === "GET") {
      const data = await listData(cfg);
      return json(res, 200, data);
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "طريقة الطلب غير مسموح بها." });
    }
    if (!requireSameOrigin(req, res)) return;
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const actionType = body.action === "dismiss" ? "dismissal" : body.action === "issue" ? "warning" : "";
    const targetId = String(body.discord_user_id || "");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const details = typeof body.details === "string" ? body.details.trim() : "";
    const level = Number(body.warning_level);
    const requestId = String(body.request_id || "");
    const validActionLevel = actionType === "warning"
      ? WARNING_LEVELS.includes(level)
      : actionType === "dismissal" && level === 3;
    if (!actionType || !validActionLevel || !/^\d{15,22}$/.test(targetId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
        !reason || reason.length > 1000 || details.length > 3000) {
      return json(res, 400, { error: "راجع معرّف العضو والإجراء والسبب ومعرّف الطلب." });
    }
    const target = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId);
    const targetName = discordName(target);
    const targetProfile = { id: targetId, name: targetName, avatarUrl: discordAvatarUrl(target, cfg.guildId) };
    if (targetId === process.env.DISCORD_OWNER_ID) return json(res, 403, { error: "لا يمكن اتخاذ إجراء تأديبي ضد المالك المحمي من خلال هذه الأداة." });

    const start = await rpc(cfg, "begin_disciplinary_action", {
      p_request_id: requestId,
      p_discord_user_id: targetId,
      p_target_name: targetName,
      p_username: target.user?.username || "",
      p_avatar_url: targetProfile.avatarUrl,
      p_action_type: actionType,
      p_warning_level: level,
      p_reason: reason,
      p_details: details,
      p_actor_discord_id: user.id,
      p_actor_name: user.displayName
    });
    if (start.duplicate) {
      return json(res, start.status === "completed" ? 200 : 409, {
        ok: start.status === "completed", duplicate: true, status: start.status,
        error: start.status === "pending" ? "This request is already being processed. Check the record before retrying." : undefined
      });
    }

    const expiresAt = actionType === "warning" ? new Date(Date.now() + warningValidityDays(level) * 24 * 60 * 60 * 1000).toISOString() : null;
    let roleResult = null;
    let dmResult = null;
    let channelMessage = null;

    try {
      roleResult = await updateMemberRoles(cfg, targetId, level, actionType === "dismissal");
    } catch (error) {
      const errorCode = String(error.code || error.message || "role_sync_failed").slice(0, 120);
      await rpc(cfg, "complete_disciplinary_action_v2", {
        p_action_id: start.action_id, p_role_sync_status: "failed", p_dm_status: "failed",
        p_dm_channel_id: null, p_dm_message_id: null, p_channel_status: "failed",
        p_channel_message_id: null, p_warning_expires_at: null, p_error_code: errorCode
      });
      return json(res, error.status || 502, { ok: false, status: "failed", error: error.message || "Discord roles could not be updated." });
    }

    try {
      dmResult = await sendDirectNotice(cfg, targetId,
        disciplinaryNoticeEmbed(actionType, level, targetProfile, reason, details, user.displayName, start.action_id, expiresAt));
    } catch (error) {
      let rollbackFailed = false;
      try { await restoreMemberRoles(cfg, targetId, roleResult.originalRoles); }
      catch (rollbackError) {
        rollbackFailed = true;
        console.error("Role rollback failed after private message delivery failure:", rollbackError.code || rollbackError.message);
      }
      const errorCode = String(error.code || error.message || "dm_delivery_failed").slice(0, 100);
      await rpc(cfg, "complete_disciplinary_action_v2", {
        p_action_id: start.action_id, p_role_sync_status: rollbackFailed ? "succeeded" : "failed",
        p_dm_status: "failed", p_dm_channel_id: null, p_dm_message_id: null,
        p_channel_status: "failed", p_channel_message_id: null, p_warning_expires_at: null,
        p_error_code: (rollbackFailed ? "dm_failed_rollback_failed:" : "dm_failed:") + errorCode
      });
      return json(res, 502, {
        ok: false, status: "failed",
        error: rollbackFailed
          ? "فشل إرسال الرسالة الخاصة كما فشل التراجع عن تغيير الرتبة. يلزم إصلاح الرتبة يدويًا من ديسكورد."
          : "تعذّر إرسال الرسالة الخاصة إلى العضو. تم التراجع عن تغيير الرتبة ولم يتم تسجيل الإنذار أو قرار الفصل.",
        code: errorCode
      });
    }

    try {
      channelMessage = await sendAnnouncement(cfg,
        announcementEmbed(actionType, level, targetProfile, reason, details, user.displayName, start.action_id, expiresAt), targetId);
    } catch (error) {
      const errorCode = String(error.code || error.message || "channel_delivery_failed").slice(0, 100);
      let rollbackFailed = false;
      try { await restoreMemberRoles(cfg, targetId, roleResult.originalRoles); }
      catch (rollbackError) {
        rollbackFailed = true;
        console.error("Role rollback failed after announcement delivery failure:", rollbackError.code || rollbackError.message);
      }
      try { await deleteDirectNotice(cfg, dmResult); }
      catch (deleteError) { console.error("Could not withdraw private notice after channel failure:", deleteError.code || deleteError.message); }
      await rpc(cfg, "complete_disciplinary_action_v2", {
        p_action_id: start.action_id, p_role_sync_status: rollbackFailed ? "succeeded" : "failed",
        p_dm_status: "failed", p_dm_channel_id: dmResult.channelId, p_dm_message_id: dmResult.messageId,
        p_channel_status: "failed", p_channel_message_id: null, p_warning_expires_at: null,
        p_error_code: (rollbackFailed ? "channel_failed_rollback_failed:" : "channel_failed:") + errorCode
      });
      return json(res, 502, {
        ok: false, status: "failed",
        error: "تعذّر نشر الإشعار في قناة التحذيرات. تم التراجع عن تغيير الرتبة ومحاولة حذف الرسالة الخاصة.",
        code: errorCode
      });
    }

    const completion = await rpc(cfg, "complete_disciplinary_action_v2", {
      p_action_id: start.action_id,
      p_role_sync_status: "succeeded",
      p_dm_status: "sent",
      p_dm_channel_id: dmResult.channelId,
      p_dm_message_id: dmResult.messageId,
      p_channel_status: "sent",
      p_channel_message_id: channelMessage.id || null,
      p_warning_expires_at: expiresAt,
      p_error_code: null
    });
    await appendAudit(cfg, user, actionType, targetId, start.action_id, {
      warning_level: level, reason, details,
      dm_status: "sent", dm_channel_id: dmResult.channelId, dm_message_id: dmResult.messageId,
      discord_channel_status: "sent", channel_message_id: channelMessage.id || null,
      removed_role_count: roleResult?.removedRoleCount || 0, warning_expires_at: expiresAt
    });
    return json(res, 200, {
      ok: true, status: completion.status, action_id: start.action_id,
      dm_status: "sent", dm_message_id: dmResult.messageId,
      channel_status: "sent", channel_message_id: channelMessage.id || null,
      warning_level: level, action_type: actionType, expires_at: expiresAt
    });
  } catch (error) {
    console.error("Warnings API failed:", error?.detail || error?.message || "unknown");
    return json(res, error.status || 502, { error: error.message || "Warnings service failed." });
  }
}
