import crypto from "node:crypto";
import { requireSameOrigin } from "../lib/request-security.js";
import { discordApiRequest } from "../lib/discord-rest.js";
import { forwardAuditToDiscord } from "../lib/audit-log.js";
import { isWebsiteAdmin } from "../lib/portal-admin.js";

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
  const swatRoleId = process.env.DISCORD_ROLE_ID;
  const warningRoles = {
    1: process.env.DISCORD_WARNING_ROLE_1_ID,
    2: process.env.DISCORD_WARNING_ROLE_2_ID
  };
  if (!base || !key || !token || !guildId || !channelId || !managerRoleId ||
      !/^\d{15,22}$/.test(String(swatRoleId || "")) ||
      WARNING_LEVELS.some(level => !/^\d{15,22}$/.test(String(warningRoles[level] || "")))) {
    return { error: "لم يتم إعداد نظام التحذيرات بالكامل." };
  }
  if (!/^\d{17,20}$/.test(String(notificationRoleId || ""))) {
    return { error: "تعذر تحديد رتبة SWAT الخاصة بمنشن الإعلانات. راجع إعداد DISCORD_NOTIFICATION_ROLE_ID." };
  }
  return { base, key, token, guildId, channelId, managerRoleId, botRoleId, notificationRoleId, warningRoles, swatRoleId };
}
async function db(cfg, path, init = {}) {
  return fetch(cfg.base + "/rest/v1/" + path, { ...init, headers: {
    apikey: cfg.key, Authorization: "Bearer " + cfg.key, "Content-Type": "application/json",
    ...(init.headers || {})
  }});
}
async function memberPrivateNotificationsEnabled(cfg, discordUserId) {
  const query = new URLSearchParams({
    discord_user_id: "eq." + String(discordUserId),
    select: "notifications_enabled",
    limit: "1"
  });
  const response = await db(cfg, "staff_profiles?" + query.toString());
  if (!response.ok) {
    console.error("Warning DM preference lookup failed:", response.status, (await response.text()).slice(0, 250));
    throw Object.assign(new Error("تعذّر التحقق من إعداد استقبال الرسائل الخاصة للعضو."), { status: 503 });
  }
  const rows = await response.json();
  // A member without a portal profile has not opted out; existing profiles default to enabled.
  return !rows.length || rows[0].notifications_enabled !== false;
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
  return discordApiRequest(cfg.token,path,init,{maxRetries:3,maxRetryWaitMs:8000});
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
  if (user.isOwner || await isWebsiteAdmin(user)) return;
  throw Object.assign(new Error("يجب امتلاك رتبة Website Admin لإدارة التحذيرات."), { status: 403 });
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

function riyadhDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const get = type => parts.find(part => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}
function dateOrdinal(value) {
  const match = String(value || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}
async function attendanceRows(cfg, offset, discordUserIds = null) {
  const query = new URLSearchParams({
    select: "discord_user_id,attendance_date,first_seen_at",
    order: "attendance_date.desc,first_seen_at.desc",
    limit: "1000",
    offset: String(offset)
  });
  if (Array.isArray(discordUserIds) && discordUserIds.length) {
    query.set("discord_user_id", "in.(" + discordUserIds.map(id => '"' + String(id) + '"').join(",") + ")");
  }
  const response = await db(cfg, "attendance_records?" + query.toString());
  if (!response.ok) throw new Error("تعذّر تحميل سجل البصمات.");
  return response.json();
}
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
async function getGuildMemberOrNull(cfg, discordUserId) {
  try {
    return await discord(cfg, "/guilds/" + encodeURIComponent(cfg.guildId) + "/members/" + encodeURIComponent(discordUserId));
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}
async function listAttendanceDashboard(cfg) {
  const staffQuery = new URLSearchParams({
    select: "discord_user_id,display_name,username,avatar_url,is_active,is_banned,created_at",
    is_banned: "eq.false", order: "display_name.asc", limit: "1000"
  });
  const subjectQuery = new URLSearchParams({
    select: "discord_user_id,warning_level,status,last_reason,last_action_at,warning_expires_at", limit: "1000"
  });
  const attendanceStateQuery = new URLSearchParams({
    channel_id: "eq." + (process.env.ATTENDANCE_CHANNEL_ID || "1569735227146768434"),
    select: "initialized_at", limit: "1"
  });
  const [staffResponse, subjectResponse, stateResponse, exemptionResponse, leaveResponse] = await Promise.all([
    db(cfg, "staff_profiles?" + staffQuery.toString()),
    db(cfg, "disciplinary_subjects?" + subjectQuery.toString()),
    db(cfg, "attendance_sync_state?" + attendanceStateQuery.toString()),
    db(cfg, "attendance_exemptions?select=discord_user_id,enabled,reason,updated_at&limit=1000"),
    db(cfg, "attendance_leave_requests?status=eq.approved&select=discord_user_id,start_date,end_date&order=end_date.desc&limit=2000")
  ]);
  if (!staffResponse.ok || !subjectResponse.ok || !stateResponse.ok ||
      !exemptionResponse.ok || !leaveResponse.ok) {
    throw new Error("تعذّر تحميل الأعضاء أو حالات التحذيرات أو إعدادات واستثناءات البصمة.");
  }
  const allStaff = await staffResponse.json();
  const subjects = await subjectResponse.json();
  const stateRows = await stateResponse.json();
  const exemptionRows = await exemptionResponse.json();
  const approvedLeaveRows = await leaveResponse.json();
  const subjectById = new Map(subjects.map(subject => [String(subject.discord_user_id), subject]));
  const exemptionById = new Map(exemptionRows.map(row => [String(row.discord_user_id), row]));
  const leavesById = new Map();
  for (const leave of approvedLeaveRows) {
    const id = String(leave.discord_user_id || "");
    if (!id) continue;
    if (!leavesById.has(id)) leavesById.set(id, []);
    leavesById.get(id).push(leave);
  }
  const attendanceStartedAt = stateRows[0]?.initialized_at || new Date().toISOString();
  const candidates = allStaff.filter(profile => profile.is_banned !== true &&
    (profile.is_active === true || subjectById.get(String(profile.discord_user_id))?.status === "dismissed"));
  const membership = await mapConcurrent(candidates, 8, async profile => {
    const id = String(profile.discord_user_id);
    const subject = subjectById.get(id) || null;
    if (profile.is_active !== true) return { profile, subject, is_swat_member: false };
    const member = await getGuildMemberOrNull(cfg, id);
    return { profile, subject, is_swat_member: Boolean(member && Array.isArray(member.roles) && member.roles.includes(cfg.swatRoleId)) };
  });
  const visible = membership.filter(item => item.is_swat_member || item.subject?.status === "dismissed");
  const visibleIds = visible.map(item => String(item.profile.discord_user_id));
  const recordsByMember = new Map();
  for (let offset = 0, page = 0; visibleIds.length && page < 50; page++, offset += 1000) {
    const rows = await attendanceRows(cfg, offset, visibleIds);
    for (const row of rows) {
      const id = String(row.discord_user_id || "");
      if (!id) continue;
      if (!recordsByMember.has(id)) recordsByMember.set(id, []);
      recordsByMember.get(id).push(row);
    }
    if (rows.length < 1000) break;
    if (page === 49) throw new Error("سجل البصمات أكبر من الحد المسموح للتحميل؛ يلزم تقسيم التقرير.");
  }
  const now = new Date(), nowMs = now.getTime();
  const today = riyadhDateKey(now), todayOrdinal = dateOrdinal(today), weekStartOrdinal = todayOrdinal - 6;
  const members = visible.map(({profile,subject,is_swat_member}) => {
    const id = String(profile.discord_user_id);
    const stamps = recordsByMember.get(id) || [];
    const unique = new Map();
    for (const stamp of stamps) {
      const date = String(stamp.attendance_date || "").slice(0,10);
      if (date && !unique.has(date)) unique.set(date,stamp);
    }
    const daily = [...unique.entries()].sort((a,b)=>dateOrdinal(b[0])-dateOrdinal(a[0]));
    const last = daily[0]?.[1] || null, first = daily[daily.length-1]?.[1] || null;
    const lastDate = daily[0]?.[0] || null;
    const registeredMs = Date.parse(profile.created_at || now.toISOString());
    const systemMs = Date.parse(attendanceStartedAt);
    const originalBaselineMs = last ? Date.parse(last.first_seen_at) : Math.max(
      Number.isFinite(registeredMs)?registeredMs:nowMs,
      Number.isFinite(systemMs)?systemMs:nowMs
    );
    const exemption = exemptionById.get(id) || null;
    const isAttendanceExempt = exemption?.enabled === true;
    const leaveRows = leavesById.get(id) || [];
    const currentLeave = leaveRows.find(leave =>
      String(leave.start_date || "") <= today && String(leave.end_date || "") >= today
    ) || null;
    const leaveEndDates = leaveRows
      .map(leave => String(leave.end_date || ""))
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today)
      .sort();
    const latestLeaveEnd = leaveEndDates.length ? leaveEndDates[leaveEndDates.length - 1] : null;
    let baselineMs = Number.isFinite(originalBaselineMs) ? originalBaselineMs : nowMs;
    if (latestLeaveEnd) {
      const leaveEndMs = Date.parse(latestLeaveEnd + "T20:59:59.999Z");
      if (Number.isFinite(leaveEndMs)) baselineMs = Math.max(baselineMs, leaveEndMs);
    }
    if (exemption && exemption.enabled === false) {
      const exemptionEndedMs = Date.parse(exemption.updated_at || "");
      if (Number.isFinite(exemptionEndedMs)) baselineMs = Math.max(baselineMs, exemptionEndedMs);
    }
    const isOnApprovedLeave = Boolean(currentLeave);
    if (isAttendanceExempt || isOnApprovedLeave) baselineMs = nowMs;
    const safeBaselineMs = Number.isFinite(baselineMs) ? Math.min(baselineMs,nowMs) : nowMs;
    const daysSinceLast = (isAttendanceExempt || isOnApprovedLeave)
      ? 0
      : Math.max(0,Math.floor((nowMs-safeBaselineMs)/86400000));
    const absenceStartedAt = (isAttendanceExempt || isOnApprovedLeave)
      ? null
      : (last?.first_seen_at || new Date(safeBaselineMs).toISOString());
    const absenceBaseline = isAttendanceExempt ? "exempt"
      : isOnApprovedLeave ? "approved_leave"
      : last ? "last_attendance"
      : latestLeaveEnd ? "approved_leave_end"
      : (exemption?.enabled === false ? "exemption_ended"
      : registeredMs > systemMs ? "member_registration" : "system_activation");
    const weekCount = daily.filter(([date])=>{const ordinal=dateOrdinal(date);return ordinal!==null&&ordinal>=weekStartOrdinal&&ordinal<=todayOrdinal;}).length;
    let streak=0,previousOrdinal=null;
    for(const [date] of daily){const ordinal=dateOrdinal(date);if(ordinal===null)continue;if(previousOrdinal===null)streak=1;else if(previousOrdinal-ordinal===1)streak++;else break;previousOrdinal=ordinal;}
    return {
      discord_user_id:id,display_name:profile.display_name||profile.username||"Discord member",username:profile.username||"",
      avatar_url:profile.avatar_url||null,registered_at:profile.created_at||null,is_swat_member,is_dismissed:subject?.status==="dismissed",
      is_attendance_exempt:isAttendanceExempt,attendance_exemption_reason:exemption?.reason||null,
      is_on_approved_leave:isOnApprovedLeave,approved_leave_end_date:currentLeave?.end_date||null,
      today_present:lastDate===today,has_ever_attended:Boolean(last),last_attendance_at:last?.first_seen_at||null,
      last_attendance_date:lastDate,first_attendance_at:first?.first_seen_at||null,absence_started_at:absenceStartedAt,
      absence_baseline:absenceBaseline,days_since_last:daysSinceLast,weeks_since_last:Math.floor(daysSinceLast/7),
      last_seven_days:weekCount,total_days:daily.length,current_streak_days:streak,
      warning_level:Number(subject?.warning_level||0),warning_status:subject?.status||"clear",
      warning_reason:subject?.last_reason||null,warning_updated_at:subject?.last_action_at||null,
      warning_expires_at:subject?.warning_expires_at||null
    };
  });
  const activeSwat=members.filter(member=>member.is_swat_member);
  return {generated_at:now.toISOString(),attendance_started_at:attendanceStartedAt,timezone:"Asia/Riyadh",
    channel_id:process.env.ATTENDANCE_CHANNEL_ID||"1569735227146768434",total_members:activeSwat.length,
    visible_members:members.length,dismissed_members:members.filter(member=>member.is_dismissed).length,
    exempt_members:activeSwat.filter(member=>member.is_attendance_exempt).length,members};
}

async function isAttendanceExempt(cfg, discordUserId) {
  const q = new URLSearchParams({
    discord_user_id: "eq." + String(discordUserId),
    enabled: "eq.true",
    select: "discord_user_id",
    limit: "1"
  });
  const response = await db(cfg, "attendance_exemptions?" + q.toString());
  if (!response.ok) throw new Error("تعذّر إعادة التحقق من إعفاء العضو من البصمة.");
  return (await response.json()).length > 0;
}

async function listData(cfg, includeArchived = false) {
  const subjectQuery =
    "disciplinary_subjects?select=discord_user_id,display_name,username,avatar_url,warning_level,status,last_reason,last_action_at,warning_expires_at,is_archived,archived_at,archived_by_name,archive_reason,created_at,updated_at&order=updated_at.desc" +
    (includeArchived ? "" : "&is_archived=eq.false");
  const [staffResponse, subjectResponse, actionResponse] = await Promise.all([
    db(cfg, "staff_profiles?select=discord_user_id,display_name,username,avatar_url,is_active,is_banned&order=display_name.asc"),
    db(cfg, subjectQuery),
    db(cfg, "disciplinary_actions?select=id,discord_user_id,target_name,action_type,warning_level,reason,details,actor_name,status,role_sync_status,dm_status,dm_channel_id,dm_message_id,channel_status,channel_message_id,warning_expires_at,expired_at,voided_at,void_reason,voided_by_discord_id,voided_by_name,completed_at,created_at&order=created_at.desc&limit=500")
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
async function latestAttendanceForMember(cfg, discordUserId) {
  const q=new URLSearchParams({discord_user_id:"eq."+String(discordUserId),select:"attendance_date,first_seen_at",order:"attendance_date.desc,first_seen_at.desc",limit:"1"});
  const r=await db(cfg,"attendance_records?"+q.toString());
  if(!r.ok)throw new Error("تعذّر التحقق من آخر بصمة للعضو.");
  return (await r.json())[0]||null;
}
async function currentDisciplinaryState(cfg, discordUserId) {
  const q=new URLSearchParams({discord_user_id:"eq."+String(discordUserId),select:"discord_user_id,warning_level,status,last_reason,last_action_at,warning_expires_at",limit:"1"});
  const r=await db(cfg,"disciplinary_subjects?"+q.toString());
  if(!r.ok)throw new Error("تعذّر تحميل حالة التحذيرات الحالية.");
  return (await r.json())[0]||{warning_level:0,status:"clear"};
}
function elapsedAbsenceDays(lastAttendance, profileCreatedAt, systemStartedAt, now=new Date()) {
  const lastMs=lastAttendance?Date.parse(lastAttendance.first_seen_at):NaN;
  const createdMs=Date.parse(profileCreatedAt||now.toISOString()), startedMs=Date.parse(systemStartedAt||now.toISOString());
  const baselineMs=Number.isFinite(lastMs)?lastMs:Math.max(Number.isFinite(createdMs)?createdMs:now.getTime(),Number.isFinite(startedMs)?startedMs:now.getTime());
  return {days:Math.max(0,Math.floor(Math.max(0,now.getTime()-baselineMs)/86400000)),startedAt:new Date(Math.min(baselineMs,now.getTime())).toISOString()};
}
async function applyAutomaticAttendanceAction(cfg, actor, discordUserId, stage, absenceDays, absenceStartedAt) {
  const actionType=stage===3?"dismissal":"warning", level=stage===3?3:stage;
  const target=await getGuildMemberOrNull(cfg,discordUserId);
  if(!target)return {skipped:"member_left_server"};
  if(!Array.isArray(target.roles)||!target.roles.includes(cfg.swatRoleId))return {skipped:"swat_role_removed"};
  if(discordUserId===process.env.DISCORD_OWNER_ID)return {skipped:"protected_owner"};
  const targetName=discordName(target);
  const targetProfile={id:discordUserId,name:targetName,avatarUrl:discordAvatarUrl(target,cfg.guildId)};
  const reason=stage===1?"عدم تسجيل الحضور اليومي لمدة 7 أيام متتالية.":stage===2?"عدم تسجيل الحضور اليومي لمدة 14 يومًا متتالية.":"الفصل التلقائي بسبب عدم تسجيل الحضور اليومي لمدة 21 يومًا متتالية.";
  const details="آخر بصمة/بداية احتساب الغياب: "+formatRiyadhDate(absenceStartedAt)+". مدة الغياب المحسوبة: "+absenceDays+" يومًا. الإجراء صادر تلقائيًا من نظام البصمة اليومية في S.W.A.T. REDLINE.";
  const dmAllowed=await memberPrivateNotificationsEnabled(cfg,discordUserId);
  const start=await rpc(cfg,"begin_disciplinary_action",{
    p_request_id:crypto.randomUUID(),p_discord_user_id:discordUserId,p_target_name:targetName,
    p_username:target.user?.username||"",p_avatar_url:targetProfile.avatarUrl,p_action_type:actionType,
    p_warning_level:level,p_reason:reason,p_details:details,p_actor_discord_id:actor.id,p_actor_name:actor.displayName
  });
  if(start.duplicate){if(start.status==="completed")return {duplicate:true,action_id:start.action_id};throw new Error("disciplinary_action_already_pending");}
  const expiresAt=actionType==="warning"?new Date(Date.now()+warningValidityDays(level)*86400000).toISOString():null;
  let roleResult;
  try{roleResult=await updateMemberRoles(cfg,discordUserId,level,actionType==="dismissal");}
  catch(error){
    await rpc(cfg,"complete_disciplinary_action_v2",{p_action_id:start.action_id,p_role_sync_status:"failed",p_dm_status:"failed",p_dm_channel_id:null,p_dm_message_id:null,p_channel_status:"failed",p_channel_message_id:null,p_warning_expires_at:null,p_error_code:String(error.code||error.message||"role_sync_failed").slice(0,120)});
    throw error;
  }
  let dmResult=null;
  if(dmAllowed){
    try{dmResult=await sendDirectNotice(cfg,discordUserId,disciplinaryNoticeEmbed(actionType,level,targetProfile,reason,details,actor.displayName,start.action_id,expiresAt));}
    catch(error){
      let rollbackFailed=false;try{await restoreMemberRoles(cfg,discordUserId,roleResult.originalRoles);}catch{rollbackFailed=true;}
      await rpc(cfg,"complete_disciplinary_action_v2",{p_action_id:start.action_id,p_role_sync_status:rollbackFailed?"succeeded":"failed",p_dm_status:"failed",p_dm_channel_id:null,p_dm_message_id:null,p_channel_status:"failed",p_channel_message_id:null,p_warning_expires_at:null,p_error_code:(rollbackFailed?"dm_rollback_failed:":"dm_failed:")+String(error.code||error.message||"dm_delivery_failed").slice(0,100)});
      throw error;
    }
  }
  let channelMessage;
  try{channelMessage=await sendAnnouncement(cfg,announcementEmbed(actionType,level,targetProfile,reason,details,actor.displayName,start.action_id,expiresAt),discordUserId);}
  catch(error){
    let rollbackFailed=false;try{await restoreMemberRoles(cfg,discordUserId,roleResult.originalRoles);}catch{rollbackFailed=true;}
    if(dmResult){try{await deleteDirectNotice(cfg,dmResult);}catch{}}
    await rpc(cfg,"complete_disciplinary_action_v2",{p_action_id:start.action_id,p_role_sync_status:rollbackFailed?"succeeded":"failed",p_dm_status:dmResult?"failed":"skipped",p_dm_channel_id:dmResult?.channelId||null,p_dm_message_id:dmResult?.messageId||null,p_channel_status:"failed",p_channel_message_id:null,p_warning_expires_at:null,p_error_code:(rollbackFailed?"announcement_rollback_failed:":"announcement_failed:")+String(error.code||error.message||"channel_delivery_failed").slice(0,100)});
    throw error;
  }
  const completionInput={p_action_id:start.action_id,p_role_sync_status:"succeeded",p_dm_status:dmResult?"sent":"skipped",p_dm_channel_id:dmResult?.channelId||null,p_dm_message_id:dmResult?.messageId||null,p_channel_status:"sent",p_channel_message_id:channelMessage.id||null,p_warning_expires_at:expiresAt,p_error_code:null};
  let completion;
  try{completion=await rpc(cfg,"complete_disciplinary_action_v2",completionInput);}catch{completion=await rpc(cfg,"complete_disciplinary_action_v2",completionInput);}
  try{
    await forwardAuditToDiscord(actor,{action:actionType==="dismissal"?"delete":"create",entity_type:"disciplinary_action",entity_id:start.action_id,details:{
      type:actionType==="dismissal"?"فصل تلقائي بسبب الغياب":"تحذير تلقائي بسبب الغياب",
      detail:(actionType==="dismissal"?"تم فصل ":"تم إصدار إنذار تلقائي للمستخدم ")+targetName+(actionType==="warning"?" • المستوى "+level:"")+" بسبب الغياب عن البصمة.",
      target_discord_id:discordUserId,automatic_attendance_action:true,absence_days:absenceDays
    }});
  }catch(error){console.error("Automatic attendance audit forwarding failed:",error?.message||"unknown");}
  return {ok:completion.status==="completed",action_id:start.action_id,action_type:actionType,warning_level:actionType==="warning"?level:null,dm_status:dmResult?"sent":"skipped",channel_status:"sent",removed_role_count:roleResult.removedRoleCount||0};
}
async function processAutomaticAttendanceDiscipline(cfg) {
  const dashboard = await listAttendanceDashboard(cfg);
  const candidates = dashboard.members
    .filter(member => member.is_swat_member && !member.is_attendance_exempt && !member.is_on_approved_leave &&
      member.discord_user_id !== process.env.DISCORD_OWNER_ID)
    .map(member => {
      const dismissed = member.warning_status === "dismissed";
      const currentLevel = dismissed ? 0 : Number(member.warning_level || 0);
      const lastActionMs = Date.parse(member.warning_updated_at || "");
      const nextAllowedAtMs = currentLevel > 0 && Number.isFinite(lastActionMs)
        ? lastActionMs + 7 * 86400000
        : 0;
      return { ...member, next_stage: currentLevel + 1, next_allowed_at_ms: nextAllowedAtMs };
    })
    .filter(member => member.next_stage >= 1 && member.next_stage <= 3 &&
      Number(member.days_since_last) >= member.next_stage * 7 &&
      Date.now() >= member.next_allowed_at_ms)
    .sort((a, b) => Number(b.days_since_last) - Number(a.days_since_last));

  if (!candidates.length) {
    return { ok: true, scanned: dashboard.total_members, due: 0, processed: 0, warnings: 0, dismissed: 0, failed: 0 };
  }

  const botUser = await discord(cfg, "/users/@me");
  const actor = { id: botUser.id, displayName: "S.W.A.T. REDLINE • Attendance Automation" };
  let processed = 0, warnings = 0, dismissed = 0, failed = 0;
  const results = [];

  // Limit the amount of Discord work per minute, but keep scanning the full due queue.
  for (const candidate of candidates) {
    if (processed >= 3) break;
    const stage = candidate.next_stage;
    const latestStamp = await latestAttendanceForMember(cfg, candidate.discord_user_id);
    const absence = elapsedAbsenceDays(
      latestStamp,
      candidate.registered_at,
      dashboard.attendance_started_at,
      new Date()
    );
    if (absence.days < stage * 7) continue;

    const eventKey = "attendance:" + candidate.discord_user_id + ":" + stage + ":" + absence.startedAt;
    const claim = await rpc(cfg, "claim_swat_attendance_discipline", {
      p_event_key: eventKey,
      p_discord_user_id: candidate.discord_user_id,
      p_stage: stage
    });
    if (!claim.claimed) continue;

    try {
      const latestMember = await getGuildMemberOrNull(cfg, candidate.discord_user_id);
      if (!latestMember || !Array.isArray(latestMember.roles) ||
          !latestMember.roles.includes(cfg.swatRoleId)) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }

      const freshSubject = await currentDisciplinaryState(cfg, candidate.discord_user_id);
      // A completed dismissal is terminal until the member is deliberately re-added to SWAT;
      // if the role was re-added, the existing database workflow permits a new Warning 1 cycle.
      if (stage === 3 && freshSubject.status === "dismissed") {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }
      const freshLevel = freshSubject.status === "dismissed"
        ? 0
        : Number(freshSubject.warning_level || 0);
      const freshStage = freshLevel + 1;
      if (freshStage !== stage) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }
      const lastActionMs = Date.parse(freshSubject.last_action_at || "");
      if (freshLevel > 0 && Number.isFinite(lastActionMs) &&
          Date.now() - lastActionMs < 7 * 86400000) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: false, p_error_code: "next_disciplinary_stage_not_due"
        });
        continue;
      }

      // Re-check exemptions and approved leave immediately before any disciplinary change.
      if (await isAttendanceExempt(cfg, candidate.discord_user_id)) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }
      const liveLeaveQuery = new URLSearchParams({
        discord_user_id: "eq." + candidate.discord_user_id,
        status: "eq.approved",
        start_date: "lte." + riyadhDateKey(new Date()),
        end_date: "gte." + riyadhDateKey(new Date()),
        select: "id",
        limit: "1"
      });
      const liveLeaveResponse = await db(cfg, "attendance_leave_requests?" + liveLeaveQuery.toString());
      if (!liveLeaveResponse.ok) throw new Error("تعذّر التحقق من الإجازة الحالية قبل الإجراء التأديبي.");
      if ((await liveLeaveResponse.json()).length) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }

      // Re-check the stamp immediately before any role or disciplinary change.
      const finalStamp = await latestAttendanceForMember(cfg, candidate.discord_user_id);
      const finalAbsence = elapsedAbsenceDays(
        finalStamp,
        candidate.registered_at,
        dashboard.attendance_started_at,
        new Date()
      );
      if (finalAbsence.days < stage * 7 || finalAbsence.startedAt !== absence.startedAt) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }

      const action = await applyAutomaticAttendanceAction(
        cfg, actor, candidate.discord_user_id, stage, finalAbsence.days, finalAbsence.startedAt
      );
      if (action.skipped) {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: true, p_error_code: null
        });
        continue;
      }
      await rpc(cfg, "complete_swat_attendance_discipline", {
        p_event_key: eventKey, p_success: true, p_error_code: null
      });
      processed++;
      if (stage === 3) dismissed++;
      else warnings++;
      results.push({
        discord_user_id: candidate.discord_user_id,
        stage,
        action_type: action.action_type,
        action_id: action.action_id,
        dm_status: action.dm_status
      });
    } catch (error) {
      failed++;
      const code = String(error.code || error.detail || error.message || "attendance_disciplinary_failed").slice(0, 120);
      try {
        await rpc(cfg, "complete_swat_attendance_discipline", {
          p_event_key: eventKey, p_success: false, p_error_code: code
        });
      } catch (claimError) {
        console.error("Attendance discipline claim release failed:", claimError?.detail || claimError?.message || "unknown");
      }
      results.push({
        discord_user_id: candidate.discord_user_id,
        stage,
        status: "retry_scheduled",
        error: code
      });
    }
  }
  return {
    ok: failed === 0,
    scanned: dashboard.total_members,
    due: candidates.length,
    processed,
    warnings,
    dismissed,
    failed,
    results
  };
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
      throw Object.assign(new Error("The member cannot be fired because the bot cannot remove these roles: " + names + ". Move the bot higher or remove managed roles manually first."), { status: 409 });
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
async function syncWarningLevel(cfg, targetId, desiredLevel) {
  if (![0,1,2].includes(Number(desiredLevel))) {
    throw Object.assign(new Error("مستوى الإنذار المطلوب غير صالح."), { status: 400 });
  }
  const [member, guild] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId),
    loadGuildRoleData(cfg)
  ]);
  const originalRoles = [...(member.roles || [])];
  const current = new Set(originalRoles);
  const warningIds = [...new Set(Object.values(cfg.warningRoles))];
  for (const id of warningIds) {
    const role = guild.byId.get(id);
    if (!role || role.managed || role.position >= guild.botTop.position) {
      throw Object.assign(new Error("لا يستطيع البوت إدارة رتب التحذيرات الحالية. راجع ترتيب الرتب وصلاحيات البوت."), { status: 409 });
    }
    current.delete(id);
  }
  if (Number(desiredLevel) > 0) current.add(cfg.warningRoles[Number(desiredLevel)]);
  const roles = [...current];
  await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
    method: "PATCH", body: JSON.stringify({ roles })
  });
  return {
    member, originalRoles, appliedRoles: roles,
    removedWarningRoleCount: originalRoles.filter(id => warningIds.includes(id)).length
  };
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
  const actionLabel = dismissed ? "FIRED" : "WARNING " + level;
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
    title: dismissed ? "⛔ MEMBER FIRED" : "⚠️ OFFICIAL " + actionLabel,
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
    body: JSON.stringify({ embeds: [embed], components: portalLinkComponents(), allowed_mentions: { parse: [] } })
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
function portalLinkComponents() {
  const configuredHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.SITE_URL || "swat-redline.vercel.app";
  const url = /^https?:\/\//i.test(configuredHost) ? configuredHost : "https://" + configuredHost;
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 5,
      label: "فتح بوابة S.W.A.T. REDLINE",
      url
    }]
  }];
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
      components: portalLinkComponents(),
      allowed_mentions: {
        parse: [],
        roles: mentionSettings.swatRoleMentionEnabled ? [cfg.notificationRoleId] : [],
        users: mentionSettings.targetMentionEnabled ? [targetId] : []
      }
    })
  });
}
async function appendAttendanceAdminAudit(cfg, user, event) {
  const row = await db(cfg, "audit_logs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      actor_discord_id: user.id,
      actor_name: user.displayName,
      action: event.action || "update",
      entity_type: event.entity_type || "attendance",
      entity_id: event.entity_id || null,
      details: event.details || {}
    })
  });
  if (!row.ok) {
    console.error("Attendance administration audit append failed:", row.status);
    return false;
  }
  await forwardAuditToDiscord(user, event);
  return true;
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
      const expiry = await processExpiredWarningRoles(cronCfg);
      const attendance = await processAutomaticAttendanceDiscipline(cronCfg);
      return json(res, 200, {
        ok: expiry.ok !== false && attendance.ok !== false,
        warning_role_expiry: expiry,
        attendance_discipline: attendance
      });
    } catch (error) {
      console.error("Warning/attendance automation cron failed:", error?.detail || error?.message || "unknown");
      return json(res, 502, { error: "فشلت معالجة انتهاء صلاحية الإنذارات أو إجراءات الغياب التلقائية." });
    }
  }
  const user = readSession(req);
  if (!user) return json(res, 401, { error: "يجب تسجيل الدخول أولًا." });
  const cfg = config();
  if (cfg.error) return json(res, 503, { error: cfg.error });
  try {
    const params = new URL(req.url, "https://portal.invalid").searchParams;
    if (req.method === "GET" && params.get("diagnostics") === "1") {
      await requireManager(cfg, user);
      const diagnostics = await warningDiagnostics(cfg, user);
      return json(res, 200, diagnostics);
    }
    await requireManager(cfg, user);
    if (req.method === "GET" && new URL(req.url, "https://portal.invalid").searchParams.get("access") === "1") {
      return json(res, 200, { authorized: true });
    }
    if (req.method === "GET" && params.get("attendance") === "1") {
      const data = await listAttendanceDashboard(cfg);
      return json(res, 200, data);
    }
    if (req.method === "GET" && params.get("leave_requests") === "1") {
      const q = new URLSearchParams({
        select: "id,discord_user_id,display_name,reason,start_date,end_date,status,reviewed_by_discord_id,reviewed_by_name,review_note,reviewed_at,created_at",
        order: "created_at.desc",
        limit: "500"
      });
      const response = await db(cfg, "attendance_leave_requests?" + q.toString());
      if (!response.ok) throw new Error("تعذّر تحميل طلبات الإجازة.");
      return json(res, 200, { requests: await response.json() });
    }
    if (req.method === "GET") {
      const data = await listData(cfg, params.get("include_archived") === "1");
      return json(res, 200, data);
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "طريقة الطلب غير مسموح بها." });
    }
    if (!requireSameOrigin(req, res)) return;
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});

    if (body.action === "save_attendance_exemptions") {
      const selectedIds = Array.isArray(body.discord_user_ids)
        ? [...new Set(body.discord_user_ids.map(value => String(value || "")))]
        : null;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!selectedIds || selectedIds.length > 100 || selectedIds.some(id => !/^\d{15,22}$/.test(id)) ||
          reason.length > 1000) {
        return json(res, 400, { error: "قائمة الأعضاء أو سبب الإعفاء غير صالح." });
      }
      const staffQuery = new URLSearchParams({
        select: "discord_user_id,display_name,username,is_active,is_banned",
        is_active: "eq.true",
        is_banned: "eq.false",
        order: "display_name.asc",
        limit: "1000"
      });
      const [staffResponse, existingResponse] = await Promise.all([
        db(cfg, "staff_profiles?" + staffQuery.toString()),
        db(cfg, "attendance_exemptions?select=discord_user_id,reason&limit=1000")
      ]);
      if (!staffResponse.ok || !existingResponse.ok) {
        return json(res, 503, { error: "تعذّر تحميل الأعضاء أو إعدادات الإعفاء الحالية." });
      }
      const [staffRows, existingRows] = await Promise.all([staffResponse.json(), existingResponse.json()]);
      const existingById = new Map(existingRows.map(row => [String(row.discord_user_id), row]));
      const membership = await mapConcurrent(staffRows, 8, async profile => {
        const member = await getGuildMemberOrNull(cfg, profile.discord_user_id);
        return member && Array.isArray(member.roles) && member.roles.includes(cfg.swatRoleId)
          ? profile : null;
      });
      const currentSwat = membership.filter(Boolean);
      const currentIds = new Set(currentSwat.map(profile => String(profile.discord_user_id)));
      if (selectedIds.some(id => !currentIds.has(id))) {
        return json(res, 409, { error: "تغيرت عضوية أحد الأشخاص في رتبة S.W.A.T. حدّث القائمة ثم أعد الحفظ." });
      }
      const selected = new Set(selectedIds);
      const updatedAt = new Date().toISOString();
      // Only persist state transitions (or an explicitly supplied reason change).
      // In particular, do not refresh timestamps for unchanged non-exempt staff:
      // their absence clock must never reset when somebody else's exemption is saved.
      const rows = currentSwat.flatMap(profile => {
        const id = String(profile.discord_user_id);
        const enabled = selected.has(id);
        const previous = existingById.get(id);
        const wasEnabled = previous?.enabled === true;
        const reasonChanged = enabled && Boolean(reason) && reason !== String(previous?.reason || "");
        if (!previous && !enabled) return [];
        if (wasEnabled === enabled && !reasonChanged) return [];
        return [{
          discord_user_id: id,
          enabled,
          reason: enabled ? (reason || previous?.reason || "") : (previous?.reason || ""),
          created_by_discord_id: user.id,
          created_by_name: user.displayName,
          updated_at: updatedAt
        }];
      });
      if (rows.length) {
        const saveResponse = await db(cfg, "attendance_exemptions?on_conflict=discord_user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(rows)
        });
        if (!saveResponse.ok) {
          console.error("Attendance exemptions batch save failed:", saveResponse.status, (await saveResponse.text()).slice(0,300));
          return json(res, 502, { error: "تعذّر حفظ إعدادات الإعفاء." });
        }
      }
      await appendAttendanceAdminAudit(cfg, user, {
        action: "update",
        entity_type: "attendance_exemptions",
        entity_id: "swat-members",
        details: {
          type: "تحديث قائمة المعفيين من البصمة",
          detail: "تم تحديث إعدادات إعفاء البصمة. عدد المعفيين الحالي: " + selected.size + ".",
          exempt_member_ids: selectedIds,
          exempt_count: selected.size
        }
      });
      return json(res, 200, { ok: true, exempt_count: selected.size, managed_members: rows.length });
    }

    if (body.action === "set_attendance_exemption") {
      const targetId = String(body.discord_user_id || "");
      const enabled = body.enabled === true;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!/^\d{15,22}$/.test(targetId) || reason.length > 1000) {
        return json(res, 400, { error: "راجع معرّف العضو وسبب الإعفاء." });
      }
      if (targetId === process.env.DISCORD_OWNER_ID) {
        return json(res, 403, { error: "لا يمكن تغيير حالة إعفاء المالك المحمي." });
      }
      const profileQuery = new URLSearchParams({
        discord_user_id: "eq." + targetId,
        select: "discord_user_id,display_name,username,is_active,is_banned",
        limit: "1"
      });
      const profileResponse = await db(cfg, "staff_profiles?" + profileQuery.toString());
      if (!profileResponse.ok) return json(res, 503, { error: "تعذّر التحقق من ملف العضو." });
      const profile = (await profileResponse.json())[0];
      if (!profile || profile.is_active !== true || profile.is_banned === true) {
        return json(res, 404, { error: "لا يمكن إدارة الإعفاء إلا لعضو S.W.A.T نشط." });
      }
      const discordMember = await getGuildMemberOrNull(cfg, targetId);
      if (!discordMember || !Array.isArray(discordMember.roles) || !discordMember.roles.includes(cfg.swatRoleId)) {
        return json(res, 409, { error: "العضو لا يحمل رتبة S.W.A.T الحالية في Discord." });
      }
      const now = new Date().toISOString();
      const writeResponse = enabled
        ? await db(cfg, "attendance_exemptions?on_conflict=discord_user_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=representation" },
            body: JSON.stringify({
              discord_user_id: targetId,
              reason,
              enabled: true,
              created_by_discord_id: user.id,
              created_by_name: user.displayName,
              updated_at: now
            })
          })
        : await db(cfg, "attendance_exemptions?discord_user_id=eq." + targetId + "&enabled=eq.true", {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              enabled: false,
              created_by_discord_id: user.id,
              created_by_name: user.displayName,
              updated_at: now
            })
          });
      if (!writeResponse.ok) {
        console.error("Attendance exemption save failed:", writeResponse.status, (await writeResponse.text()).slice(0,300));
        return json(res, 502, { error: "تعذّر حفظ إعداد الإعفاء." });
      }
      await appendAttendanceAdminAudit(cfg, user, {
        action: "update",
        entity_type: "attendance_exemption",
        entity_id: targetId,
        details: {
          type: enabled ? "تفعيل إعفاء البصمة" : "إلغاء إعفاء البصمة",
          detail: (enabled ? "تم إعفاء " : "تم إلغاء إعفاء ") + (profile.display_name || profile.username || targetId) + " من إلزامية البصمة.",
          target_discord_id: targetId,
          enabled,
          reason
        }
      });
      return json(res, 200, { ok: true, discord_user_id: targetId, enabled });
    }

    if (body.action === "create_attendance_leave") {
      const targetId = String(body.discord_user_id || "");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      const startDate = String(body.start_date || "");
      const endDate = String(body.end_date || "");
      const isValidDate = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(value + "T00:00:00.000Z");
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
      };
      if (!/^\d{15,22}$/.test(targetId) || reason.length < 3 || reason.length > 1000 ||
          !isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
        return json(res, 400, { error: "راجع العضو وسبب الإجازة وتاريخ البداية والنهاية." });
      }
      const profileQuery = new URLSearchParams({
        discord_user_id: "eq." + targetId,
        select: "discord_user_id,display_name,username,is_active,is_banned",
        limit: "1"
      });
      const profileResponse = await db(cfg, "staff_profiles?" + profileQuery.toString());
      if (!profileResponse.ok) return json(res, 503, { error: "تعذّر التحقق من ملف العضو." });
      const profile = (await profileResponse.json())[0];
      if (!profile || profile.is_active !== true || profile.is_banned === true) {
        return json(res, 404, { error: "لا يمكن تسجيل إجازة إلا لعضو S.W.A.T نشط." });
      }
      const discordMember = await getGuildMemberOrNull(cfg, targetId);
      if (!discordMember || !Array.isArray(discordMember.roles) || !discordMember.roles.includes(cfg.swatRoleId)) {
        return json(res, 409, { error: "العضو لا يحمل رتبة S.W.A.T الحالية في Discord." });
      }
      const insertResponse = await db(cfg, "attendance_leave_requests", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          discord_user_id: targetId,
          display_name: profile.display_name || profile.username || "SWAT Member",
          reason,
          start_date: startDate,
          end_date: endDate,
          status: "pending"
        })
      });
      if (!insertResponse.ok) {
        console.error("Attendance leave creation failed:", insertResponse.status, (await insertResponse.text()).slice(0,300));
        return json(res, 502, { error: "تعذّر تسجيل طلب الإجازة." });
      }
      const created = (await insertResponse.json())[0];
      await appendAttendanceAdminAudit(cfg, user, {
        action: "create",
        entity_type: "attendance_leave_request",
        entity_id: created?.id || targetId,
        details: {
          type: "تسجيل طلب إجازة",
          detail: "تم تسجيل طلب إجازة لـ " + (profile.display_name || profile.username || targetId) + ".",
          target_discord_id: targetId,
          start_date: startDate,
          end_date: endDate
        }
      });
      return json(res, 200, { ok: true, request: created });
    }

    if (body.action === "review_attendance_leave") {
      const requestId = String(body.id || "");
      const status = String(body.status || "");
      const note = typeof body.review_note === "string" ? body.review_note.trim() : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
          !["approved","rejected"].includes(status) || note.length > 1000) {
        return json(res, 400, { error: "بيانات مراجعة الإجازة غير صحيحة." });
      }
      const updateResponse = await db(cfg, "attendance_leave_requests?id=eq." + encodeURIComponent(requestId) + "&status=eq.pending", {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status,
          reviewed_by_discord_id: user.id,
          reviewed_by_name: user.displayName,
          review_note: note || null,
          reviewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      if (!updateResponse.ok) {
        console.error("Attendance leave review failed:", updateResponse.status, (await updateResponse.text()).slice(0,300));
        return json(res, 502, { error: "تعذّر حفظ قرار الإجازة." });
      }
      const updated = (await updateResponse.json())[0];
      if (!updated) return json(res, 409, { error: "تمت مراجعة هذا الطلب بالفعل أو لم يعد موجودًا." });
      await forwardAuditToDiscord(user, {
        action: "update",
        entity_type: "attendance_leave_request",
        entity_id: requestId,
        details: {
          type: status === "approved" ? "قبول طلب إجازة" : "رفض طلب إجازة",
          detail: (status === "approved" ? "تمت الموافقة على إجازة " : "تم رفض إجازة ") + updated.display_name + ".",
          target_discord_id: updated.discord_user_id,
          status,
          review_note: note
        }
      });
      return json(res, 200, { ok: true, request: updated });
    }

    if (body.action === "archive_subject" || body.action === "restore_subject") {
      const targetId = String(body.discord_user_id || "");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      const shouldArchive = body.action === "archive_subject";
      if (!/^\d{15,22}$/.test(targetId) || !reason || reason.length > 1000) {
        return json(res, 400, { error: "راجع معرّف العضو وسبب إزالة العضو من القائمة." });
      }
      if (targetId === process.env.DISCORD_OWNER_ID) {
        return json(res, 403, { error: "لا يمكن إزالة مالك السيرفر المحمي من قائمة الحالات." });
      }
      try {
        const result = await rpc(cfg, "set_disciplinary_subject_archive", {
          p_discord_user_id: targetId,
          p_is_archived: shouldArchive,
          p_reason: reason,
          p_actor_discord_id: user.id,
          p_actor_name: user.displayName
        });
        await forwardAuditToDiscord(user, {
          action: "update",
          entity_type: "disciplinary_subject",
          entity_id: targetId,
          details: {
            type: shouldArchive ? "إزالة عضو من قائمة الحالات" : "استعادة عضو إلى قائمة الحالات",
            detail: (shouldArchive ? "تمت إزالة " : "تمت استعادة ") + targetId + (shouldArchive ? " من قائمة الحالات الحالية مع الاحتفاظ بالتاريخ." : " إلى قائمة الحالات الحالية."),
            target_discord_id: targetId,
            reason
          }
        });
        return json(res, 200, { ok: true, is_archived: result.is_archived, before: result.before, after: result.after });
      } catch (error) {
        return json(res, error.status || 502, {
          error: error.message || "تعذّر تحديث ظهور العضو في قائمة الحالات."
        });
      }
    }

    if (body.action === "adjust_state") {
      const targetId = String(body.discord_user_id || "");
      const desiredLevel = Number(body.warning_level);
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      const requestedName = typeof body.display_name === "string" ? body.display_name.trim() : "";
      if (!/^\d{15,22}$/.test(targetId) || ![0,1,2].includes(desiredLevel) ||
          !reason || reason.length > 1000 || requestedName.length > 100) {
        return json(res, 400, { error: "راجع معرّف العضو والحالة وسبب التعديل." });
      }
      if (targetId === process.env.DISCORD_OWNER_ID) {
        return json(res, 403, { error: "لا يمكن تعديل الحالة التأديبية للمالك المحمي." });
      }
      const target = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId);
      const targetName = requestedName || discordName(target);
      const targetAvatar = discordAvatarUrl(target, cfg.guildId);
      const desiredStatus = "active";
      const expiresAt = desiredLevel === 1 || desiredLevel === 2
        ? new Date(Date.now() + warningValidityDays(desiredLevel) * 24 * 60 * 60 * 1000).toISOString()
        : null;
      let roleResult;
      try {
        roleResult = await syncWarningLevel(cfg, targetId, desiredLevel);
      } catch (error) {
        return json(res, error.status || 502, { error: error.message || "تعذّر تعديل رتب العضو في Discord." });
      }
      try {
        const result = await rpc(cfg, "set_disciplinary_subject_state", {
          p_discord_user_id: targetId,
          p_display_name: targetName,
          p_username: target.user?.username || "",
          p_avatar_url: targetAvatar,
          p_warning_level: desiredLevel,
          p_status: desiredStatus,
          p_reason: reason,
          p_warning_expires_at: expiresAt,
          p_actor_discord_id: user.id,
          p_actor_name: user.displayName
        });
        await forwardAuditToDiscord(user,{action:"update",entity_type:"disciplinary_subject",entity_id:targetId,
          details:{type:"تعديل حالة التحذيرات",detail:"تم تعديل حالة التحذيرات للفرد "+targetName+" إلى المستوى "+desiredLevel+".",target_discord_id:targetId}});
        return json(res, 200, {
          ok: true,
          discord_roles_updated: true,
          state: { warning_level: desiredLevel, status: desiredStatus, warning_expires_at: expiresAt },
          before: result.before,
          removed_warning_role_count: roleResult.removedWarningRoleCount ?? roleResult.removedRoleCount ?? 0
        });
      } catch (error) {
        let rollbackFailed = false;
        try { await restoreMemberRoles(cfg, targetId, roleResult.originalRoles); }
        catch (rollbackError) {
          rollbackFailed = true;
          console.error("Role rollback failed after disciplinary state save failure:", rollbackError.code || rollbackError.message);
        }
        return json(res, 502, {
          error: rollbackFailed
            ? "فشل حفظ الحالة وفشل التراجع عن رتب Discord. يلزم فحص العضو يدويًا."
            : "تعذّر حفظ التعديل في سجل الموقع. تم التراجع عن تغيير رتب Discord.",
          rollback_failed: rollbackFailed
        });
      }
    }

    if (body.action === "void_action") {
      const actionId = String(body.action_id || "");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId) ||
          !reason || reason.length > 1000) {
        return json(res, 400, { error: "راجع رقم الإجراء وسبب الإلغاء." });
      }

      const actionResponse = await db(cfg,
        "disciplinary_actions?id=eq." + encodeURIComponent(actionId) +
        "&select=id,discord_user_id,target_name,action_type,warning_level,status,dm_channel_id,dm_message_id,channel_message_id&limit=1");
      if (!actionResponse.ok) return json(res, 503, { error: "تعذّر تحميل سجل التحذير المطلوب إلغاؤه." });
      const records = await actionResponse.json();
      const record = records[0];
      if (!record || record.status !== "completed" || record.action_type !== "warning") {
        return json(res, 404, { error: "سجل التحذير غير موجود أو سبق إلغاؤه أو لا يمكن إلغاؤه من هذه الشاشة." });
      }
      if (record.discord_user_id === process.env.DISCORD_OWNER_ID) {
        return json(res, 403, { error: "لا يمكن إلغاء إجراء يخص مالك السيرفر المحمي." });
      }

      let result;
      try {
        result = await rpc(cfg, "void_disciplinary_action_record", {
          p_action_id: actionId,
          p_reason: reason,
          p_actor_discord_id: user.id,
          p_actor_name: user.displayName
        });
      } catch (error) {
        console.error("Disciplinary warning void RPC failed:", error?.detail || error?.message || "unknown");
        return json(res, 502, { error: "تعذّر إلغاء سجل التحذير في قاعدة البيانات." });
      }

      let rolesSynced = true;
      let roleSyncError = null;
      if (result.was_current) {
        try {
          if (result.subject_state?.status === "dismissed") {
            await updateMemberRoles(cfg, record.discord_user_id, 3, true);
          } else {
            await syncWarningLevel(cfg, record.discord_user_id, Number(result.subject_state?.warning_level || 0));
          }
        } catch (error) {
          rolesSynced = false;
          roleSyncError = String(error.code || error.message || "warning_role_sync_failed").slice(0, 120);
          console.error("Warning role sync after void failed:", roleSyncError);
        }
      }

      let deletedChannelMessage = false;
      let deletedDmMessage = false;
      const messageDeleteFailures = [];
      if (record.channel_message_id) {
        try {
          await discord(cfg, "/channels/" + cfg.channelId + "/messages/" + record.channel_message_id, { method: "DELETE" });
          deletedChannelMessage = true;
        } catch (error) {
          if (Number(error?.status) !== 404) {
            messageDeleteFailures.push({ message: "channel", code: String(error.code || error.status || "delete_failed").slice(0, 80) });
          } else {
            deletedChannelMessage = true;
          }
        }
      }
      if (record.dm_channel_id && record.dm_message_id) {
        try {
          await discord(cfg, "/channels/" + record.dm_channel_id + "/messages/" + record.dm_message_id, { method: "DELETE" });
          deletedDmMessage = true;
        } catch (error) {
          if (Number(error?.status) !== 404) {
            messageDeleteFailures.push({ message: "dm", code: String(error.code || error.status || "delete_failed").slice(0, 80) });
          } else {
            deletedDmMessage = true;
          }
        }
      }

      await forwardAuditToDiscord(user, {
        action: "delete",
        entity_type: "disciplinary_action",
        entity_id: actionId,
        details: {
          type: "إلغاء سجل تحذير",
          detail: "تم إلغاء سجل التحذير للعضو " + (record.target_name || record.discord_user_id) + ".",
          target_discord_id: record.discord_user_id,
          void_reason: reason,
          roles_synced: rolesSynced,
          discord_message_delete_failures: messageDeleteFailures
        }
      });

      return json(res, 200, {
        ok: true,
        voided: true,
        was_current: Boolean(result.was_current),
        subject_state: result.subject_state || null,
        roles_synced: rolesSynced,
        role_sync_error: roleSyncError,
        deleted_channel_message: deletedChannelMessage,
        deleted_dm_message: deletedDmMessage,
        message_delete_failures: messageDeleteFailures
      });
    }

    if (body.action === "edit_action") {
      const actionId = String(body.action_id || "");
      const targetName = typeof body.target_name === "string" ? body.target_name.trim() : "";
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      const details = typeof body.details === "string" ? body.details.trim() : "";
      const requestedLevel = Number(body.warning_level);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId) ||
          !targetName || targetName.length > 100 || ![1,2].includes(requestedLevel) ||
          !reason || reason.length > 1000 || details.length > 3000) {
        return json(res, 400, { error: "راجع اسم العضو ومستوى الإنذار والسبب والتفاصيل." });
      }

      const actionResponse = await db(cfg,
        "disciplinary_actions?id=eq." + encodeURIComponent(actionId) +
        "&select=id,discord_user_id,target_name,action_type,warning_level,reason,details,actor_name,status,dm_channel_id,dm_message_id,channel_message_id,warning_expires_at,expired_at,completed_at&limit=1");
      if (!actionResponse.ok) return json(res, 503, { error: "تعذّر تحميل السجل المطلوب تعديله." });
      const actionRows = await actionResponse.json();
      const record = actionRows[0];
      if (!record || record.status !== "completed" || record.action_type !== "warning") {
        return json(res, 404, { error: "سجل الإنذار غير موجود أو سبق إلغاؤه أو لا يمكن تعديله." });
      }
      if (record.discord_user_id === process.env.DISCORD_OWNER_ID) {
        return json(res, 403, { error: "لا يمكن تعديل سجل يخص مالك السيرفر المحمي." });
      }

      const subjectResponse = await db(cfg,
        "disciplinary_subjects?discord_user_id=eq." + encodeURIComponent(record.discord_user_id) +
        "&select=avatar_url,display_name,warning_level,status,last_action_at,warning_expires_at&limit=1");
      if (!subjectResponse.ok) return json(res, 503, { error: "تعذّر تحميل بيانات العضو." });
      const subjectRows = await subjectResponse.json();
      const subject = subjectRows[0] || {};
      const wasCurrent =
        subject.status === "active" &&
        Number(subject.warning_level) === Number(record.warning_level) &&
        subject.last_action_at && record.completed_at &&
        Date.parse(subject.last_action_at) === Date.parse(record.completed_at) &&
        !record.expired_at &&
        (!record.warning_expires_at || Date.parse(record.warning_expires_at) > Date.now());

      const newExpiry = wasCurrent
        ? new Date(Date.now() + warningValidityDays(requestedLevel) * 24 * 60 * 60 * 1000).toISOString()
        : record.warning_expires_at || null;

      let roleResult = null;
      if (wasCurrent) {
        try {
          roleResult = await syncWarningLevel(cfg, record.discord_user_id, requestedLevel);
        } catch (error) {
          return json(res, error.status || 502, {
            error: error.message || "تعذّر مزامنة رتبة الإنذار المطلوبة في Discord. لم يتم تعديل سجل الموقع."
          });
        }
      }

      let databaseResult;
      try {
        databaseResult = await rpc(cfg, "edit_disciplinary_action_record_v2", {
          p_action_id: actionId,
          p_target_name: targetName,
          p_warning_level: requestedLevel,
          p_reason: reason,
          p_details: details,
          p_warning_expires_at: newExpiry,
          p_actor_discord_id: user.id,
          p_actor_name: user.displayName
        });
      } catch (error) {
        let rollbackFailed = false;
        if (roleResult?.originalRoles) {
          try { await restoreMemberRoles(cfg, record.discord_user_id, roleResult.originalRoles); }
          catch (rollbackError) {
            rollbackFailed = true;
            console.error("Warning role rollback after record edit failed:", rollbackError.code || rollbackError.message);
          }
        }
        return json(res, 502, {
          error: rollbackFailed
            ? "فشل حفظ التعديل وتعذّر استعادة رتب Discord. يلزم فحص العضو يدويًا."
            : "تعذّر حفظ تعديل سجل التحذير. لم تُعتمد التغييرات.",
          rollback_failed: rollbackFailed
        });
      }

      const targetProfile = {
        id: record.discord_user_id,
        name: targetName,
        avatarUrl: subject.avatar_url || null
      };
      const expiresAt = databaseResult.warning_expires_at || newExpiry;
      const revisedEmbed = disciplinaryNoticeEmbed("warning", requestedLevel, targetProfile, reason, details, record.actor_name, record.id, expiresAt);
      const channelPath = record.channel_message_id
        ? "/channels/" + cfg.channelId + "/messages/" + record.channel_message_id
        : null;
      const dmPath = record.dm_channel_id && record.dm_message_id
        ? "/channels/" + record.dm_channel_id + "/messages/" + record.dm_message_id
        : null;
      let channelUpdated = false;
      let dmUpdated = false;
      const discordMessageFailures = [];
      for (const [kind, path] of [["channel",channelPath],["dm",dmPath]]) {
        if (!path) continue;
        try {
          await discord(cfg, path, { method: "PATCH", body: JSON.stringify({ embeds: [revisedEmbed] }) });
          if (kind === "channel") channelUpdated = true;
          else dmUpdated = true;
        } catch (error) {
          discordMessageFailures.push({
            message: kind,
            code: String(error.code || error.status || "message_update_failed").slice(0, 80)
          });
        }
      }

      await forwardAuditToDiscord(user, {
        action: "update",
        entity_type: "disciplinary_action",
        entity_id: actionId,
        details: {
          type: "تعديل سجل تحذير",
          detail: "تم تعديل اسم العضو ومستوى التحذير وبيانات الإجراء التأديبي للفرد " + targetName + ".",
          target_discord_id: record.discord_user_id,
          was_current: Boolean(databaseResult.was_current),
          discord_message_failures: discordMessageFailures
        }
      });

      return json(res, 200, {
        ok: true,
        action_id: actionId,
        was_current: Boolean(databaseResult.was_current),
        subject_warning_level: databaseResult.subject_warning_level,
        warning_expires_at: databaseResult.warning_expires_at,
        discord_messages_updated: channelUpdated || dmUpdated,
        discord_message_failures: discordMessageFailures,
        discord_roles_updated: Boolean(roleResult)
      });
    }

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
    let dmAllowed;
    try {
      dmAllowed = await memberPrivateNotificationsEnabled(cfg, targetId);
    } catch (preferenceError) {
      return json(res, preferenceError.status || 503, { error: preferenceError.message || "تعذّر التحقق من تفضيلات الرسائل الخاصة؛ لم يتم إرسال أي رسالة." });
    }

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

    if (dmAllowed) {
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
      if (dmResult) {
        try { await deleteDirectNotice(cfg, dmResult); }
        catch (deleteError) { console.error("Could not withdraw private notice after channel failure:", deleteError.code || deleteError.message); }
      }
      await rpc(cfg, "complete_disciplinary_action_v2", {
        p_action_id: start.action_id, p_role_sync_status: rollbackFailed ? "succeeded" : "failed",
        p_dm_status: dmResult ? "failed" : "skipped",
        p_dm_channel_id: dmResult?.channelId || null, p_dm_message_id: dmResult?.messageId || null,
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
      p_dm_status: dmResult ? "sent" : "skipped",
      p_dm_channel_id: dmResult?.channelId || null,
      p_dm_message_id: dmResult?.messageId || null,
      p_channel_status: "sent",
      p_channel_message_id: channelMessage.id || null,
      p_warning_expires_at: expiresAt,
      p_error_code: null
    });
    await forwardAuditToDiscord(user,{action:"create",entity_type:"disciplinary_action",entity_id:start.action_id,
      details:{type:actionType==="dismissal"?"فصل عضو":"إصدار تحذير",
        detail:(actionType==="dismissal"?"تم فصل ":"تم إصدار إنذار للمستخدم ")+targetName+(actionType==="warning"?" • المستوى "+level:"")+".",
        target_discord_id:targetId}});
    return json(res, 200, {
      ok: true, status: completion.status, action_id: start.action_id,
      dm_status: dmResult ? "sent" : "skipped",
      dm_message_id: dmResult?.messageId || null,
      channel_status: "sent", channel_message_id: channelMessage.id || null,
      warning_level: level, action_type: actionType, expires_at: expiresAt
    });
  } catch (error) {
    console.error("Warnings API failed:", error?.detail || error?.message || "unknown");
    return json(res, error.status || 502, { error: error.message || "Warnings service failed." });
  }
}
