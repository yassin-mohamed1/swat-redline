import crypto from "node:crypto";
import { requireSameOrigin } from "../lib/request-security.js";

const DISCORD_API = "https://discord.com/api/v10";
const WARNING_LEVELS = [1, 2, 3];

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
  const warningRoles = {
    1: process.env.DISCORD_WARNING_ROLE_1_ID,
    2: process.env.DISCORD_WARNING_ROLE_2_ID,
    3: process.env.DISCORD_WARNING_ROLE_3_ID
  };
  if (!base || !key || !token || !guildId || !channelId || !managerRoleId ||
      WARNING_LEVELS.some(level => !/^\d{15,22}$/.test(String(warningRoles[level] || "")))) {
    return { error: "Warnings integration is not fully configured." };
  }
  return { base, key, token, guildId, channelId, managerRoleId, warningRoles };
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
async function requireManager(cfg, user) {
  if (user.isOwner) return;
  const q = new URLSearchParams({ discord_user_id: "eq." + user.id, select: "is_active,is_banned", limit: "1" });
  const profile = await db(cfg, "staff_profiles?" + q);
  if (!profile.ok) throw Object.assign(new Error("Could not verify staff account."), { status: 503 });
  const rows = await profile.json();
  if (!rows[0] || rows[0].is_active === false || rows[0].is_banned) {
    throw Object.assign(new Error("Active staff profile required."), { status: 403 });
  }
  const member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + user.id);
  if (!Array.isArray(member.roles) || !member.roles.includes(cfg.managerRoleId)) {
    throw Object.assign(new Error("Warning Manager role required."), { status: 403 });
  }
}
async function listData(cfg) {
  const [staffResponse, subjectResponse, actionResponse] = await Promise.all([
    db(cfg, "staff_profiles?select=discord_user_id,display_name,username,avatar_url,is_active,is_banned&order=display_name.asc"),
    db(cfg, "disciplinary_subjects?select=discord_user_id,display_name,username,avatar_url,warning_level,status,last_reason,last_action_at,created_at,updated_at&order=updated_at.desc"),
    db(cfg, "disciplinary_actions?select=id,discord_user_id,target_name,action_type,warning_level,reason,details,actor_name,status,role_sync_status,channel_status,channel_message_id,created_at&order=created_at.desc&limit=500")
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
  return { roles, byId, botTop };
}
async function updateMemberRoles(cfg, targetId, level, dismiss) {
  const [member, guild] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId),
    loadGuildRoleData(cfg)
  ]);
  const current = new Set(member.roles || []);
  const warningIds = Object.values(cfg.warningRoles);
  if (!dismiss) {
    const targetRole = cfg.warningRoles[level], role = guild.byId.get(targetRole);
    if (!role) throw Object.assign(new Error("A configured warning role does not exist in this Discord server."), { status: 503 });
    if (role.managed || role.position >= guild.botTop.position) {
      throw Object.assign(new Error("Move the bot role above all three warning roles in Discord Server Settings > Roles."), { status: 409 });
    }
    for (const id of warningIds) current.delete(id);
    current.add(targetRole);
  } else {
    if (targetId === process.env.DISCORD_OWNER_ID) {
      throw Object.assign(new Error("The protected server owner cannot be dismissed."), { status: 403 });
    }
    for (const id of current) {
      const role = guild.byId.get(id);
      if (!role || role.managed) continue;
      if (role.position < guild.botTop.position) current.delete(id);
    }
  }
  const roles = [...current];
  await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + targetId, {
    method: "PATCH", body: JSON.stringify({ roles })
  });
  return { member, removedRoleCount: (member.roles || []).filter(id => !current.has(id)).length };
}
function announcementEmbed(action, level, target, reason, details, actor, actionId) {
  const dismissed = action === "dismissal";
  const color = dismissed ? 0xD92735 : level === 3 ? 0xB4232D : 0xD99A24;
  return {
    title: dismissed ? "MEMBER DISMISSED" : "S.W.A.T. DISCIPLINARY WARNING",
    description: dismissed
      ? "A member has been formally dismissed from S.W.A.T. REDLINE."
      : "An official disciplinary warning has been issued.",
    color,
    fields: [
      { name: "Member", value: String(target.name || "Discord user").slice(0, 200), inline: true },
      { name: "Discord ID", value: target.id, inline: true },
      { name: "Warning Level", value: dismissed ? "Warning 3 • Dismissal" : "Warning " + level, inline: true },
      { name: "Reason", value: String(reason).slice(0, 1000), inline: false },
      ...(details ? [{ name: "Details", value: String(details).slice(0, 1000), inline: false }] : []),
      { name: "Issued By", value: String(actor).slice(0, 150), inline: true },
      { name: "Reference", value: actionId, inline: true }
    ],
    footer: { text: "S.W.A.T. REDLINE • DISCIPLINARY RECORD" },
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
    if (!actionType || !/^\d{15,22}$/.test(targetId) || !WARNING_LEVELS.includes(level) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
        !reason || reason.length > 1000 || details.length > 3000) {
      return json(res, 400, { error: "Check the member ID, warning level, reason, and request ID." });
    }
    if (actionType === "dismissal" && level !== 3) return json(res, 400, { error: "Dismissal is only available with Warning 3." });
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

    let roleSyncStatus = "failed", channelStatus = "failed", messageId = null, errorCode = null, roleResult = null;
    try {
      roleResult = await updateMemberRoles(cfg, targetId, level, actionType === "dismissal");
      roleSyncStatus = "succeeded";
    } catch (error) {
      errorCode = String(error.code || error.message || "role_sync_failed").slice(0, 120);
    }
    if (roleSyncStatus === "succeeded") {
      try {
        const sent = await sendAnnouncement(cfg, announcementEmbed(actionType, level,
          { id: targetId, name: targetName }, reason, details, user.displayName, start.action_id));
        channelStatus = "sent";
        messageId = sent.id || null;
      } catch (error) {
        channelStatus = "failed";
        errorCode = String(error.code || error.message || "channel_send_failed").slice(0, 120);
      }
    }
    const completion = await rpc(cfg, "complete_disciplinary_action", {
      p_action_id: start.action_id,
      p_role_sync_status: roleSyncStatus,
      p_channel_status: channelStatus,
      p_channel_message_id: messageId,
      p_error_code: errorCode
    });
    if (roleSyncStatus === "succeeded") {
      await appendAudit(cfg, user, actionType, targetId, start.action_id, {
        warning_level: level, reason, discord_channel_status: channelStatus,
        removed_role_count: roleResult?.removedRoleCount || 0
      });
    }
    if (roleSyncStatus !== "succeeded") {
      return json(res, 502, { ok: false, status: "failed", error: "Discord roles could not be updated. No success announcement was sent.", code: errorCode });
    }
    return json(res, 200, {
      ok: true, status: completion.status, action_id: start.action_id,
      channel_status: channelStatus, channel_message_id: messageId,
      warning_level: level, action_type: actionType,
      warning: channelStatus === "failed" ? "The Discord role change succeeded, but the announcement could not be sent. Check bot channel permissions." : null
    });
  } catch (error) {
    console.error("Warnings API failed:", error?.detail || error?.message || "unknown");
    return json(res, error.status || 502, { error: error.message || "Warnings service failed." });
  }
}
