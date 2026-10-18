
import crypto from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  const {
    DISCORD_CLIENT_ID: clientId,
    DISCORD_CLIENT_SECRET: clientSecret,
    DISCORD_REDIRECT_URI: redirectUri,
    DISCORD_GUILD_ID: guildId,
    DISCORD_ROLE_ID: roleId,
    SESSION_SECRET: sessionSecret,
  } = process.env;

  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !guildId ||
    !roleId ||
    !sessionSecret
  ) {
    return res.status(500).send("Authentication configuration is incomplete.");
  }

  const cookieMap = Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return [
          item.slice(0, index),
          decodeURIComponent(item.slice(index + 1)),
        ];
      })
  );

  const { code, error, state } = req.query;

  if (error) {
    res.setHeader("Set-Cookie", [
      "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    return res.status(400).send("Discord login was cancelled.");
  }

  // Start Discord OAuth login.
  if (!code) {
    const oauthState = crypto.randomBytes(32).toString("hex");

    res.setHeader("Set-Cookie", [
      `discord_oauth_state=${oauthState}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    ]);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify guilds.members.read",
      state: oauthState,
    });

    return res.redirect(
      302,
      `https://discord.com/oauth2/authorize?${params.toString()}`
    );
  }

  // Protect the OAuth callback against forged requests.
  const savedState = cookieMap.discord_oauth_state;

  res.setHeader("Set-Cookie", [
    "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ]);

  if (
    typeof state !== "string" ||
    !savedState ||
    !crypto.timingSafeEqual(
      Buffer.from(state),
      Buffer.from(savedState)
    )
  ) {
    return res.status(400).send("Invalid login state. Please try again.");
  }

  try {
    const tokenResponse = await fetch(
      "https://discord.com/api/v10/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: redirectUri,
        }),
      }
    );

    if (!tokenResponse.ok) {
      return res.status(401).send("Discord token exchange failed.");
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(401).send("Discord did not return an access token.");
    }

    const discordHeaders = {
      Authorization: `Bearer ${accessToken}`,
    };

    const [userResponse, memberResponse] = await Promise.all([
      fetch("https://discord.com/api/v10/users/@me", {
        headers: discordHeaders,
      }),
      fetch(
        `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`,
        { headers: discordHeaders }
      ),
    ]);

    if (!userResponse.ok) {
      return res.status(401).send("Could not verify your Discord account.");
    }

    if (memberResponse.status === 404) {
      return res.status(403).send("You are not a member of the required server.");
    }

    if (!memberResponse.ok) {
      return res.status(403).send("Could not verify your server membership.");
    }

    const user = await userResponse.json();
    const member = await memberResponse.json();

    if (!Array.isArray(member.roles) || !member.roles.includes(roleId)) {
      return res.status(403).send("You do not have the required Discord role.");
    }

    // Create a signed session cookie. Never put Discord tokens in the cookie.
    const session = Buffer.from(
      JSON.stringify({
        id: user.id,
        username: user.username,
        roleId,
        issuedAt: Date.now(),
      })
    ).toString("base64url");

    const signature = crypto
      .createHmac("sha256", sessionSecret)
      .update(session)
      .digest("base64url");

    res.setHeader("Set-Cookie", [
      `swat_session=${session}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
    ]);

    return res.redirect(302, "/");
  } catch {
    return res.status(500).send("Discord authentication failed. Please try again.");
  }
}
