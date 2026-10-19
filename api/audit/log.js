import crypto from "node:crypto";

function parseCookies(header = "") {
  const result = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch {}
  }
  return result;
}

function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie).swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;

  const splitAt = raw.lastIndexOf(".");
  const payload = raw.slice(0, splitAt);
  const signature = raw.slice(splitAt + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;

  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 ||
      user.roleId !== process.env.DISCORD_ROLE_ID) return null;
  return user;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = getSession(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });

  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(503).json({ error: "Database is not configured" });

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const allowedActions = new Set(["create", "update", "delete", "login", "logout", "upload", "download", "permission_change"]);
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const entityType = typeof body.entity_type === "string" ? body.entity_type.trim().slice(0, 80) : "";
  const entityId = body.entity_id == null ? null : String(body.entity_id).slice(0, 160);
  if (!allowedActions.has(action) || !entityType) {
    return res.status(400).json({ error: "Invalid audit event" });
  }

  let details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
  // Bound payload size and avoid accepting arbitrary oversized client data.
  try {
    const encoded = JSON.stringify(details);
    if (encoded.length > 4000) return res.status(413).json({ error: "Audit details are too large" });
    details = JSON.parse(encoded);
  } catch {
    return res.status(400).json({ error: "Invalid audit details" });
  }

  try {
    const response = await fetch(`${url}/rest/v1/audit_logs`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        actor_discord_id: user.id,
        actor_name: user.displayName || user.username,
        action,
        entity_type: entityType,
        entity_id: entityId,
        details,
      }),
    });
    if (!response.ok) {
      return res.status(502).json({ error: "Could not save audit event" });
    }
    return res.status(201).json({ ok: true });
  } catch {
    return res.status(502).json({ error: "Audit service unavailable" });
  }
}
