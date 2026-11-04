import crypto from "node:crypto";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RECIPIENTS_PER_MESSAGE = 200;
const DM_CHUNK_LIMIT = 1800;
const PERMANENT_DM_ERRORS = new Set(["50007", "50278", "10007", "10013"]);

function secureEquals(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function getConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
  const guildId = process.env.DISCORD_GUILD_ID || "";
  const syncSecret = process.env.ANNOUNCEMENT_SYNC_SECRET;

  if (!base || !serviceKey || !botToken || !channelId || !syncSecret) {
    return { error: "Announcement forwarder configuration is incomplete." };
  }

  if (!/^\d{17,20}$/.test(channelId)) {
    return { error: "DISCORD_ANNOUNCEMENT_CHANNEL_ID is invalid." };
  }

  return { base, serviceKey, botToken, channelId, guildId, syncSecret };
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
    const error = new Error("discord_" + String(data.code || response.status));
    error.code = String(data.code || response.status);
    throw error;
  }
  return data;
}

async function readRows(response, label) {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 250);
    throw new Error(label + "_lookup_failed_" + response.status + (detail ? ": " + detail : ""));
  }
  return response.json();
}

function chunkText(value, limit = DM_CHUNK_LIMIT) {
  const text = String(value ?? "").trim();
  if (!text) return [""];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.55)) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildForwardParts(message, config) {
  const author = message.author || {};
  const authorName = author.global_name || author.display_name || author.username || "مستخدم غير معروف";
  const authorType = author.bot ? " • BOT" : "";
  const lines = [];

  if (message.content) lines.push(String(message.content));

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length) {
    lines.push("📎 المرفقات:");
    for (const attachment of attachments) {
      const name = attachment.filename || attachment.title || "ملف مرفق";
      const url = attachment.url || attachment.proxy_url || "";
      lines.push(url ? "• [" + name + "](" + url + ")" : "• " + name);
    }
  }

  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const embedLines = [];
    if (embed.title) embedLines.push("**" + embed.title + "**");
    if (embed.url) embedLines.push(embed.url);
    if (embed.description) embedLines.push(embed.description);
    if (Array.isArray(embed.fields)) {
      for (const field of embed.fields) {
        embedLines.push((field.name ? "**" + field.name + "**\n" : "") + String(field.value || ""));
      }
    }
    if (embed.image?.url) embedLines.push("🖼️ " + embed.image.url);
    if (embed.thumbnail?.url) embedLines.push("🖼️ " + embed.thumbnail.url);
    if (embed.video?.url) embedLines.push("🎬 " + embed.video.url);
    if (embedLines.length) lines.push(embedLines.join("\n"));
  }

  if (!lines.length) lines.push("رسالة بدون نص، تحتوي على مرفق أو محتوى غير نصي.");

  const messageDate = message.timestamp ? new Date(message.timestamp) : null;
  const dateText = messageDate && !Number.isNaN(messageDate.getTime())
    ? messageDate.toLocaleString("en-GB", { timeZone: "Asia/Riyadh" }) + " (Riyadh)"
    : "غير متاح";
  const sourceUrl = config.guildId
    ? "https://discord.com/channels/" + config.guildId + "/" + config.channelId + "/" + message.id
    : "";
  const header = [
    "📣 إعلان جديد من روم الإعلانات",
    "👤 المرسل: " + authorName + authorType,
    "🕒 " + dateText,
    sourceUrl ? "🔗 فتح الرسالة الأصلية: " + sourceUrl : ""
  ].filter(Boolean).join("\n");

  const bodyText = lines.join("\n\n");
  const firstPrefix = header + "\n\n";
  const firstLimit = Math.max(300, 2000 - firstPrefix.length - 4);
  const rawParts = chunkText(bodyText, firstLimit);
  const parts = [firstPrefix + (rawParts.shift() || "")];
  const continuationPrefixLength = "📣 استكمال الإعلان — الجزء 999/999\n\n".length;
  const continuationLimit = 2000 - continuationPrefixLength - 4;
  for (const rawPart of rawParts) {
    parts.push(...chunkText(rawPart, continuationLimit));
  }
  return parts.map((part, index) => {
    if (index === 0) return part;
    const prefix = "📣 استكمال الإعلان — الجزء " + (index + 1) + "/" + parts.length + "\n\n";
    return prefix + part;
  });
}

