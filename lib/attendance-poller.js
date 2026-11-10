import crypto from "node:crypto";
import { discordApiRequest } from "./discord-rest.js";

const DEFAULT_CHANNEL_ID = "1569735227146768434";
const TIME_ZONE = "Asia/Riyadh";
const MAX_MESSAGES_PER_RUN = 20;

function secureEquals(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function getConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  const swatRoleId = String(process.env.DISCORD_ROLE_ID || "");
  const channelId = String(process.env.ATTENDANCE_CHANNEL_ID || DEFAULT_CHANNEL_ID);
  const syncSecret = process.env.ANNOUNCEMENT_SYNC_SECRET;

  if (!base || !serviceKey || !botToken || !syncSecret ||
      !/^\d{15,22}$/.test(guildId) ||
      !/^\d{15,22}$/.test(swatRoleId) ||
      !/^\d{15,22}$/.test(channelId)) {
    return { error: "Attendance poller configuration is incomplete." };
  }
  return { base, serviceKey, botToken, guildId, swatRoleId, channelId, syncSecret };
}

async function supabaseRequest(config, path, options = {}) {
  return fetch(config.base + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: config.serviceKey,
      Authorization: "Bearer " + config.serviceKey,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: options.signal || AbortSignal.timeout(12000)
  });
}

async function discordRequest(config, path, options = {}) {
  return discordApiRequest(config.botToken, path, options, {
    maxRetries: 2,
    maxRetryWaitMs: 5000
  });
}

function riyadhDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

