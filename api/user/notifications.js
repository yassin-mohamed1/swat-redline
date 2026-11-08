import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { forwardAuditToDiscord } from "../../lib/audit-log.js";

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

  return { id: user.id, username: user.username, displayName: user.displayName || user.username, isOwner };
}

function supabaseConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base && key ? { base, key } : null;
}

async function readProfile(config, userId) {
  const query = new URLSearchParams({
    discord_user_id: `eq.${userId}`,
    select: "notifications_enabled,is_active,is_banned",
    limit: "1"
  });
  const response = await fetch(`${config.base}/rest/v1/staff_profiles?${query}`, {
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }
  });
  if (!response.ok) {
    console.error("Notification preference profile lookup failed:", response.status, (await response.text()).slice(0, 300));
    throw new Error("profile_lookup_failed");
  }
  const rows = await response.json();
  return rows[0] || null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET" && req.method !== "PATCH") {
    res.setHeader("Allow", "GET, PATCH");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Unauthorized." });
  if (req.method === "PATCH" && !requireSameOrigin(req, res)) return;

  const config = supabaseConfig();
  if (!config) return res.status(503).json({ error: "Notification preferences are not configured." });

  try {
    const profile = await readProfile(config, user.id);
    if (!user.isOwner && (!profile || profile.is_banned || profile.is_active === false)) {
      return res.status(403).json({ error: "This account is inactive or could not be verified." });
    }

    if (req.method === "GET") {
      return res.status(200).json({
        notifications_enabled: profile?.notifications_enabled !== false
      });
    }

    const body = typeof req.body === "string"
      ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
      : (req.body || {});
    if (typeof body.notifications_enabled !== "boolean") {
      return res.status(400).json({ error: "notifications_enabled must be a boolean." });
    }
    if (!profile) {
      return res.status(409).json({ error: "Your staff profile is not ready yet. Please sign in again." });
    }

    const query = new URLSearchParams({ discord_user_id: `eq.${user.id}` });
    const update = await fetch(`${config.base}/rest/v1/staff_profiles?${query}`, {
      method: "PATCH",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        notifications_enabled: body.notifications_enabled,
        updated_at: new Date().toISOString()
      })
    });
    if (!update.ok) {
      console.error("Notification preference update failed:", update.status, (await update.text()).slice(0, 300));
      return res.status(502).json({ error: "Could not save notification preferences." });
    }
    const rows = await update.json();
    if (!rows.length) return res.status(409).json({ error: "Your staff profile changed. Please sign in again." });

    const newValue=rows[0].notifications_enabled !== false;
    const audit=await fetch(`${config.base}/rest/v1/audit_logs`,{
      method:"POST",
      headers:{apikey:config.key,Authorization:`Bearer ${config.key}`,"Content-Type":"application/json",Prefer:"return=minimal"},
      body:JSON.stringify({actor_discord_id:user.id,actor_name:user.displayName||user.username,action:"update",
        entity_type:"staff_notification_preference",entity_id:user.id,
        details:{type:"تغيير تفضيلات الإشعارات",detail:"تم "+(newValue?"تفعيل":"إيقاف")+" الإشعارات الخاصة بالحساب.",before:profile.notifications_enabled!==false,after:newValue}})
    });
    if(!audit.ok)console.error("Notification preference audit failed:",audit.status,(await audit.text()).slice(0,300));
    else await forwardAuditToDiscord(user,{action:"update",entity_type:"staff_notification_preference",entity_id:user.id,
      details:{type:"تغيير تفضيلات الإشعارات",detail:"تم "+(newValue?"تفعيل":"إيقاف")+" الإشعارات الخاصة بالحساب."}});
    return res.status(200).json({
      ok: true,
      notifications_enabled: newValue,
      audit_log_ok:audit.ok
    });
  } catch (error) {
    console.error("Notification preferences request failed:", error instanceof Error ? error.message : "unknown");
    return res.status(503).json({ error: "Could not verify or save notification preferences." });
  }
}
