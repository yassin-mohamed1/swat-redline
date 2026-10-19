import crypto from "node:crypto";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).send("Method not allowed"); }
  const {
    DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret,
    DISCORD_REDIRECT_URI: redirectUri, DISCORD_GUILD_ID: guildId,
    DISCORD_ROLE_ID: roleId, DISCORD_OWNER_ID: ownerId, SESSION_SECRET: sessionSecret,
  } = process.env;
  if (!clientId || !clientSecret || !redirectUri || !guildId || !roleId || !sessionSecret) return res.status(500).send("Authentication configuration is incomplete.");
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)];
  }));
  const { code, error, state } = req.query;
  if (error) {
    res.setHeader("Set-Cookie", "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0");
    return res.status(400).send("Discord login was cancelled.");
  }
  if (!code) {
    const oauthState = crypto.randomBytes(32).toString("hex");
    res.setHeader("Set-Cookie", `discord_oauth_state=${oauthState}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600`);
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
  res.setHeader("Set-Cookie", "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0");
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
    const isOwner = Boolean(ownerId && user.id === ownerId);
    if (!isOwner && (!Array.isArray(member.roles) || !member.roles.includes(roleId))) return res.status(403).send("You do not have the required Discord role.");
    const displayName = user.global_name || user.username || member.nick || "Discord user";
    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;

    // Profile sync is best-effort: a Supabase schema/key/RLS issue must not
    // prevent a valid Discord staff member from signing in.
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseSecretKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && supabaseSecretKey) {
        const supabaseBaseUrl = supabaseUrl.replace(/\/+$/, "");
        const supabaseHeaders = {
          apikey: supabaseSecretKey,
          Authorization: `Bearer ${supabaseSecretKey}`,
          "Content-Type": "application/json",
        };
        const profileQuery = new URLSearchParams({
          discord_user_id: `eq.${user.id}`,
          select: "id,is_banned,is_active,login_count,username"
        });
        const profileLookup = await fetch(
          `${supabaseBaseUrl}/rest/v1/staff_profiles?${profileQuery.toString()}`,
          { headers: supabaseHeaders }
        );
        if (!profileLookup.ok) {
          console.error("Staff profile lookup failed:", profileLookup.status, (await profileLookup.text()).slice(0, 300));
        } else {
          const existingProfiles = await profileLookup.json();
          const isProtectedOwner = Boolean(ownerId && user.id === ownerId);
          const existingProfile = existingProfiles[0];
          if (!isProtectedOwner && existingProfile && (existingProfile.is_banned || existingProfile.is_active === false)) {
            return res.status(403).send(existingProfile.is_banned
              ? "This Discord account is banned from the portal."
              : "This Discord account has been deactivated by the owner.");
          }
          const now = new Date().toISOString();
          const profile = {
            discord_user_id: user.id,
            display_name: displayName,
            username: user.username,
            avatar_url: avatar,
            updated_at: now,
            last_seen: now,
            last_login: now,
            login_count: Number(existingProfile?.login_count || 0) + 1,
            is_active: true,
            is_banned: false,
          };
          const profileWrite = existingProfiles.length
            ? await fetch(
                `${supabaseBaseUrl}/rest/v1/staff_profiles?discord_user_id=eq.${user.id}`,
                {
                  method: "PATCH",
                  headers: { ...supabaseHeaders, Prefer: "return=minimal" },
                  body: JSON.stringify(profile),
                }
              )
            : await fetch(
                `${supabaseBaseUrl}/rest/v1/staff_profiles`,
                {
                  method: "POST",
                  headers: { ...supabaseHeaders, Prefer: "return=minimal" },
                  body: JSON.stringify({ ...profile, created_at: now }),
                }
              );
          if (!profileWrite.ok) {
            console.error("Staff profile save failed:", profileWrite.status, (await profileWrite.text()).slice(0, 300));
          }
        }
      }
    } catch (profileError) {
      console.error("Staff profile sync failed:", profileError instanceof Error ? profileError.message : "Unknown error");
    }

    try {
      const eventUrl = process.env.SUPABASE_URL;
      const eventKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (eventUrl && eventKey) {
        const eventResponse = await fetch(eventUrl.replace(new RegExp("/+$"), "") + "/rest/v1/staff_login_events", {
          method: "POST",
          headers: { apikey: eventKey, Authorization: "Bearer " + eventKey, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ discord_user_id: user.id, display_name: displayName, event_type: "login", session_issued_at: Date.now(), occurred_at: new Date().toISOString() })
        });
        if (!eventResponse.ok) console.error("Staff login event save failed:", eventResponse.status, (await eventResponse.text()).slice(0, 300));
      }
    } catch (eventError) {
      console.error("Staff login event save failed:", eventError instanceof Error ? eventError.message : "Unknown error");
    }

    try {
      const eventUrl = process.env.SUPABASE_URL;
      const eventKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (eventUrl && eventKey) {
        const eventResponse = await fetch(eventUrl.replace(new RegExp("/+$"), "") + "/rest/v1/staff_login_events", {
          method: "POST",
          headers: { apikey: eventKey, Authorization: "Bearer " + eventKey, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ discord_user_id: user.id, display_name: displayName, event_type: "login", session_issued_at: Date.now(), occurred_at: new Date().toISOString() })
        });
        if (!eventResponse.ok) console.error("Staff login event save failed:", eventResponse.status, (await eventResponse.text()).slice(0, 300));
      }
    } catch (eventError) {
      console.error("Staff login event save failed:", eventError instanceof Error ? eventError.message : "Unknown error");
    }

    const session = Buffer.from(JSON.stringify({ id: user.id, username: user.username, displayName, avatar, roleId, isOwner, issuedAt: Date.now() })).toString("base64url");
    const signature = crypto.createHmac("sha256", sessionSecret).update(session).digest("base64url");
    res.setHeader("Set-Cookie", [`swat_session=${session}.${signature}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=28800`]);
    return res.redirect(302, "/");
  } catch {
    return res.status(500).send("Discord authentication failed. Please try again.");
  }
}