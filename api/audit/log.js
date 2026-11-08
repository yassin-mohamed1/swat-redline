import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { discordApiRequest } from "../../lib/discord-rest.js";

function parseCookies(header = "") {
  const result = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return result;
}

function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
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
  const owner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.username || !user.issuedAt ||
      Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60_000 ||
      (!owner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...user, isOwner: owner };
}

async function isActiveStaff(user) {
  if (user.isOwner) return true;
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return true; // Legacy installations without staff profiles remain compatible.
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

const AUDIT_CHANNEL_ID = "1569047013402738829";
const SECRET_FIELD_NAMES = /password|passwd|token|secret|authorization|cookie|session|api[_-]?key|client[_-]?secret/i;
const SENSITIVE_VALUE = /(?:Bearer\\s+[A-Za-z0-9._~+\\/-]+=*|mfa\\.[A-Za-z0-9_-]{20,}|(?:password|passwd|token|secret|api[_-]?key|client[_-]?secret)\\s*[:=]\\s*[^\\s,;]{4,})/i;

function safeAuditText(value, max = 700) {
  let text = String(value ?? "");
  text = text.replace(/<@!?\\d{15,22}>/g, "[Discord user]")
    .replace(/<@&\\d{15,22}>/g, "[Discord role]")
    .replace(/https?:\\/\\/\\S+/gi, "[link]");
  if (SENSITIVE_VALUE.test(text)) return "[content omitted: possible secret]";
  text = text.replace(/\\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function sanitizeAuditDetails(value, depth = 0) {
  if (depth > 3) return "[nested data omitted]";
  if (Array.isArray(value)) return value.slice(0, 10).map(item => sanitizeAuditDetails(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? safeAuditText(value, 180) : value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 18)) {
    if (SECRET_FIELD_NAMES.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    if (typeof item === "string" && /^(?:content|text|message|description|details|body|notes|reason)$/i.test(key)) {
      output[key] = safeAuditText(item, 180);
    } else {
      output[key] = sanitizeAuditDetails(item, depth + 1);
    }
  }
  return output;
}

async function forwardAuditToDiscord(user, event) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return { ok: false, reason: "bot_token_missing" };
  try {
    const createdAt = new Date().toISOString();
    const embed = {
      title: "S.W.A.T. REDLINE • Administrative Activity",
      color: 0x24c77a,
      description: "A verified portal activity was recorded.",
      fields: [
        { name: "Actor", value: safeAuditText(user.displayName || user.username, 100), inline: true },
        { name: "Discord ID", value: String(user.id).slice(0, 24), inline: true },
        { name: "Action", value: safeAuditText(event.action, 40), inline: true },
        { name: "Category", value: safeAuditText(event.entityType, 80), inline: true },
        { name: "Reference", value: safeAuditText(event.entityId || "—", 100), inline: true },
        { name: "Summary", value: safeAuditText(event.details?.detail || event.details?.type || event.entityType, 500), inline: false }
      ],
      footer: { text: "REDLINE Audit • Event saved to the Administration Log" },
      timestamp: createdAt
    };
    await discordApiRequest(token, `/channels/${AUDIT_CHANNEL_ID}/messages`, {
      method: "POST",
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } })
    }, { maxRetries: 2, maxRetryWaitMs: 2500 });
    return { ok: true };
  } catch (error) {
    console.error("Discord audit forward failed:", error?.status || "unknown", error?.message || "unknown");
    return { ok: false, reason: error?.status === 429 ? "rate_limited" : "discord_delivery_failed" };
  }
}

function send(res, status, body) {
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const user = getSession(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  if (!await isActiveStaff(user)) return send(res, 403, { error: "Account inactive or could not be verified" });

  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return send(res, 503, { error: "Database is not configured" });

  if (req.method === "GET") {
    try {
      const query = new URLSearchParams({
        select: "id,actor_discord_id,actor_name,action,entity_type,entity_id,details,created_at",
        order: "created_at.desc",
        limit: "500"
      });
      const response = await fetch(`${url}/rest/v1/audit_logs?${query}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (!response.ok) {
        console.error("Audit history read failed:", response.status, (await response.text()).slice(0, 400));
        return send(res, 502, { error: "Could not load audit history" });
      }
      const events = await response.json();

      // Keep pre-migration browser audit entries visible, but clearly distinguish
      // them from server-written records that cannot be replaced by clients.
      const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
      const stateResponse = await fetch(`${url}/rest/v1/app_state?${stateQuery}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
      if (stateResponse.ok) {
        const stateRows = await stateResponse.json();
        const legacy = Array.isArray(stateRows[0]?.data?.audit) ? stateRows[0].data.audit : [];
        for (let i = 0; i < legacy.length; i++) {
          const item = legacy[i];
          if (!item || typeof item !== "object") continue;
          events.push({
            id: `legacy-${i}`,
            actor_discord_id: null,
            actor_name: typeof item.user === "string" ? item.user : "Unknown user",
            action: item.type === "إضافة" ? "create" : item.type === "حذف" ? "delete" : item.type === "تصدير" ? "download" : "update",
            entity_type: "legacy_browser_audit",
            entity_id: item.ref == null ? null : String(item.ref),
            details: { type: item.type || "حدث", detail: item.detail || "سجل قديم", ref: item.ref || "—", legacy: true },
            created_at: item.time || null
          });
        }
      }
      events.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return send(res, 200, { events: events.slice(0, 500) });
    } catch (error) {
      console.error("Audit history service failed:", error?.message || "unknown");
      return send(res, 502, { error: "Audit service unavailable" });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Method not allowed" });
  }
  if (!requireSameOrigin(req, res)) return;

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const allowedActions = new Set(["create", "update", "delete", "login", "logout", "upload", "download", "permission_change"]);
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const entityType = typeof body.entity_type === "string" ? body.entity_type.trim().slice(0, 80) : "";
  const entityId = body.entity_id == null ? null : String(body.entity_id).slice(0, 160);
  if (!allowedActions.has(action) || !entityType) return send(res, 400, { error: "Invalid audit event" });

  let details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : {};
  try {
    const encoded = JSON.stringify(details);
    if (encoded.length > 4000) return send(res, 413, { error: "Audit details are too large" });
    details = JSON.parse(encoded);
  } catch {
    return send(res, 400, { error: "Invalid audit details" });
  }

  try {
    const response = await fetch(`${url}/rest/v1/audit_logs`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        actor_discord_id: user.id,
        actor_name: user.displayName || user.username,
        action,
        entity_type: entityType,
        entity_id: entityId,
        details
      })
    });
    if (!response.ok) {
      console.error("Audit event write failed:", response.status, (await response.text()).slice(0, 400));
      return send(res, 502, { error: "Could not save audit event" });
    }

    // The durable database record is written first. Discord is best-effort so
    // a Discord outage never loses or blocks the administration audit record.
    const discordDelivery = await forwardAuditToDiscord(user, {
      action, entityType, entityId, details
    });
    return send(res, 201, {
      ok: true,
      discord: discordDelivery.ok ? "sent" : "pending"
    });
  } catch {
    return send(res, 502, { error: "Audit service unavailable" });
  }
}
