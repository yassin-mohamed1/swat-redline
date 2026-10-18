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
export default function handler(req, res) {
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
  if (!user.id || !user.username || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 || user.roleId !== process.env.DISCORD_ROLE_ID) {
    return res.status(401).json({ authenticated: false });
  }
  return res.status(200).json({ authenticated: true, user: {
    id: user.id, username: user.username, displayName: user.displayName || user.username, avatar: user.avatar || null
  }});
}