function riyadhTime(date) {
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

async function claimLease(config) {
  const response = await supabaseRequest(config, "rpc/claim_swat_attendance_sync", {
    method: "POST",
    body: JSON.stringify({ p_channel_id: config.channelId })
  });
  if (!response.ok) {
    throw new Error("attendance_sync_claim_failed_" + response.status + ": " + (await response.text()).slice(0, 250));
  }
  return response.json();
}

async function releaseLease(config) {
  const query = new URLSearchParams({ channel_id: "eq." + config.channelId });
  const response = await supabaseRequest(config, "attendance_sync_state?" + query.toString(), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ lease_expires_at: null, updated_at: new Date().toISOString() })
  });
  if (!response.ok) {
    throw new Error("attendance_sync_release_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
}

async function advanceCursor(config, messageId) {
  const query = new URLSearchParams({ channel_id: "eq." + config.channelId });
  const response = await supabaseRequest(config, "attendance_sync_state?" + query.toString(), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      cursor_message_id: messageId,
      updated_at: new Date().toISOString()
    })
  });
  if (!response.ok) {
    throw new Error("attendance_sync_cursor_update_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
}

async function getGuildMember(config, userId) {
  try {
    return await discordRequest(
      config,
      "/guilds/" + encodeURIComponent(config.guildId) + "/members/" + encodeURIComponent(userId)
    );
  } catch (error) {
    if (Number(error?.status) === 404) return null;
    throw error;
  }
}

async function recordDailyAttendance(config, message, member) {
  const author = message.author || {};
  const messageDate = new Date(message.timestamp || "");
  if (Number.isNaN(messageDate.getTime())) {
    throw new Error("attendance_message_timestamp_invalid");
  }

  const response = await supabaseRequest(config, "rpc/record_swat_daily_attendance", {
    method: "POST",
    body: JSON.stringify({
      p_discord_user_id: String(author.id),
      p_attendance_date: riyadhDate(messageDate),
      p_message_id: String(message.id),
      p_channel_id: config.channelId,
      p_display_name: String(member.nick || author.global_name || author.username || "SWAT Member").slice(0, 100),
      p_username: String(author.username || "").slice(0, 100),
      p_first_seen_at: messageDate.toISOString()
    })
  });
  if (!response.ok) {
    throw new Error("attendance_record_failed_" + response.status + ": " + (await response.text()).slice(0, 250));
  }
  return response.json();
}

async function replyToMessage(config, message, content, userId) {
  return discordRequest(config, "/channels/" + encodeURIComponent(config.channelId) + "/messages", {
    method: "POST",
    body: JSON.stringify({
      content,
      message_reference: {
        message_id: String(message.id),
        channel_id: config.channelId,
        guild_id: config.guildId,
        fail_if_not_exists: false
      },
      allowed_mentions: {
        parse: [],
        users: userId ? [String(userId)] : [],
        replied_user: false
      }
    })
  });
}

async function addCheckReaction(config, message) {
  return discordRequest(
    config,
    "/channels/" + encodeURIComponent(config.channelId) +
      "/messages/" + encodeURIComponent(message.id) +
      "/reactions/%E2%9C%85/@me",
    { method: "PUT", body: undefined }
  );
}

async function processMessage(config, message) {
  const author = message.author || {};
  if (!author.id || author.bot || author.system) return { skipped: "bot_or_system" };

  const member = await getGuildMember(config, author.id);
  if (!member || !Array.isArray(member.roles) || !member.roles.includes(config.swatRoleId)) {
    return { skipped: "not_swat" };
  }

  const result = await recordDailyAttendance(config, message, member);
  if (!result.eligible) {
    await replyToMessage(
      config,
      message,
      "⚠️ لم يتم العثور على حساب S.W.A.T نشط لك في الموقع. راجع الإدارة للتأكد من تسجيلك وتفعيل حسابك.",
      null
    );
    return { skipped: "inactive_portal_profile" };
  }

  const firstStampForThisMessage = result.recorded === true ||
    String(result.first_message_id || "") === String(message.id);

  if (firstStampForThisMessage) {
    const date = new Date(result.first_seen_at || message.timestamp);
    await replyToMessage(
      config,
      message,
      "✅ <@" + author.id + "> تم تسجيل حضورك اليوم بنجاح! 🟢\nوقت البصمة: **" +
        riyadhTime(date) + "** بتوقيت الرياض.",
      author.id
    );
    return { recorded: true, user_id: author.id };
  }

  await addCheckReaction(config, message);
  return { recorded: false, duplicate: true, user_id: author.id };
}

export async function handleAttendancePoller(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const config = getConfig();
  if (config.error) return res.status(503).json({ error: config.error });

  const provided = req.headers["x-announcement-sync-secret"];
  if (!secureEquals(Array.isArray(provided) ? provided[0] : provided, config.syncSecret)) {
    return res.status(401).json({ error: "Unauthorized scheduler request." });
  }

  let claimed = false;
  try {
    const lease = await claimLease(config);
    if (!lease.claimed) {
      return res.status(200).json({ ok: true, skipped: true, reason: "attendance_sync_already_running" });
    }
    claimed = true;

    let cursor = lease.cursor_message_id ? String(lease.cursor_message_id) : null;
    if (!cursor) {
      const latest = await discordRequest(
        config,
        "/channels/" + encodeURIComponent(config.channelId) + "/messages?limit=1"
      );
      cursor = Array.isArray(latest) && latest[0]?.id ? String(latest[0].id) : "0";
      await advanceCursor(config, cursor);
      return res.status(200).json({
        ok: true,
        initialized: true,
        baseline_message_id: cursor,
        message: "Attendance polling initialized; new messages will be processed from now on."
      });
    }

    const fetched = await discordRequest(
      config,
      "/channels/" + encodeURIComponent(config.channelId) +
        "/messages?after=" + encodeURIComponent(cursor) + "&limit=100"
    );
    const messages = (Array.isArray(fetched) ? fetched : [])
      .filter(message => message?.id && BigInt(message.id) > BigInt(cursor))
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
      .slice(0, MAX_MESSAGES_PER_RUN);

    let processed = 0;
    let recorded = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const message of messages) {
      const result = await processMessage(config, message);
      await advanceCursor(config, String(message.id));
      processed++;
      if (result.recorded) recorded++;
      else if (result.duplicate) duplicates++;
      else skipped++;
    }

    return res.status(200).json({
      ok: true,
      processed,
      recorded,
      duplicates,
      skipped,
      remaining_batch: Math.max(0, (Array.isArray(fetched) ? fetched.length : 0) - processed),
      cursor_message_id: messages.length ? String(messages[messages.length - 1].id) : cursor
    });
  } catch (error) {
    const code = String(error?.code || error?.message || "unknown").slice(0, 100);
    console.error("SWAT attendance polling failed:", code);
    return res.status(500).json({ error: "Attendance sync failed. The current message will be retried.", code });
  } finally {
    if (claimed) {
      try {
        await releaseLease(config);
      } catch (error) {
        console.error("Attendance sync lease release failed:", error?.message || "unknown");
      }
    }
  }
}
