import crypto from "node:crypto";
import { discordApiRequest } from "../../lib/discord-rest.js";

const EXPECTED_REPOSITORY = "yassin-mohamed1/swat-redline";
const EXPECTED_REF = "refs/heads/main";
const EXPECTED_WORKFLOW = "yassin-mohamed1/swat-redline/.github/workflows/discord-role-sync.yml@refs/heads/main";
const EXPECTED_AUDIENCE = "swat-redline-discord-role-sync";
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const MAX_PAGES_PER_RUN = 15;
const DISCORD_PAGE_SIZE = 1000;

let jwksCache = { expiresAt: 0, keys: [] };

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function getGitHubSigningKey(kid) {
  if (!jwksCache.keys.length || Date.now() >= jwksCache.expiresAt) {
    const response = await fetch(GITHUB_ISSUER + "/.well-known/jwks", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      throw Object.assign(new Error("تعذّر التحقق من هوية GitHub Actions."), { status: 503 });
    }
    const payload = await response.json();
    if (!Array.isArray(payload.keys) || !payload.keys.length) {
      throw Object.assign(new Error("مفاتيح التحقق من GitHub غير متاحة."), { status: 503 });
    }
    jwksCache = { keys: payload.keys, expiresAt: Date.now() + 15 * 60 * 1000 };
  }
  const jwk = jwksCache.keys.find(item => item.kid === kid && item.kty === "RSA");
  if (!jwk) {
    jwksCache.expiresAt = 0;
    throw Object.assign(new Error("مفتاح توقيع GitHub غير صالح أو منتهي."), { status: 401 });
  }
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function verifyGitHubActionsRequest(req) {
  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;

  let header, claims;
  try {
    header = decodeJwtPart(parts[0]);
    claims = decodeJwtPart(parts[1]);
  } catch {
    return false;
  }
  if (header.alg !== "RS256" || !header.kid || claims.iss !== GITHUB_ISSUER) return false;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(EXPECTED_AUDIENCE) ||
      Number(claims.exp || 0) <= now ||
      Number(claims.nbf || 0) > now + 30 ||
      Number(claims.iat || 0) > now + 30 ||
      Number(claims.iat || 0) < now - 10 * 60 ||
      claims.repository !== EXPECTED_REPOSITORY ||
      claims.ref !== EXPECTED_REF ||
      claims.workflow_ref !== EXPECTED_WORKFLOW ||
      !["schedule", "workflow_dispatch"].includes(String(claims.event_name || ""))) {
    return false;
  }

  const publicKey = await getGitHubSigningKey(header.kid);
  const signedContent = Buffer.from(parts[0] + "." + parts[1], "utf8");
  const signature = Buffer.from(parts[2], "base64url");
  return crypto.verify("RSA-SHA256", signedContent, publicKey, signature);
}

async function supabaseRequest(base, key, path, init = {}) {
  return fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(init.headers || {})
    },
    signal: init.signal || AbortSignal.timeout(12000)
  });
}

function discordAvatar(member, userId) {
  const user = member?.user || {};
  const hash = user.avatar;
  if (typeof hash === "string" && /^[a-zA-Z0-9_]+$/.test(hash)) {
    return "https://cdn.discordapp.com/avatars/" + userId + "/" + hash + "." +
      (hash.startsWith("a_") ? "gif" : "png") + "?size=128";
  }
  const index = Number(BigInt(userId) >> 22n) % 6;
  return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
}

function profileFromDiscordMember(member, now) {
  const user = member?.user || {};
  const id = String(user.id || "");
  if (!/^\d{15,22}$/.test(id)) return null;
  const username = String(user.username || "").slice(0, 100);
  const displayName = String(member.nick || user.global_name || username || "Discord user").slice(0, 100);
  return {
    discord_user_id: id,
    display_name: displayName,
    username,
    avatar_url: discordAvatar(member, id),
    is_active: true,
    is_banned: false,
    login_count: 0,
    last_seen: null,
    last_login: null,
    notifications_enabled: true,
    discord_roles: Array.isArray(member.roles) ? member.roles : [],
    discord_roles_synced_at: now,
    is_manual: false,
    manual_created_by_discord_id: null,
    created_at: now,
    updated_at: now
  };
}

