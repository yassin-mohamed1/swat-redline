import crypto from "node:crypto";

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
  const expected = crypto.createHmac("sha256", secret).update(payload).digest(), received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user; try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const owner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60000 || (!owner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...user, isOwner: owner };
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  if (!user.isOwner) return res.status(403).json({ error: "Owner permission required" });
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: "Database is not configured" });
  try {
    const query = new URLSearchParams({
      select: "id,discord_user_id,display_name,event_type,session_issued_at,occurred_at",
      order: "occurred_at.desc",
      limit: "100"
    });
    const response = await fetch(base + "/rest/v1/staff_login_events?" + query.toString(), {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!response.ok) {
      console.error("Staff activity read failed:", response.status, (await response.text()).slice(0, 400));
      return res.status(502).json({ error: "Could not load login activity. Apply the admin controls migration." });
    }
    return res.status(200).json({ events: await response.json() });
  } catch (error) {
    console.error("Staff activity API failed:", error instanceof Error ? error.message : "unknown");
    return res.status(500).json({ error: "Activity service failed" });
  }
}
