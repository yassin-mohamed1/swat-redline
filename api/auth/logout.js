export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", [
    "swat_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);

  // Support the portal's POST logout and older links that navigate with GET.
  if (req.method === "GET") {
    return res.redirect(302, "/?loggedOut=1");
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  return res.status(200).json({ ok: true, redirect: "/" });
}
