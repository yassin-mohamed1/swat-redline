import crypto from "node:crypto";

function cookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}

function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = cookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;

  const split = raw.lastIndexOf(".");
  const payload = raw.slice(0, split);
  const signature = raw.slice(split + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const isOwner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 ||
      (!isOwner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...user, isOwner };
}

async function logSupabaseFailure(operation, response) {
  let detail = "";
  try { detail = (await response.text()).slice(0, 1000); } catch {}
  // Keep provider details in server logs only; never return them to the browser.
  console.error(`Supabase app_state ${operation} failed:`, response.status, detail);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(503).json({ error: "Shared storage is not configured yet." });
  }

  if (!user.isOwner) {
    try {
      const profileQuery = new URLSearchParams({ discord_user_id: `eq.${user.id}`, select: "is_active,is_banned" });
      const profileResponse = await fetch(supabaseUrl.replace(/\/+$/, "") + "/rest/v1/staff_profiles?" + profileQuery.toString(), {
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
      });
      if (profileResponse.ok) {
        const profiles = await profileResponse.json();
        if (profiles[0] && (profiles[0].is_banned || profiles[0].is_active === false))
          return res.status(403).json({ error: "Account deactivated" });
      }
    } catch {}
  }

  const endpoint = supabaseUrl.replace(/\/$/, "") + "/rest/v1/app_state";
  const headers = {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json",
  };

  try {
    if (req.method === "GET") {
      const response = await fetch(endpoint + "?id=eq.main&select=data,updated_at,updated_by", {
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
      });
      if (!response.ok) {
        await logSupabaseFailure("read", response);
        return res.status(502).json({ error: "Could not read shared data." });
      }
      const rows = await response.json();
      if (!rows.length) return res.status(200).json({ data: null, updated_at: null });
      return res.status(200).json(rows[0]);
    }

    if (req.method === "PUT") {
      const data = req.body?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "A valid data object is required." });
      }
      const allowed = ["people", "audit", "tasks", "operations", "reports", "rules", "dailyCommands"];
      const safeData = {};
      for (const key of allowed) {
        if (Array.isArray(data[key])) safeData[key] = data[key];
      }
      const response = await fetch(endpoint + "?on_conflict=id", {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          id: "main",
          data: safeData,
          updated_at: new Date().toISOString(),
          updated_by: user.username,
        }),
      });
      if (!response.ok) {
        await logSupabaseFailure("write", response);
        return res.status(502).json({ error: "Could not save shared data." });
      }
      return res.status(200).json({ ok: true, updated_by: user.username });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("Supabase app_state request failed:", error?.message || "Unknown error");
    return res.status(500).json({ error: "Shared storage request failed." });
  }
}
