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
        select: "discord_user_id,display_name,avatar_url,is_active,is_banned,last_seen,last_login,login_count,created_at,updated_at",
        order: "last_seen.desc.nullslast"
      });
      const response = await supabase(url, key, "staff_profiles?" + q);
      if (!response.ok) {
        console.error("Admin members read failed:", response.status, (await response.text()).slice(0, 500));
        return send(res, 502, { error: "Could not load personnel records. Check the database migration." });
      }
      return send(res, 200, { members: await response.json(), ownerId: process.env.DISCORD_OWNER_ID });
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