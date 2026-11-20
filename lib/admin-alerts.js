import { discordApiRequest } from "./discord-rest.js";

function getConfig(config = {}) {
  const base = String(config.base || config.supabaseUrl || "").replace(/\/+$/, "");
  const key = String(config.key || config.serviceKey || config.supabaseServiceRoleKey || "");
  const token = String(config.token || config.botToken || "");
  const channelId = String(config.adminAlertsChannelId || config.channelId || "");
  if (!base || !key || !token || !/^\d{15,22}$/.test(channelId)) {
    throw new Error("admin_alert_delivery_configuration_incomplete");
  }
  return { base, key, token, channelId };
}

async function dbRequest(config, path, options = {}) {
  const response = await fetch(config.base + "/rest/v1/" + path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(8_000),
    headers: {
      apikey: config.key,
      Authorization: "Bearer " + config.key,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw Object.assign(new Error("admin_alert_database_" + response.status), { status: response.status, detail });
  }
  return response.status === 204 ? [] : response.json();
}

function safeText(value, max = 1000) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || "—";
}

export async function queueAdminAlert(configInput, alert) {
  const config = getConfig(configInput);
  const alertKey = String(alert?.alertKey || "").trim().slice(0, 220);
  const alertType = String(alert?.alertType || "").trim();
  if (!alertKey || !["leave_request", "warning_due", "voice_missing"].includes(alertType)) {
    throw new Error("invalid_admin_alert");
  }
  const query = new URLSearchParams({ on_conflict: "alert_key" });
  const rows = await dbRequest(config, "attendance_admin_alerts?" + query.toString(), {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      alert_key: alertKey,
      alert_type: alertType,
      discord_user_id: /^\d{15,22}$/.test(String(alert.discordUserId || "")) ? String(alert.discordUserId) : null,
      payload: alert.payload && typeof alert.payload === "object" && !Array.isArray(alert.payload) ? alert.payload : {},
      status: "pending"
    })
  });
  return { queued: Array.isArray(rows) && rows.length > 0, alertKey };
}

function buildDiscordMessage(payload = {}) {
  const embed = {
    title: safeText(payload.title || "تنبيه إداري من S.W.A.T. REDLINE", 256),
    description: safeText(payload.description || "يوجد تحديث يحتاج مراجعة الإدارة.", 4000),
    color: Number.isInteger(payload.color) ? payload.color : 0xD9A441,
    fields: Array.isArray(payload.fields)
      ? payload.fields.slice(0, 20).map(field => ({
          name: safeText(field?.name, 256),
          value: safeText(field?.value, 1024),
          inline: field?.inline === true
        }))
      : [],
    footer: { text: "S.W.A.T. REDLINE • تنبيهات الإدارة" },
    timestamp: new Date().toISOString()
  };
  const body = { embeds: [embed], allowed_mentions: { parse: [], users: [], roles: [] } };
  if (typeof payload.url === "string" && /^https:\/\//i.test(payload.url)) {
    body.components = [{
      type: 1,
      components: [{ type: 2, style: 5, label: safeText(payload.buttonLabel || "فتح الموقع", 80), url: payload.url }]
    }];
  }
  return body;
}

async function updateAlert(config, alertKey, values) {
  const query = new URLSearchParams({ alert_key: "eq." + alertKey });
  await dbRequest(config, "attendance_admin_alerts?" + query.toString(), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(values)
  });
}

export async function deliverPendingAdminAlerts(configInput, options = {}) {
  const config = getConfig(configInput);
  const limit = Math.max(1, Math.min(25, Number(options.limit) || 10));
  const now = new Date().toISOString();
  const availability = "or=(and(status.eq.pending,next_attempt_at.lte." + now + "),and(status.eq.failed,next_attempt_at.lte." + now + "),and(status.eq.processing,locked_until.lte." + now + "))";
  const query = new URLSearchParams({
    select: "alert_key,discord_user_id,payload,status,attempts",
    order: "created_at.asc",
    limit: String(limit),
    [availability.split("=")[0]]: availability.slice(availability.indexOf("=") + 1)
  });
  const rows = await dbRequest(config, "attendance_admin_alerts?" + query.toString());
  let sent = 0, failed = 0, claimed = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const claimNow = new Date().toISOString();
    const claimUntil = new Date(Date.now() + 120_000).toISOString();
    const claimQuery = new URLSearchParams({
      alert_key: "eq." + row.alert_key,
      or: "(and(status.eq.pending,next_attempt_at.lte." + claimNow + "),and(status.eq.failed,next_attempt_at.lte." + claimNow + "),and(status.eq.processing,locked_until.lte." + claimNow + "))"
    });
    const claimedRows = await dbRequest(config, "attendance_admin_alerts?" + claimQuery.toString(), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: "processing",
        attempts: Number(row.attempts || 0) + 1,
        locked_until: claimUntil
      })
    });
    if (!claimedRows.length) continue;
    claimed++;
    try {
      const message = await discordApiRequest(config.token, "/channels/" + config.channelId + "/messages", {
        method: "POST",
        body: JSON.stringify(buildDiscordMessage(row.payload))
      }, { maxRetries: 2, maxRetryWaitMs: 5_000 });
      await updateAlert(config, row.alert_key, {
        status: "sent",
        discord_message_id: message?.id || null,
        sent_at: new Date().toISOString(),
        locked_until: null,
        last_error: null
      });
      sent++;
    } catch (error) {
      await updateAlert(config, row.alert_key, {
        status: "failed",
        next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        locked_until: null,
        last_error: safeText(error?.code || error?.status || error?.message || "discord_delivery_failed", 300)
      }).catch(() => {});
      failed++;
      console.error("S.W.A.T. admin alert delivery failed:", error?.status || error?.code || "unknown");
    }
  }
  return { scanned: Array.isArray(rows) ? rows.length : 0, claimed, sent, failed };
}

export function riyadhDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const get = type => parts.find(part => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}