async function upsertDelivery(config, messageId, recipientId, status, errorCode = null) {
  const query = new URLSearchParams({ on_conflict: "message_id,recipient_discord_id" });
  const response = await supabaseRequest(
    config,
    "discord_announcement_forward_deliveries?" + query.toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        message_id: messageId,
        recipient_discord_id: recipientId,
        status,
        error_code: errorCode,
        attempted_at: new Date().toISOString()
      })
    }
  );
  if (!response.ok) {
    throw new Error("delivery_status_write_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
}

async function sendToRecipient(config, recipient, parts) {
  const dm = await discordRequest(config, "/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: recipient.discord_user_id })
  });
  if (!dm.id) throw Object.assign(new Error("discord_dm_channel_missing"), { code: "dm_channel_missing" });

  for (const content of parts) {
    await discordRequest(config, "/channels/" + encodeURIComponent(dm.id) + "/messages", {
      method: "POST",
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }
      })
    });
  }
}

async function runWorkerPool(items, workerCount, worker) {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }));
}

export async function handleAnnouncementForwarder(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const config = getConfig();
  if (config.error) return res.status(503).json({ error: config.error });

  const providedSecret = req.headers["x-announcement-sync-secret"];
  if (!secureEquals(Array.isArray(providedSecret) ? providedSecret[0] : providedSecret, config.syncSecret)) {
    return res.status(401).json({ error: "Unauthorized scheduler request." });
  }

  try {
    if (req.query?.diagnostics === "channel") {
      const channel = await discordRequest(config, "/channels/" + encodeURIComponent(config.channelId));
      return res.status(200).json({
        ok: true,
        channel_id: channel.id,
        channel_name: channel.name || null,
        channel_guild_id: channel.guild_id || null,
        configured_guild_id: config.guildId || null,
        configured_guild_matches_channel: Boolean(config.guildId && channel.guild_id === config.guildId)
      });
    }

    const stateQuery = new URLSearchParams({
      channel_id: "eq." + config.channelId,
      select: "channel_id,cursor_message_id",
      limit: "1"
    });
    const stateResponse = await supabaseRequest(config, "discord_announcement_sync_state?" + stateQuery);
    const stateRows = await readRows(stateResponse, "sync_state");

    let cursor = stateRows[0]?.cursor_message_id ?? null;
    if (!stateRows.length) {
      // Establish a clean starting point. Existing channel history is not bulk-DMed.
      const latestMessages = await discordRequest(
        config,
        "/channels/" + encodeURIComponent(config.channelId) + "/messages?limit=1"
      );
      cursor = latestMessages[0]?.id || "0";
      const insertState = await supabaseRequest(config, "discord_announcement_sync_state", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({
          channel_id: config.channelId,
          cursor_message_id: cursor,
          initialized_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      if (!insertState.ok && insertState.status !== 409) {
        throw new Error("sync_state_initialize_failed_" + insertState.status + ": " + (await insertState.text()).slice(0, 200));
      }
      return res.status(200).json({
        ok: true,
        initialized: true,
        baseline_message_id: cursor,
        message: "The announcement forwarder is initialized. New messages will be forwarded from now on."
      });
    }

    const newMessages = await discordRequest(
      config,
      "/channels/" + encodeURIComponent(config.channelId) +
        "/messages?after=" + encodeURIComponent(cursor || "0") + "&limit=100"
    );
    const orderedMessages = (Array.isArray(newMessages) ? newMessages : [])
      .filter(message => message?.id && BigInt(message.id) > BigInt(cursor || "0"))
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

    if (!orderedMessages.length) {
      return res.status(200).json({ ok: true, processed: 0, message: "No new announcement messages." });
    }

    // Process one original message per tick to keep DM delivery ordered and retryable.
    const message = orderedMessages[0];
    const author = message.author || {};
    const authorId = String(author.id || "unknown");
    const authorName = String(author.global_name || author.username || "Unknown Discord user");

    const forwardQuery = new URLSearchParams({
      message_id: "eq." + message.id,
      select: "message_id,status",
      limit: "1"
    });
    const forwardResponse = await supabaseRequest(config, "discord_announcement_forwards?" + forwardQuery);
    const forwardRows = await readRows(forwardResponse, "forward_record");

    if (!forwardRows.length) {
      const insertForward = await supabaseRequest(config, "discord_announcement_forwards", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          message_id: message.id,
          channel_id: config.channelId,
          author_id: authorId,
          author_username: authorName,
          author_is_bot: Boolean(author.bot),
          message_created_at: message.timestamp || null,
          status: "pending"
        })
      });
      if (!insertForward.ok && insertForward.status !== 409) {
        throw new Error("forward_record_create_failed_" + insertForward.status + ": " + (await insertForward.text()).slice(0, 200));
      }
    }

    const recipientsQuery = new URLSearchParams({
      select: "discord_user_id,display_name",
      notifications_enabled: "eq.true",
      is_active: "eq.true",
      is_banned: "eq.false",
      order: "created_at.asc",
      limit: String(MAX_RECIPIENTS_PER_MESSAGE + 1)
    });
    const recipientsResponse = await supabaseRequest(config, "staff_profiles?" + recipientsQuery);
    const recipientRows = await readRows(recipientsResponse, "recipients");
    const recipients = [...new Map(recipientRows
      .filter(row => /^\d{17,20}$/.test(String(row.discord_user_id || "")))
      .map(row => [String(row.discord_user_id), row])).values()];

    if (recipients.length > MAX_RECIPIENTS_PER_MESSAGE) {
      return res.status(409).json({
        error: "More than " + MAX_RECIPIENTS_PER_MESSAGE + " portal members have private notifications enabled. Increase the safe batch workflow before forwarding.",
        recipient_count: recipients.length
      });
    }

    const deliveriesQuery = new URLSearchParams({
      message_id: "eq." + message.id,
      select: "recipient_discord_id,status,error_code"
    });
    const deliveryResponse = await supabaseRequest(config, "discord_announcement_forward_deliveries?" + deliveriesQuery);
    const deliveryRows = await readRows(deliveryResponse, "delivery_status");
    const deliveryMap = new Map(deliveryRows.map(row => [String(row.recipient_discord_id), row]));
    const parts = buildForwardParts(message, config);

    let sentCount = 0;
    let skippedCount = 0;
    let transientFailures = 0;

    await runWorkerPool(recipients, 4, async recipient => {
      const recipientId = String(recipient.discord_user_id);
      const previous = deliveryMap.get(recipientId);

      if (previous?.status === "sent" || previous?.status === "skipped" ||
          (previous?.status === "failed" && PERMANENT_DM_ERRORS.has(String(previous.error_code || "")))) {
        if (previous.status === "sent") sentCount++;
        else skippedCount++;
        return;
      }

      try {
        await sendToRecipient(config, recipient, parts);
        await upsertDelivery(config, message.id, recipientId, "sent");
        sentCount++;
      } catch (error) {
        const code = String(error?.code || error?.message || "delivery_failed").slice(0, 80);
        if (PERMANENT_DM_ERRORS.has(code)) {
          await upsertDelivery(config, message.id, recipientId, "skipped", code);
          skippedCount++;
        } else {
          await upsertDelivery(config, message.id, recipientId, "failed", code);
          transientFailures++;
        }
      }
    });

    if (transientFailures > 0) {
      const partialUpdate = await supabaseRequest(
        config,
        "discord_announcement_forwards?message_id=eq." + encodeURIComponent(message.id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "partial",
            recipient_count: recipients.length,
            sent_count: sentCount,
            skipped_count: skippedCount,
            failed_count: transientFailures,
            last_error: "Some direct messages failed transiently and will be retried on the next scheduled run."
          })
        }
      );
      if (!partialUpdate.ok) throw new Error("forward_partial_update_failed_" + partialUpdate.status);
      return res.status(200).json({
        ok: true,
        processed: 0,
        pending_retry: true,
        message_id: message.id,
        sent: sentCount,
        skipped: skippedCount,
        retry: transientFailures,
        message: "Some recipients could not be reached yet. The next run will retry only those recipients."
      });
    }

    const finalStatus = skippedCount > 0 ? "partial" : "sent";
    const completeUpdate = await supabaseRequest(
      config,
      "discord_announcement_forwards?message_id=eq." + encodeURIComponent(message.id),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          status: finalStatus,
          recipient_count: recipients.length,
          sent_count: sentCount,
          skipped_count: skippedCount,
          failed_count: 0,
          last_error: skippedCount > 0 ? "Some members cannot receive DMs from this bot." : null,
          completed_at: new Date().toISOString()
        })
      }
    );
    if (!completeUpdate.ok) throw new Error("forward_complete_update_failed_" + completeUpdate.status);

    const cursorUpdate = await supabaseRequest(
      config,
      "discord_announcement_sync_state?channel_id=eq." + encodeURIComponent(config.channelId),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          cursor_message_id: message.id,
          updated_at: new Date().toISOString()
        })
      }
    );
    if (!cursorUpdate.ok) throw new Error("sync_cursor_update_failed_" + cursorUpdate.status);

    return res.status(200).json({
      ok: true,
      processed: 1,
      message_id: message.id,
      sender: authorName,
      sender_is_bot: Boolean(author.bot),
      total: recipients.length,
      sent: sentCount,
      skipped: skippedCount,
      remaining_in_backlog: Math.max(0, orderedMessages.length - 1),
      message: "Announcement forwarded to opted-in portal members."
    });
  } catch (error) {
    const code = String(error?.code || error?.message || "unknown").slice(0, 80);
    console.error("Announcement forwarder failed:", code);
    return res.status(500).json({ error: "Announcement forwarding failed. The current message will be retried.", code, channel_id: config.channelId, configured_guild_id: config.guildId || null });
  }
}
