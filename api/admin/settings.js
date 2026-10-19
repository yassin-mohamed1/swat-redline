import crypto from "node:crypto";
function cookies(header = "") {
  const out = {};
  for (const part of header.split(";")) { const i = part.indexOf("="); if (i < 0) continue; try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  return out;
}
function session(req) {
  const secret = process.env.SESSION_SECRET, raw = cookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), sig = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest(), received = Buffer.from(sig, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let u; try { u = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const owner = Boolean(process.env.DISCORD_OWNER_ID && u.id === process.env.DISCORD_OWNER_ID);
  if (!u.id || !u.issuedAt || Date.now() - u.issuedAt > 8 * 60 * 60 * 1000 || u.issuedAt > Date.now() + 60000 || (!owner && u.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...u, isOwner: owner };
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req); if (!user) return res.status(401).json({ error: "Authentication required" });
  if (req.method !== "GET" && !user.isOwner) return res.status(403).json({ error: "Owner permission required" });
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: "Database is not configured" });
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  try {
    if (req.method === "GET") {
      const r = await fetch(base + "/rest/v1/site_settings?select=key,value", { headers });
      if (!r.ok) { console.error("Settings read failed:", r.status, (await r.text()).slice(0, 400)); return res.status(502).json({ error: "Could not load settings. Apply the admin migration first." }); }
      const rows = await r.json(), settings = {};
      for (const row of rows) settings[row.key] = row.value;
      return res.status(200).json({ settings });
    }
    if (req.method !== "PUT") { res.setHeader("Allow", "GET, PUT"); return res.status(405).json({ error: "Method not allowed" }); }
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) return res.status(400).json({ error: "Settings object required" });
    const allowed = new Set(["accentColor", "backgroundColor", "textOverrides", "styleOverrides"]);
    const rows = [];
    for (const [k, value] of Object.entries(body.settings)) {
      if (!allowed.has(k)) continue;
      const raw = JSON.stringify(value);
      if (raw.length > 120000) return res.status(413).json({ error: "A setting is too large" });
      if (k.endsWith("Color") && (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))) return res.status(400).json({ error: "Invalid color value" });
      if ((k === "textOverrides" || k === "styleOverrides") && (!value || typeof value !== "object" || Array.isArray(value))) return res.status(400).json({ error: "Invalid overrides" });
      rows.push({ key: k, value, updated_by: user.id, updated_at: new Date().toISOString() });
    }
    if (!rows.length) return res.status(400).json({ error: "No supported settings supplied" });
    const r = await fetch(base + "/rest/v1/site_settings?on_conflict=key", { method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
    if (!r.ok) { console.error("Settings write failed:", r.status, (await r.text()).slice(0, 500)); return res.status(502).json({ error: "Could not save settings" }); }
    return res.status(200).json({ ok: true });
  } catch (e) { console.error("Settings API failed:", e?.message || "unknown"); return res.status(500).json({ error: "Settings service failed" }); }
}