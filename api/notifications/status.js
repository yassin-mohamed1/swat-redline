import crypto from "node:crypto";

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try { out[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return out;
}

function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const split = raw.lastIndexOf(".");
  const payload = raw.slice(0, split);
  const signature = raw.slice(split + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 ||
      (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { isOwner };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Unauthorized." });
  if (!user.isOwner) return res.status(403).json({ error: "Only the portal owner can inspect bot configuration." });

  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token || !guildId) {
    return res.status(503).json({ ok: false, botTokenConfigured: Boolean(token), guildConfigured: Boolean(guildId), error: "Bot token or server ID is missing." });
  }

  try {
    const botResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: "Bot " + token }
    });
    const botData = await botResponse.json().catch(() => ({}));
    if (!botResponse.ok) {
      const code = String(botData.code || botResponse.status);
      return res.status(200).json({
        ok: false, botTokenConfigured: true, guildConfigured: true,
        tokenValid: false, botInGuild: false,
        errorCode: code,
        message: code === "50014" || code === "40001"
          ? "Bot Token is invalid. Update DISCORD_BOT_TOKEN in Vercel."
          : "Could not authenticate the Discord bot."
      });
    }

    const guildResponse = await fetch("https://discord.com/api/v10/guilds/" + encodeURIComponent(guildId), {
      headers: { Authorization: "Bot " + token }
    });
    const guildData = await guildResponse.json().catch(() => ({}));
    if (!guildResponse.ok) {
      return res.status(200).json({
        ok: true, tokenValid: true, botInGuild: false,
        botUsername: botData.username || null,
        errorCode: String(guildData.code || guildResponse.status),
        message: "The bot is not installed in the server configured for portal login, or it cannot access that server."
      });
    }

    return res.status(200).json({
      ok: true, tokenValid: true, botInGuild: true,
      botUsername: botData.username || null,
      guildName: guildData.name || null,
      message: "The Discord bot is installed in the portal's configured server."
    });
  } catch (error) {
    console.error("Discord bot diagnostics failed:", error instanceof Error ? error.message : "unknown");
    return res.status(503).json({ ok: false, error: "Could not reach Discord to inspect the bot." });
  }
}
