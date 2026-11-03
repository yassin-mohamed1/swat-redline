import crypto from "node:crypto";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RECIPIENTS_PER_BATCH = 40;

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

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    isOwner
  };
}

function getConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!base || !serviceKey) return { error: "storage_not_configured" };
  if (!botToken) return { error: "bot_token_missing" };
  return { base, serviceKey, botToken };
}

function truncate(value, max = 900) {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

async function supabaseRequest(config, path, options = {}) {
  return fetch(config.base + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: config.serviceKey,
      Authorization: "Bearer " + config.serviceKey,
      ...(options.headers || {})
    }
  });
}

async function discordRequest(config, path, options = {}) {
  const request = () => fetch(DISCORD_API + path, {
    ...options,
    headers: {
      Authorization: "Bot " + config.botToken,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  let response = await request();
  if (response.status === 429) {
    const rate = await response.json().catch(() => ({}));
    const retryAfter = Number(rate.retry_after ?? response.headers.get("retry-after") ?? 0);
    // Keep this request bounded for serverless execution. Larger waits are reported
    // for a later manual retry rather than holding a serverless function open.
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 2) {
      await new Promise(resolve => setTimeout(resolve, Math.ceil(retryAfter * 1000) + 100));
      response = await request();
    } else {
      const error = new Error("discord_rate_limited");
      error.code = "rate_limited";
      throw error;
    }
  }

  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const code = data.code ? String(data.code) : String(response.status);
    const error = new Error("discord_" + code);
    error.code = code;
    throw error;
  }
  return data;
}

function describeRecord(type, record) {
  const id = truncate(record.id, 80);
  if (type === "person") {
    return {
      title: "تنبيه بخصوص ملف شخص",
      description: "تم إرسال تنبيه إداري جديد من بوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "الاسم", value: truncate(record.name || "غير محدد", 200), inline: true },
        { name: "رقم الملف", value: id || "—", inline: true },
        { name: "الحالة", value: truncate(record.status === "arrested" ? "تم القبض عليه" : record.status === "archived" ? "مؤرشف" : "مطلوب", 80), inline: true },
        { name: "الأولوية", value: truncate(record.priority || "غير محددة", 80), inline: true },
        { name: "التفاصيل", value: truncate(record.charges || record.notes || "لا توجد تفاصيل إضافية.", 900) }
      ]
    };
  }
  if (type === "operation") {
    return {
      title: "تنبيه بخصوص عملية / اجتماع",
      description: "تم إصدار تنبيه بخصوص عملية مسجلة في بوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "اسم العملية", value: truncate(record.name || "غير محدد", 200), inline: true },
        { name: "رقم العملية", value: id || "—", inline: true },
        { name: "الحالة", value: truncate(record.status || "غير محددة", 80), inline: true },
        { name: "المسؤول", value: truncate(record.owner || "غير محدد", 120), inline: true },
        { name: "الموعد / الوقت", value: truncate(record.time || record.scheduledAt || "غير محدد", 120), inline: true }
      ]
    };
  }
  if (type === "report") {
    return {
      title: "تنبيه بخصوص تقرير",
      description: "تم إصدار تنبيه إداري بخصوص تقرير في بوابة S.W.A.T. REDLINE.",
      fields: [
        { name: "عنوان التقرير", value: truncate(record.title || "بدون عنوان", 200) },
        { name: "رقم التقرير", value: id || "—", inline: true },
        { name: "الحالة", value: truncate(record.status || "غير محددة", 80), inline: true },
        { name: "الكاتب", value: truncate(record.owner || "غير محدد", 120), inline: true },
        { name: "التاريخ", value: truncate(record.date || "غير محدد", 80), inline: true }
      ]
    };
  }
  return {
    title: "تنبيه بخصوص ملف تحرٍّ",
    description: "تم إصدار تنبيه بخصوص ملف تحرٍّ في بوابة S.W.A.T. REDLINE.",
    fields: [
      { name: "عنوان الملف", value: truncate(record.title || "بدون عنوان", 200) },
      { name: "رقم الملف", value: id || "—", inline: true },
      { name: "الحالة", value: truncate(record.status || "غير محددة", 100), inline: true },
      { name: "الاسم / الوصف", value: truncate(record.name || "غير محدد", 160), inline: true },
      { name: "ملخص الواقعة", value: truncate(record.incident || record.notes || "لا توجد تفاصيل إضافية.", 900) }
    ]
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Unauthorized." });
  if (!user.isOwner) return res.status(403).json({ error: "Only the portal owner can send broadcast alerts." });

  const body = typeof req.body === "string"
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const type = body.entity_type;
  const entityId = typeof body.entity_id === "string" ? body.entity_id.trim() : "";
  const batchKey = typeof body.batch_key === "string" ? body.batch_key : "";

  if (!["person", "operation", "report", "investigation"].includes(type) ||
      !entityId || entityId.length > 100 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchKey)) {
    return res.status(400).json({ error: "Invalid notification request." });
  }

  const config = getConfig();
  if (config.error === "bot_token_missing") {
    return res.status(503).json({ error: "Discord bot is not connected yet. Add DISCORD_BOT_TOKEN to Vercel Production." });
  }
  if (config.error) return res.status(503).json({ error: "Notification storage is not configured." });

  try {
    const stateQuery = new URLSearchParams({ id: "eq.main", select: "data", limit: "1" });
    const stateResponse = await supabaseRequest(config, "app_state?" + stateQuery, { method: "GET" });
    if (!stateResponse.ok) {
      console.error("Notification state lookup failed:", stateResponse.status, (await stateResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not read the selected portal record." });
    }
    const stateRows = await stateResponse.json();
    const state = stateRows[0]?.data || {};
    const sourceKey = ({ person: "people", operation: "operations", report: "reports", investigation: "investigations" })[type];
    const records = Array.isArray(state[sourceKey]) ? state[sourceKey] : [];
    const record = records.find(item => String(item?.id ?? "") === entityId);
    if (!record) return res.status(404).json({ error: "The selected record was not found. Refresh the portal and try again." });

    const recipientQuery = new URLSearchParams({
      select: "discord_user_id,display_name",
      notifications_enabled: "eq.true",
      is_active: "eq.true",
      is_banned: "eq.false",
      order: "created_at.asc"
    });
    const recipientResponse = await supabaseRequest(config, "staff_profiles?" + recipientQuery, { method: "GET" });
    if (!recipientResponse.ok) {
      console.error("Notification recipient lookup failed:", recipientResponse.status, (await recipientResponse.text()).slice(0, 250));
      return res.status(502).json({ error: "Could not load opted-in notification recipients." });
    }
    const recipientRows = await recipientResponse.json();
    const recipients = [...new Map(recipientRows
      .filter(row => /^\d{17,20}$/.test(String(row.discord_user_id || "")))
      .map(row => [String(row.discord_user_id), row])).values()];

    if (!recipients.length) {
      return res.status(200).json({
        ok: true, total: 0, sent: 0, failed: 0,
        message: "No active members have opted in to Discord notifications yet."
      });
    }
    if (recipients.length > MAX_RECIPIENTS_PER_BATCH) {
      return res.status(409).json({
        error: `This manual batch has ${recipients.length} opted-in recipients. The safe single-request limit is ${MAX_RECIPIENTS_PER_BATCH}; use a queued delivery workflow before sending to a larger group.`
      });
    }

    const batchResponse = await supabaseRequest(config, "discord_notification_batches", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({
        batch_key: batchKey,
        actor_discord_id: user.id,
        entity_type: type,
        entity_id: entityId,
        total_recipients: recipients.length
      })
    });
    if (batchResponse.status === 409 || batchResponse.status === 23505) {
      return res.status(409).json({ error: "This notification request has already been submitted." });
    }
    if (!batchResponse.ok) {
      console.error("Notification batch creation failed:", batchResponse.status, (await batchResponse.text()).slice(0, 300));
      return res.status(502).json({ error: "Could not start the notification batch." });
    }
    const batchRows = await batchResponse.json();
    const batchId = batchRows[0]?.id;
    if (!batchId) return res.status(502).json({ error: "Could not confirm the notification batch." });

    const summary = describeRecord(type, record);
    const siteHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.SITE_URL || "";
    const siteUrl = siteHost
      ? (siteHost.startsWith("http") ? siteHost : "https://" + siteHost)
      : "";
    const embed = {
      title: truncate(summary.title, 256),
      description: truncate(summary.description, 1500),
      color: 0xD92735,
      fields: summary.fields.map(field => ({
        name: truncate(field.name, 256),
        value: truncate(field.value || "—", 1024),
        inline: Boolean(field.inline)
      })),
      footer: { text: "S.W.A.T. REDLINE • COMMAND PORTAL" },
      timestamp: new Date().toISOString(),
      ...(siteUrl ? { url: siteUrl } : {})
    };

    let sent = 0;
    let failed = 0;
    for (const recipient of recipients) {
      let status = "failed";
      let errorCode = null;
      try {
        const dm = await discordRequest(config, "/users/@me/channels", {
          method: "POST",
          body: JSON.stringify({ recipient_id: recipient.discord_user_id })
        });
        if (!dm.id) throw Object.assign(new Error("discord_dm_channel_missing"), { code: "dm_channel_missing" });

        await discordRequest(config, "/channels/" + encodeURIComponent(dm.id) + "/messages", {
          method: "POST",
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] }
          })
        });
        status = "sent";
        sent++;
      } catch (error) {
        failed++;
        errorCode = String(error?.code || error?.message || "delivery_failed").slice(0, 80);
      }

      const deliveryWrite = await supabaseRequest(config, "discord_notification_deliveries", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          batch_id: batchId,
          recipient_discord_id: recipient.discord_user_id,
          status,
          error_code: errorCode
        })
      });
      if (!deliveryWrite.ok) {
        console.error("Notification delivery audit insert failed:", deliveryWrite.status, (await deliveryWrite.text()).slice(0, 200));
      }

      // Sequential delivery with a modest pause avoids a burst of DM-channel creation.
      if (recipients.length > 1) await new Promise(resolve => setTimeout(resolve, 300));
    }

    const updateBatch = await supabaseRequest(config, "discord_notification_batches?id=eq." + encodeURIComponent(batchId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ sent_count: sent, failed_count: failed })
    });
    if (!updateBatch.ok) {
      console.error("Notification batch summary update failed:", updateBatch.status, (await updateBatch.text()).slice(0, 200));
    }

    return res.status(200).json({
      ok: true,
      total: recipients.length,
      sent,
      failed,
      message: failed
        ? `Notification batch completed: ${sent} sent, ${failed} failed.`
        : `Notification batch completed: ${sent} sent.`
    });
  } catch (error) {
    console.error("Notification send failed:", error instanceof Error ? error.message : "unknown");
    return res.status(500).json({ error: "The notification batch could not be completed." });
  }
}
