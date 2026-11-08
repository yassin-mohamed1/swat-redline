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
  const warningRoles = {
    1: process.env.DISCORD_WARNING_ROLE_1_ID,
    2: process.env.DISCORD_WARNING_ROLE_2_ID
  };
  if (!base || !key || !token || !guildId || !channelId || !managerRoleId ||
      WARNING_LEVELS.some(level => !/^\d{15,22}$/.test(String(warningRoles[level] || "")))) {
    return { error: "Warnings integration is not fully configured." };
  }
  return { base, key, token, guildId, channelId, managerRoleId, botRoleId, warningRoles };
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
    const error = new Error("Database operation failed.");
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
    const e = new Error("discord_api_error");
    e.status = r.status;
    e.code = String(data.code || r.status);
    throw e;
  }
  return data;
}
function discordName(member) {
  return member.nick || member.user?.global_name || member.user?.username || "Discord user";
}
async function requireActiveStaff(cfg, user) {
  if (user.isOwner) return;
  const q = new URLSearchParams({ discord_user_id: "eq." + user.id, select: "is_active,is_banned", limit: "1" });
  const profile = await db(cfg, "staff_profiles?" + q);
  if (!profile.ok) throw Object.assign(new Error("Could not verify staff account."), { status: 503 });
  const rows = await profile.json();
  if (!rows[0] || rows[0].is_active === false || rows[0].is_banned) {
    throw Object.assign(new Error("Active staff profile required."), { status: 403 });
  }
}
async function requireManager(cfg, user) {
  await requireActiveStaff(cfg, user);
  if (user.isOwner) return;
  const member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + user.id);
  if (!Array.isArray(member.roles) || !member.roles.includes(cfg.managerRoleId)) {
    throw Object.assign(new Error("Your Discord account does not have the Warnings management role (ID: " + cfg.managerRoleId + "). Assign this role to your account to issue warnings."), { status: 403 });
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
  if (!staffResponse.ok || !subjectResponse.ok || !actionResponse.ok) throw new Error("Could not load warning records.");
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
  if (!botTop) throw Object.assign(new Error("Bot role could not be identified in this server."), { status: 503 });
  if (cfg.botRoleId && (!byId.has(cfg.botRoleId) || !(botMember.roles || []).includes(cfg.botRoleId))) {
    throw Object.assign(new Error("The configured Discord bot role is missing or is not assigned to the bot account. Check DISCORD_BOT_ROLE_ID."), { status: 503 });
  }
  return { roles, byId, botTop };
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
    if (!role) throw Object.assign(new Error("The selected Warning role does not exist in this Discord server."), { status: 503 });
    if (unmanageableWarningRoles.length) {
      throw Object.assign(new Error("Move the bot role above Warning 1 and Warning 2 in Discord Server Settings > Roles."), { status: 409 });
    }
    for (const id of warningIds) current.delete(id);
    current.add(targetRole);
  } else {
    if (targetId === process.env.DISCORD_OWNER_ID) {
      throw Object.assign(new Error("The protected server owner cannot be dismissed."), { status: 403 });
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
function disciplinaryNoticeEmbed(action, level, target, reason, details, actor, actionId, expiresAt) {
  const dismissed = action === "dismissal";
  const fields = [
    { name: "Member", value: String(target.name || "Discord user").slice(0, 200), inline: true },
    { name: "Discord ID", value: target.id, inline: true },
    { name: "Decision", value: dismissed ? "DISMISSAL" : "WARNING " + level, inline: true },
    { name: "Reason", value: String(reason).slice(0, 1000), inline: false },
    ...(details ? [{ name: "Additional Details", value: String(details).slice(0, 1000), inline: false }] : []),
    { name: "Issued By", value: String(actor).slice(0, 150), inline: true },
    { name: "Reference", value: String(actionId), inline: true }
  ];
  if (dismissed) fields.push({ name: "Status", value: "Membership dismissed; removable server roles revoked.", inline: false });
  else {
    fields.push({ name: "Validity", value: "30 days", inline: true });
    fields.push({ name: "Expires", value: new Date(expiresAt).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) + " (Riyadh time)", inline: true });
  }
  return {
    author: { name: "S.W.A.T. REDLINE • OFFICIAL DISCIPLINARY RECORD" },
    title: dismissed ? "⛔ MEMBER DISMISSED" : "⚠️ OFFICIAL WARNING " + level,
    description: dismissed
      ? "An official dismissal decision has been registered by S.W.A.T. REDLINE."
      : "An official disciplinary warning has been issued and registered.",
    color: dismissed ? 0xB4232D : 0xD99A24,
    fields,
    footer: { text: "S.W.A.T. REDLINE • DISCIPLINARY & COMPLIANCE" },
    timestamp: new Date().toISOString()
  };
}
async function sendDirectNotice(cfg, targetId, embed) {
  const dm = await discord(cfg, "/users/@me/channels", {
    method: "POST", body: JSON.stringify({ recipient_id: targetId })
  });
  if (!dm?.id) throw Object.assign(new Error("Discord did not create a private channel for this member."), { code: "dm_channel_missing" });
  const sent = await discord(cfg, "/channels/" + dm.id + "/messages", {
    method: "POST",
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
  });
  if (!sent?.id) throw Object.assign(new Error("Discord did not confirm the private message."), { code: "dm_message_missing" });
  return { channelId: dm.id, messageId: sent.id };
}
async function deleteDirectNotice(cfg, dm) {
  if (!dm?.channelId || !dm?.messageId) return;
  await discord(cfg, "/channels/" + dm.channelId + "/messages/" + dm.messageId, { method: "DELETE" });
}
function announcementEmbed(action, level, target, reason, details, actor, actionId, expiresAt) {
  const dismissed = action === "dismissal";
  const fields = [
    { name: "Member", value: String(target.name || "Discord user").slice(0, 200), inline: true },
    { name: "Discord ID", value: target.id, inline: true },
    { name: "Disciplinary Action", value: dismissed ? "DISMISSAL" : "WARNING " + level, inline: true },
    { name: "Reason", value: String(reason).slice(0, 1000), inline: false },
    ...(details ? [{ name: "Additional Details", value: String(details).slice(0, 1000), inline: false }] : []),
    { name: "Issued By", value: String(actor).slice(0, 150), inline: true },
    { name: "Reference", value: actionId, inline: true }
  ];
  if (!dismissed) {
    fields.push({ name: "Validity", value: "30 days", inline: true });
    fields.push({ name: "Expires", value: new Date(expiresAt).toLocaleString("en-GB", { timeZone: "Asia/Riyadh", dateStyle: "medium", timeStyle: "short" }) + " (Riyadh time)", inline: true });
  } else fields.push({ name: "Status", value: "Membership dismissed; removable server roles revoked.", inline: false });
  return {
    author: { name: "S.W.A.T. REDLINE • OFFICIAL DISCIPLINARY RECORD" },
    title: dismissed ? "⛔ MEMBER DISMISSED" : "⚠️ OFFICIAL WARNING " + level,
    description: dismissed
      ? "An official dismissal decision has been registered by S.W.A.T. REDLINE."
      : "An official disciplinary warning has been issued and registered.",
    color: dismissed ? 0xB4232D : 0xD99A24,
    fields,
    footer: { text: "S.W.A.T. REDLINE • DISCIPLINARY & COMPLIANCE" },
    timestamp: new Date().toISOString()
  };
}
async function sendAnnouncement(cfg, embed) {
  return discord(cfg, "/channels/" + cfg.channelId + "/messages", {
    method: "POST",
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
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
  const user = readSession(req);
  if (!user) return json(res, 401, { error: "Authentication required." });
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
      return json(res, 405, { error: "Method not allowed." });
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
      return json(res, 400, { error: "Check the member ID, action, reason, and request ID." });
    }
    const target = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId);
    const targetName = discordName(target);
    if (targetId === process.env.DISCORD_OWNER_ID) return json(res, 403, { error: "The protected owner cannot be disciplined through this tool." });

    const start = await rpc(cfg, "begin_disciplinary_action", {
      p_request_id: requestId,
      p_discord_user_id: targetId,
      p_target_name: targetName,
      p_username: target.user?.username || "",
      p_avatar_url: target.user?.avatar ? "https://cdn.discordapp.com/avatars/" + targetId + "/" + target.user.avatar + ".png" : null,
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

    const expiresAt = actionType === "warning" ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
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
        disciplinaryNoticeEmbed(actionType, level, { id: targetId, name: targetName }, reason, details, user.displayName, start.action_id, expiresAt));
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
          ? "The private message failed and role rollback also failed. Manual Discord recovery is required."
          : "The member's private message could not be delivered. The role change was rolled back and the warning/dismissal was not recorded.",
        code: errorCode
      });
    }

    try {
      channelMessage = await sendAnnouncement(cfg,
        announcementEmbed(actionType, level, { id: targetId, name: targetName }, reason, details, user.displayName, start.action_id, expiresAt));
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
        error: "The warnings channel could not receive the notice. The role change was rolled back and the private message was withdrawn where possible.",
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
