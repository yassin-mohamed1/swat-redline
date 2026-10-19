import crypto from "node:crypto";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).send("Method not allowed"); }
  const {
    DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret,
    DISCORD_REDIRECT_URI: redirectUri, DISCORD_GUILD_ID: guildId,
    DISCORD_ROLE_ID: roleId, SESSION_SECRET: sessionSecret,
  } = process.env;
  if (!clientId || !clientSecret || !redirectUri || !guildId || !roleId || !sessionSecret) return res.status(500).send("Authentication configuration is incomplete.");
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)];
  }));
  const { code, error, state } = req.query;
  if (error) {
    res.setHeader("Set-Cookie", "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return res.status(400).send("Discord login was cancelled.");
  }
  if (!code) {
    const oauthState = crypto.randomBytes(32).toString("hex");
    res.setHeader("Set-Cookie", `discord_oauth_state=${oauthState}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "identify guilds.members.read", state: oauthState });
    return res.redirect(302, `https://discord.com/oauth2/authorize?${params.toString()}`);
  }
  const savedState = cookies.discord_oauth_state;
  const stateBuffer = Buffer.from(typeof state === "string" ? state : "");
  const savedBuffer = Buffer.from(savedState || "");
  if (!stateBuffer.length || !savedBuffer.length || stateBuffer.length !== savedBuffer.length || !crypto.timingSafeEqual(stateBuffer, savedBuffer)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).send("Login verification failed. Please open the website and start a fresh login.");
  }
  res.setHeader("Set-Cookie", "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  try {
    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code: String(code), redirect_uri: redirectUri }),
    });
    if (!tokenResponse.ok) return res.status(401).send("Discord token exchange failed.");
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return res.status(401).send("Discord did not return an access token.");
    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const [userResponse, memberResponse] = await Promise.all([
      fetch("https://discord.com/api/v10/users/@me", { headers }),
      fetch(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, { headers }),
    ]);
    if (!userResponse.ok) return res.status(401).send("Could not verify your Discord account.");
    if (memberResponse.status === 404) return res.status(403).send("You are not a member of the required server.");
    if (!memberResponse.ok) return res.status(403).send("Could not verify your server membership.");
    const user = await userResponse.json();
    const member = await memberResponse.json();
    if (!Array.isArray(member.roles) || !member.roles.includes(roleId)) return res.status(403).send("You do not have the required Discord role.");
    const displayName = member.nick || user.global_name || user.username || "Discord user";
    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const supabaseBaseUrl = supabaseUrl ? supabaseUrl.replace(/\/+$/, "") : "";
    if (supabaseUrl || supabaseSecretKey) {
      if (!supabaseUrl || !supabaseSecretKey) {
        return res.status(500).send("Supabase configuration is incomplete.");
      }
      // Supabase sb_secret_* keys are not JWTs. Send them in apikey only;
      // putting one in Authorization: Bearer causes an Invalid JWT response.
      const supabaseHeaders = {
        apikey: supabaseSecretKey,
        "Content-Type": "application/json",
      };
      const profileQuery = new URLSearchParams({ discord_user_id: `eq.${user.id}`, select: "id" });
      const profileLookup = await fetch(
        `${supabaseBaseUrl}/rest/v1/staff_profiles?${profileQuery.toString()}`,
        { headers: supabaseHeaders }
      );
      if (!profileLookup.ok) {
        return res.status(502).send("Could not read the staff profile from Supabase.");
      }
      const existingProfiles = await profileLookup.json();
      const profile = {
        discord_user_id: user.id,
        display_name: displayName,
        avatar_url: avatar,
        updated_at: new Date().toISOString(),
      };
      const profileWrite = existingProfiles.length
        ? await fetch(
            `${supabaseBaseUrl}/rest/v1/staff_profiles?discord_user_id=eq.${user.id}`,
            {
              method: "PATCH",
              headers: { ...supabaseHeaders, Prefer: "return=minimal" },
              body: JSON.stringify({ display_name: displayName, avatar_url: avatar, updated_at: profile.updated_at }),
            }
          )
        : await fetch(
            `${supabaseBaseUrl}/rest/v1/staff_profiles`,
            {
              method: "POST",
              headers: { ...supabaseHeaders, Prefer: "return=minimal" },
              body: JSON.stringify({ ...profile, is_active: true }),
            }
          );
      if (!profileWrite.ok) {
        return res.status(502).send("Could not save the staff profile to Supabase.");
      }
    }

    const session = Buffer.from(JSON.stringify({ id: user.id, username: user.username, displayName, avatar, roleId, issuedAt: Date.now() })).toString("base64url");
    const signature = crypto.createHmac("sha256", sessionSecret).update(session).digest("base64url");
    res.setHeader("Set-Cookie", [`swat_session=${session}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`]);
    return res.redirect(302, "/");
  } catch {
    return res.status(500).send("Discord authentication failed. Please try again.");
  }
}