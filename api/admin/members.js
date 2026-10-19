import crypto from "node:crypto";

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
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), sig = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(sig, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const owner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60000 || (!owner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...user, isOwner: owner };
}
function send(res, status, body) { return res.status(status).json(body); }
async function mergeLoginEvents(url, key, members) {
  const q = new URLSearchParams({ select: "discord_user_id,display_name,event_type,occurred_at", order: "occurred_at.desc", limit: "500" });
  try {
    const response = await supabase(url, key, "staff_login_events?" + q);
    if (!response.ok) return members;
    const events = await response.json();
    const byId = new Map(members.map((m) => [String(m.discord_user_id), m]));
    for (const event of events) {
      const id = String(event.discord_user_id || "");
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, { discord_user_id: id, display_name: event.display_name || "Discord user", username: "", avatar_url: null, is_active: true, is_banned: false, last_seen: event.occurred_at || null, last_login: event.event_type === "login" ? event.occurred_at : null, login_count: 0, _eventOnly: true });
      else {
        const m = byId.get(id);
        if (event.occurred_at && (!m.last_seen || new Date(event.occurred_at) > new Date(m.last_seen))) m.last_seen = event.occurred_at;
        if (event.event_type === "login" && event.occurred_at && (!m.last_login || new Date(event.occurred_at) > new Date(m.last_login))) m.last_login = event.occurred_at;
      }
    }
    return [...byId.values()].sort((a,b)=>new Date(b.last_seen||b.last_login||0)-new Date(a.last_seen||a.last_login||0));
  } catch { return members; }
}
async function supabase(url, key, path, init = {}) {
  return fetch(url + "/rest/v1/" + path, { ...init, headers: {
    apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json",
    ...(init.headers || {})
  }});
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  if (!user.isOwner) return send(res, 403, { error: "Owner permission required" });
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return send(res, 503, { error: "Database is not configured" });
  try {
    if (req.method === "GET") {
      const q = new URLSearchParams({
        select: "discord_user_id,display_name,username,avatar_url,is_active,is_banned,last_seen,last_login,login_count,created_at,updated_at",
        order: "last_seen.desc.nullslast"
      });
      const response = await supabase(url, key, "staff_profiles?" + q);
      if (response.ok) {
        const members = await response.json();
        const normalized = members.map((m) => ({ ...m, is_active: m.is_active !== false, is_banned: Boolean(m.is_banned), last_seen: m.last_seen || null, last_login: m.last_login || null, login_count: Number(m.login_count || 0) }));
        return send(res, 200, { members: await mergeLoginEvents(url, key, normalized), ownerId: process.env.DISCORD_OWNER_ID, migrationRequired: false });
      }

      const detail = (await response.text()).slice(0, 500);
      console.error("Admin members read failed:", response.status, detail);

      // Backward-compatible fallback: allow the personnel directory to load
      // even before the activity-tracking migration has been applied.
      const fallbackQuery = new URLSearchParams({
        select: "discord_user_id,display_name,username,avatar_url,is_active,created_at,updated_at",
        order: "updated_at.desc",
      });
      const fallback = await supabase(url, key, "staff_profiles?" + fallbackQuery);
      if (!fallback.ok) {
        const fallbackDetail = (await fallback.text()).slice(0, 500);
        console.error("Admin members fallback failed:", fallback.status, fallbackDetail);
        return send(res, 502, {
          error: "The personnel table could not be read.",
          code: "STAFF_PROFILES_UNAVAILABLE",
          diagnostics: {
            primaryStatus: response.status,
            primaryError: detail,
            fallbackStatus: fallback.status,
            fallbackError: fallbackDetail,
            hint: "Check the deployed SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then verify public.staff_profiles exists in the same Supabase project."
          }
        });
      }
      const members = await fallback.json();
      return send(res, 200, {
        members: members.map((m) => ({
          ...m,
          is_banned: false,
          last_seen: null,
          last_login: null,
          login_count: 0,
        })),
        ownerId: process.env.DISCORD_OWNER_ID,
        migrationRequired: true,
        warning: "Directory loaded without activity tracking. Apply the admin controls migration to enable login counts, last activity, bans, and site settings.",
      });
    }
    if (req.method !== "PATCH") {
      res.setHeader("Allow", "GET, PATCH");
      return send(res, 405, { error: "Method not allowed" });
    }
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const targetId = String(body.discord_user_id || "");
    const action = String(body.action || "");
    if (!/^\d{15,22}$/.test(targetId) || !["ban", "unban", "deactivate", "activate"].includes(action))
      return send(res, 400, { error: "Invalid member action" });
    if (targetId === process.env.DISCORD_OWNER_ID)
      return send(res, 403, { error: "The protected owner cannot be modified." });
    const values = action === "ban" ? { is_banned: true, is_active: false }
      : action === "unban" ? { is_banned: false, is_active: true }
      : action === "deactivate" ? { is_active: false }
      : { is_active: true, is_banned: false };
    values.updated_at = new Date().toISOString();
    const q = new URLSearchParams({ discord_user_id: "eq." + targetId });
    const response = await supabase(url, key, "staff_profiles?" + q, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(values)
    });
    if (!response.ok) {
      console.error("Admin member update failed:", response.status, (await response.text()).slice(0, 500));
      return send(res, 502, { error: "Could not update this member." });
    }
    const rows = await response.json();
    if (!rows.length) return send(res, 404, { error: "Member record not found. The person must sign in to the website first." });
    try {
      await supabase(url, key, "audit_logs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        actor_discord_id: user.id, actor_name: user.displayName || user.username, action: "permission_change",
        entity_type: "staff_profile", entity_id: targetId, details: { change: action, target_name: rows[0].display_name || targetId }
      })});
    } catch {}
    return send(res, 200, { ok: true, member: rows[0] });
  } catch (e) {
    console.error("Admin members API failed:", e?.message || "unknown");
    return send(res, 500, { error: "Personnel service failed." });
  }
}