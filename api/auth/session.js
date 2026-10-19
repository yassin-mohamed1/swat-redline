import crypto from "node:crypto";
function parseCookies(header = "") {
  const result = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim(), value = part.slice(i + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch {}
  }
  return result;
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ authenticated: false }); }
  const secret = process.env.SESSION_SECRET, raw = parseCookies(req.headers.cookie).swat_session;
  if (!secret || !raw || !raw.includes(".")) return res.status(401).json({ authenticated: false });
  const splitAt = raw.lastIndexOf("."), payload = raw.slice(0, splitAt), signature = raw.slice(splitAt + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return res.status(401).json({ authenticated: false }); }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return res.status(401).json({ authenticated: false });
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return res.status(401).json({ authenticated: false }); }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 || (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) {
    return res.status(401).json({ authenticated: false });
  }
  if (!isOwner && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
      const query = new URLSearchParams({ discord_user_id: `eq.${user.id}`, select: "is_active,is_banned" });
      const check = await fetch(`${base}/rest/v1/staff_profiles?${query.toString()}`, {
        headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY }
      });
      if (check.ok) {
        const rows = await check.json();
        if (rows[0] && (rows[0].is_banned || rows[0].is_active === false))
          return res.status(401).json({ authenticated: false, error: "Account deactivated" });
      }
    } catch {}
  }
  return res.status(200).json({ authenticated: true, user: {
    id: user.id, username: user.username, displayName: user.displayName || user.username, avatar: user.avatar || null, isOwner
  }});
}