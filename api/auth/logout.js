import crypto from "node:crypto";
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Set-Cookie", [
    "swat_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);
  return res.status(200).json({ ok: true });
}