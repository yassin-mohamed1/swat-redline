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
  return { ...user, isOwner };
}

async function isActiveStaff(user) {
  if (user.isOwner) return true;
  const base = process.env.SUPABASE_URL?.replace(/\\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return true; // Preserve compatibility if staff-profile storage is not configured.
  const query = new URLSearchParams({
    discord_user_id: `eq.${user.id}`,
    select: "is_active,is_banned",
    limit: "1"
  });
  try {
    const response = await fetch(`${base}/rest/v1/staff_profiles?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!response.ok) return false;
    const rows = await response.json();
    return Boolean(rows[0]) && rows[0].is_active !== false && !rows[0].is_banned;
  } catch {
    return false;
  }
}

async function logSupabaseFailure(operation, response) {
  let detail = "";
  try { detail = (await response.text()).slice(0, 1000); } catch {}
  console.error(`Supabase app_state ${operation} failed:`, response.status, detail);
}

async function readCurrentState(endpoint, serviceKey) {
  const response = await fetch(endpoint + "?id=eq.main&select=data,updated_at", {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
  });
  if (!response.ok) return null;
  const rows = await response.json();
  return rows[0] || null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  if (!await isActiveStaff(user)) return res.status(403).json({ error: "Account inactive or could not be verified" });

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(503).json({ error: "Shared storage is not configured yet." });

  const endpoint = supabaseUrl + "/rest/v1/app_state";
  const headers = {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    "Content-Type": "application/json"
  };

  try {
    if (req.method === "GET") {
      const response = await fetch(endpoint + "?id=eq.main&select=data,updated_at,updated_by", {
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
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
      const body = typeof req.body === "string"
        ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
        : (req.body || {});
      const data = body.data;
      const expectedUpdatedAt = typeof body.expected_updated_at === "string" ? body.expected_updated_at : "";
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return res.status(400).json({ error: "A valid data object is required." });
      }
      if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
        return res.status(400).json({ error: "A current shared-data version is required. Reload the page and try again." });
      }

      // The audit feed is append-only through /api/audit/log; clients cannot rewrite it
      // by submitting a stale copy of the whole shared-state document.
      const allowed = ["people", "investigations", "tasks", "operations", "reports", "rules", "dailyCommands"];
      const safeData = {};
      for (const key of allowed) {
        if (Array.isArray(data[key])) safeData[key] = data[key];
      }

      const current = await readCurrentState(endpoint, serviceKey);
      if (!current) return res.status(503).json({ error: "The shared data record is unavailable." });
      if (current.updated_at !== expectedUpdatedAt) {
        return res.status(409).json({
          error: "The shared data changed in another session. Reload the page before saving to avoid overwriting another member's changes.",
          current_updated_at: current.updated_at
        });
      }
      // Preserve the legacy audit history without accepting client-supplied replacements.
      if (Array.isArray(current.data?.audit)) safeData.audit = current.data.audit;

      const filter = new URLSearchParams({
        id: "eq.main",
        updated_at: `eq.${expectedUpdatedAt}`
      });
      const nextUpdatedAt = new Date(Math.max(Date.now(), Date.parse(expectedUpdatedAt) + 1)).toISOString();
      const response = await fetch(endpoint + "?" + filter.toString(), {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({
          data: safeData,
          updated_at: nextUpdatedAt,
          updated_by: user.displayName || user.username
        })
      });
      if (!response.ok) {
        await logSupabaseFailure("write", response);
        return res.status(502).json({ error: "Could not save shared data." });
      }
      const rows = await response.json();
      if (!rows.length) {
        const latest = await readCurrentState(endpoint, serviceKey);
        return res.status(409).json({
          error: "The shared data changed in another session. Reload the page before saving to avoid overwriting another member's changes.",
          current_updated_at: latest?.updated_at || null
        });
      }
      return res.status(200).json({
        ok: true,
        updated_by: user.displayName || user.username,
        updated_at: rows[0].updated_at
      });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("Supabase app_state request failed:", error?.message || "Unknown error");
    return res.status(500).json({ error: "Shared storage request failed." });
  }
}
