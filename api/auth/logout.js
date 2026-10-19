import crypto from "node:crypto";

function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const i = part.indexOf("=");
    return i < 0 ? ["", ""] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([k]) => k));
  const raw = cookies.swat_session;
  if (!raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), signature = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000) return null;
    return user;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const user = readSession(req);
  if (user && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const response = await fetch(base + "/rest/v1/staff_login_events", {
        method: "POST",
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          discord_user_id: user.id,
          display_name: user.displayName || user.username || "Discord user",
          event_type: "logout",
          occurred_at: new Date().toISOString()
        })
      });
      if (!response.ok) console.error("Staff logout event failed:", response.status, (await response.text()).slice(0, 250));
    } catch (error) {
      console.error("Staff logout event failed:", error instanceof Error ? error.message : "unknown");
    }
  }

  res.setHeader("Set-Cookie", [
    "swat_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);
  if (req.method === "GET") return res.redirect(302, "/?loggedOut=1");
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  return res.status(200).json({ ok: true, redirect: "/" });
}