async function saveNewProfiles(base, key, members, now) {
  const profiles = members.map(member => profileFromDiscordMember(member, now)).filter(Boolean);
  if (!profiles.length) return 0;

  // Ignore duplicate discord_user_id rows. Existing profiles are deliberately
  // untouched so bans, deactivations, opt-outs, login history and manual records
  // can never be reset by the scheduled role scan.
  const query = new URLSearchParams({ on_conflict: "discord_user_id" });
  const response = await supabaseRequest(base, key, "staff_profiles?" + query.toString(), {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(profiles)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw Object.assign(new Error("تعذّر حفظ الأعضاء الجدد في دليل الموقع."), {
      status: 502, detail
    });
  }
  const inserted = await response.json();
  return Array.isArray(inserted) ? inserted.length : 0;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Method not allowed." });
  }

  try {
    if (!await verifyGitHubActionsRequest(req)) {
      return json(res, 401, { error: "غير مصرح بتشغيل مزامنة أعضاء Discord." });
    }

    const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const token = process.env.DISCORD_BOT_TOKEN;
    const guildId = String(process.env.DISCORD_GUILD_ID || "");
    const roleId = String(process.env.DISCORD_ROLE_ID || "");
    if (!base || !key || !token || !/^\d{15,22}$/.test(guildId) || !/^\d{15,22}$/.test(roleId)) {
      return json(res, 503, { error: "إعدادات Discord أو Supabase المطلوبة للمزامنة غير مكتملة." });
    }

    const stateQuery = new URLSearchParams({
      guild_id: "eq." + guildId,
      select: "guild_id,cursor_id",
      limit: "1"
    });
    const stateResponse = await supabaseRequest(base, key, "discord_role_sync_state?" + stateQuery.toString());
    if (!stateResponse.ok) {
      console.error("Discord role sync state lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 250));
      return json(res, 503, { error: "تعذّر قراءة موضع مزامنة أعضاء Discord." });
    }
    const states = await stateResponse.json();
    let cursor = states[0]?.cursor_id || "0";

    if (!states.length) {
      const createState = await supabaseRequest(base, key, "discord_role_sync_state", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ guild_id: guildId, cursor_id: "0" })
      });
      if (!createState.ok && createState.status !== 409) {
        return json(res, 503, { error: "تعذّر إنشاء حالة مزامنة أعضاء Discord." });
      }
    }

    let pages = 0;
    let scanned = 0;
    let withRole = 0;
    let inserted = 0;
    let cycleComplete = false;
    const now = new Date().toISOString();

    while (pages < MAX_PAGES_PER_RUN) {
      const memberQuery = new URLSearchParams({ limit: String(DISCORD_PAGE_SIZE) });
      if (cursor !== "0") memberQuery.set("after", cursor);
      let batch;
      try {
        batch = await discordApiRequest(
          token,
          "/guilds/" + guildId + "/members?" + memberQuery.toString(),
          {},
          { maxRetries: 2, maxRetryWaitMs: 7000 }
        );
      } catch (error) {
        const code = String(error.code || error.status || "unknown");
        if (Number(error.status) === 403 && code === "50001") {
          return json(res, 403, {
            error: "Discord رفض قراءة قائمة الأعضاء. افتح Discord Developer Portal ثم Bot ثم فعّل Server Members Intent (GUILD_MEMBERS)، وبعدها شغّل المزامنة مرة أخرى.",
            code,
            hint: "هذا إعداد Privileged Gateway Intent للبوت، وليس صلاحية الرول الممنوحة للأعضاء."
          });
        }
        console.error("Discord role sync member scan failed:", JSON.stringify({
          status: Number(error.status || 0), code, path: error.path || null
        }));
        return json(res, Number(error.status) === 429 ? 503 : 502, {
          error: "تعذّر جلب قائمة أعضاء Discord للمزامنة.",
          code
        });
      }

      if (!Array.isArray(batch)) {
        return json(res, 502, { error: "أعاد Discord قائمة أعضاء غير صالحة." });
      }
      pages += 1;
      scanned += batch.length;
      const matches = batch.filter(member =>
        Array.isArray(member?.roles) && member.roles.map(String).includes(roleId)
      );
      withRole += matches.length;
      inserted += await saveNewProfiles(base, key, matches, now);

      if (!batch.length || batch.length < DISCORD_PAGE_SIZE) {
        cycleComplete = true;
        cursor = "0";
        break;
      }
      const nextCursor = String(batch[batch.length - 1]?.user?.id || "");
      if (!/^\d{15,22}$/.test(nextCursor) || nextCursor === cursor) {
        return json(res, 502, { error: "تعذّر تحريك مؤشر صفحات أعضاء Discord بأمان." });
      }
      cursor = nextCursor;

      const patchQuery = new URLSearchParams({ guild_id: "eq." + guildId });
      const statePatch = await supabaseRequest(base, key, "discord_role_sync_state?" + patchQuery.toString(), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ cursor_id: cursor, updated_at: new Date().toISOString() })
      });
      if (!statePatch.ok) {
        console.error("Discord role sync cursor save failed:", statePatch.status, (await statePatch.text()).slice(0, 250));
        return json(res, 503, { error: "تمت قراءة الصفحة، لكن تعذّر حفظ مؤشر الاستكمال. أعد تشغيل المزامنة." });
      }
    }

    const finalPatchQuery = new URLSearchParams({ guild_id: "eq." + guildId });
    const finalPatch = await supabaseRequest(base, key, "discord_role_sync_state?" + finalPatchQuery.toString(), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        cursor_id: cursor,
        ...(cycleComplete ? { last_completed_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString()
      })
    });
    if (!finalPatch.ok) {
      console.error("Discord role sync final state save failed:", finalPatch.status, (await finalPatch.text()).slice(0, 250));
      return json(res, 503, { error: "اكتملت قراءة الأعضاء، لكن تعذّر حفظ حالة المزامنة." });
    }

    return json(res, 200, {
      ok: true,
      guild_id: guildId,
      role_id: roleId,
      pages_scanned: pages,
      members_scanned: scanned,
      members_with_access_role: withRole,
      newly_registered: inserted,
      cursor,
      cycle_complete: cycleComplete,
      schedule: "Every 5 minutes via GitHub Actions"
    });
  } catch (error) {
    console.error("Discord role sync failed:", error?.detail || error?.message || "unknown");
    return json(res, error.status || 500, {
      error: error.message || "فشلت مزامنة أعضاء Discord."
    });
  }
}
