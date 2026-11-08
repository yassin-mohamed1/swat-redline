import crypto from "node:crypto";

const DISCORD_API = "https://discord.com/api/v10";

function json(res, status, body) {
  return res.status(status).json(body);
}

function authorized(req) {
  const expected = process.env.CRON_SECRET;
  const header = String(req.headers.authorization || "");
  if (!expected || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function config() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const botRoleId = process.env.DISCORD_BOT_ROLE_ID;
  const warningRoles = {
    1: process.env.DISCORD_WARNING_ROLE_1_ID,
    2: process.env.DISCORD_WARNING_ROLE_2_ID
  };
  if (!base || !key || !token || !guildId || !botRoleId ||
      !/^\d{15,22}$/.test(botRoleId) ||
      !/^\d{15,22}$/.test(String(warningRoles[1] || "")) ||
      !/^\d{15,22}$/.test(String(warningRoles[2] || ""))) {
    return { error: "Warning expiry service is not fully configured." };
  }
  return { base, key, token, guildId, botRoleId, warningRoles };
}

async function db(cfg, path, init = {}) {
  return fetch(cfg.base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

async function rpc(cfg, name, body) {
  const response = await db(cfg, "rpc/" + name, {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    const error = new Error("Supabase expiry operation failed.");
    error.detail = detail;
    throw error;
  }
  return response.json();
}

async function discord(cfg, path, init = {}) {
  const response = await fetch(DISCORD_API + path, {
    ...init,
    headers: {
      Authorization: "Bot " + cfg.token,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error("Discord API request failed.");
    error.status = response.status;
    error.code = String(data.code || response.status);
    error.detail = String(data.message || "").slice(0, 200);
    throw error;
  }
  return data;
}

async function loadBotHierarchy(cfg) {
  const [roles, botUser] = await Promise.all([
    discord(cfg, "/guilds/" + cfg.guildId + "/roles"),
    discord(cfg, "/users/@me")
  ]);
  const botMember = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + botUser.id);
  const byId = new Map(roles.map(role => [role.id, role]));
  if (!(botMember.roles || []).includes(cfg.botRoleId)) {
    throw new Error("Configured Bot Role is not assigned to the bot account.");
  }
  const botTop = (botMember.roles || []).map(id => byId.get(id)).filter(Boolean)
    .reduce((top, role) => !top || role.position > top.position ? role : top, null);
  if (!botTop) throw new Error("The bot's top Discord role could not be identified.");
  return { byId, botTop };
}

async function removeExpiredWarningRole(cfg, botHierarchy, item) {
  let member;
  try {
    member = await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + item.discord_user_id);
  } catch (error) {
    if (error.status === 404) return { removed: false, memberLeftServer: true };
    throw error;
  }

  const roleId = cfg.warningRoles[Number(item.warning_level)];
  const role = botHierarchy.byId.get(roleId);
  if (!role) throw new Error("The expired Warning " + item.warning_level + " role no longer exists.");
  if (role.managed || role.position >= botHierarchy.botTop.position) {
    throw new Error("The bot cannot manage the expired Warning " + item.warning_level + " role. Check role hierarchy.");
  }

  const current = new Set(member.roles || []);
  if (!current.has(roleId)) return { removed: false, alreadyAbsent: true };

  current.delete(roleId);
  await discord(cfg, "/guilds/" + cfg.guildId + "/members/" + item.discord_user_id, {
    method: "PATCH",
    body: JSON.stringify({ roles: [...current] })
  });
  return { removed: true };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed." });
  }
  if (!authorized(req)) return json(res, 401, { error: "Cron authorization required." });

  const cfg = config();
  if (cfg.error) return json(res, 503, { error: cfg.error });

  try {
    const due = await rpc(cfg, "claim_expired_warning_roles", { p_limit: 25 });
    if (!Array.isArray(due) || due.length === 0) {
      return json(res, 200, { ok: true, processed: 0, removed: 0, failed: 0 });
    }

    let hierarchy;
    try {
      hierarchy = await loadBotHierarchy(cfg);
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
      return json(res, 502, { ok: false, processed: due.length, removed: 0, failed: due.length, error: "Bot role hierarchy check failed." });
    }

    let removed = 0;
    let failed = 0;
    const results = [];
    for (const item of due) {
      try {
        const result = await removeExpiredWarningRole(cfg, hierarchy, item);
        await rpc(cfg, "complete_expired_warning_role", {
          p_discord_user_id: item.discord_user_id,
          p_warning_level: item.warning_level,
          p_warning_expires_at: item.warning_expires_at,
          p_success: true,
          p_error_code: null
        });
        if (result.removed) removed++;
        results.push({ discord_user_id: item.discord_user_id, warning_level: item.warning_level, status: result.memberLeftServer ? "member_left_server" : result.alreadyAbsent ? "role_already_absent" : "role_removed" });
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
        results.push({ discord_user_id: item.discord_user_id, warning_level: item.warning_level, status: "retry_scheduled", error: code });
      }
    }

    return json(res, 200, { ok: failed === 0, processed: due.length, removed, failed, results });
  } catch (error) {
    console.error("Warning expiry cron failed:", error?.detail || error?.message || "unknown");
    return json(res, 502, { error: "Warning expiry processing failed." });
  }
}
