import { discordApiRequest } from "./discord-rest.js";

const ROLE_CACHE_TTL_MS = 5_000;
const roleCache = new Map();

function httpError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

export async function isWebsiteAdmin(user) {
  const userId = String(user?.id || "");
  const roleId = String(process.env.DISCORD_WEBSITE_ADMIN_ROLE_ID || "");
  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!userId || !/^\d{15,22}$/.test(userId) || !/^\d{15,22}$/.test(roleId)) return false;
  if (!token || !/^\d{15,22}$/.test(guildId)) {
    throw httpError("تعذر التحقق من رتبة WEBSITE ADMIN؛ اتصال بوت Discord غير مكتمل.");
  }

  const cacheKey = guildId + ":" + userId + ":" + roleId;
  const cached = roleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;

  try {
    const member = await discordApiRequest(
      token,
      "/guilds/" + encodeURIComponent(guildId) + "/members/" + encodeURIComponent(userId),
      {},
      { maxRetries: 2, maxRetryWaitMs: 4000 }
    );
    const allowed = Array.isArray(member?.roles) && member.roles.includes(roleId);
    roleCache.set(cacheKey, { allowed, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
    return allowed;
  } catch (error) {
    if (Number(error?.status) === 404) {
      roleCache.set(cacheKey, { allowed: false, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
      return false;
    }
    throw httpError(
      "تعذر التحقق من صلاحيات Discord حاليًا. لم يتم منح صلاحيات الإدارة.",
      Number(error?.status) === 429 ? 503 : (Number(error?.status) || 503)
    );
  }
}

export async function requireActivePortalStaff(user) {
  if (user?.isOwner) return true;
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw httpError("تعذر التحقق من حالة حساب الإدارة.", 503);

  const query = new URLSearchParams({
    discord_user_id: "eq." + String(user?.id || ""),
    select: "is_active,is_banned",
    limit: "1"
  });
  let response;
  try {
    response = await fetch(base + "/rest/v1/staff_profiles?" + query, {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
  } catch {
    throw httpError("تعذر الاتصال بقاعدة البيانات للتحقق من حساب الإدارة.", 503);
  }
  if (!response.ok) throw httpError("تعذر التحقق من حالة حساب الإدارة.", 503);
  const rows = await response.json();
  if (!rows[0] || rows[0].is_active === false || rows[0].is_banned) {
    throw httpError("حسابك غير نشط أو محظور من بوابة الموقع.", 403);
  }
  return true;
}
