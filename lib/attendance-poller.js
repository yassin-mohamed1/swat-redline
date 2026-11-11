import crypto from "node:crypto";
import { discordApiRequest } from "./discord-rest.js";

const DEFAULT_CHANNEL_ID = "1569735227146768434";
const TIME_ZONE = "Asia/Riyadh";
const MAX_MESSAGES_PER_RUN = 5;
const LEASE_HEARTBEAT_MS = 5000;
const LEASE_RENEW_TIMEOUT_MS = 5000;
const DISCORD_REQUEST_TIMEOUT_MS = 8000;
const MAX_RUN_PROCESSING_MS = 35000;

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
    signal: options.signal || AbortSignal.timeout(8000)
  });
}

async function discordRequest(config, path, options = {}) {
  return discordApiRequest(config.botToken, path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS)
  }, {
    maxRetries: 1,
    maxRetryWaitMs: 2500
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
  const response = await supabaseRequest(config, "rpc/claim_swat_attendance_sync_v2", {
    method: "POST",
    body: JSON.stringify({ p_channel_id: config.channelId })
  });
  if (!response.ok) {
    throw new Error("attendance_sync_claim_failed_" + response.status + ": " + (await response.text()).slice(0, 250));
  }
  return response.json();
}

async function renewLease(config, leaseToken) {
  const response = await supabaseRequest(config, "rpc/renew_swat_attendance_sync_v2", {
    method: "POST",
    body: JSON.stringify({
      p_channel_id: config.channelId,
      p_lease_token: leaseToken
    }),
    signal: AbortSignal.timeout(LEASE_RENEW_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("attendance_sync_renew_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  return response.json();
}

async function releaseLease(config, leaseToken) {
  const response = await supabaseRequest(config, "rpc/release_swat_attendance_sync_v2", {
    method: "POST",
    body: JSON.stringify({
      p_channel_id: config.channelId,
      p_lease_token: leaseToken
    }),
    signal: AbortSignal.timeout(LEASE_RENEW_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("attendance_sync_release_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  const result = await response.json();
  return result.released === true;
}

async function advanceCursor(config, leaseToken, messageId) {
  const response = await supabaseRequest(config, "rpc/advance_swat_attendance_cursor_v2", {
    method: "POST",
    body: JSON.stringify({
      p_channel_id: config.channelId,
      p_lease_token: leaseToken,
      p_message_id: messageId
    })
  });
  if (!response.ok) {
    throw new Error("attendance_sync_cursor_update_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  const result = await response.json();
  if (result.advanced !== true) {
    throw new Error("attendance_sync_lease_lost_before_cursor_advance");
  }
}

function startLeaseHeartbeat(config, leaseToken) {
  let stopped = false;
  let lost = false;
  let inFlight = null;

  const renew = () => {
    if (stopped || inFlight) return;
    inFlight = renewLease(config, leaseToken)
      .then(result => {
        if (result.renewed !== true) {
          lost = true;
          console.error("SWAT attendance lease ownership was lost.");
        }
      })
      .catch(error => {
        lost = true;
        console.error("SWAT attendance lease heartbeat failed:", error?.message || "unknown");
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(renew, LEASE_HEARTBEAT_MS);
  timer.unref?.();

  return {
    isLost: () => lost,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    }
  };
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

  const firstStamp = new Date(result.first_seen_at || message.timestamp);
  await replyToMessage(
    config,
    message,
    "✅ <@" + author.id + "> حضورك مسجّل بالفعل اليوم. أول بصمة كانت الساعة **" +
      riyadhTime(firstStamp) + "** بتوقيت الرياض.",
    author.id
  );
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
  let leaseToken = null;
  let heartbeat = null;

  try {
    const lease = await claimLease(config);
    if (!lease.claimed) {
      return res.status(200).json({ ok: true, skipped: true, reason: "attendance_sync_already_running" });
    }

    leaseToken = String(lease.lease_token || "");
    if (!leaseToken) {
      throw new Error("attendance_sync_lease_token_missing");
    }
    claimed = true;
    heartbeat = startLeaseHeartbeat(config, leaseToken);

    let cursor = lease.cursor_message_id ? String(lease.cursor_message_id) : null;
    if (!cursor) {
      const latest = await discordRequest(
        config,
        "/channels/" + encodeURIComponent(config.channelId) + "/messages?limit=1"
      );
      cursor = Array.isArray(latest) && latest[0]?.id ? String(latest[0].id) : "0";
      if (heartbeat.isLost()) {
        throw new Error("attendance_sync_lease_lost_during_initialization");
      }
      await advanceCursor(config, leaseToken, cursor);
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
    let leaseLost = false;
    const processingStartedAt = Date.now();

    for (const message of messages) {
      if (heartbeat.isLost() || Date.now() - processingStartedAt >= MAX_RUN_PROCESSING_MS) {
        leaseLost = heartbeat.isLost();
        break;
      }

      const result = await processMessage(config, message);
      if (heartbeat.isLost()) {
        leaseLost = true;
        break;
      }

      await advanceCursor(config, leaseToken, String(message.id));
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
      lease_lost: leaseLost,
      remaining_batch: Math.max(0, (Array.isArray(fetched) ? fetched.length : 0) - processed),
      cursor_message_id: processed ? String(messages[processed - 1].id) : cursor
    });
  } catch (error) {
    const code = String(error?.code || error?.message || "unknown").slice(0, 100);
    console.error("SWAT attendance polling failed:", code);
    return res.status(500).json({ error: "Attendance sync failed. The current message will be retried.", code });
  } finally {
    if (heartbeat) {
      try {
        await heartbeat.stop();
      } catch (error) {
        console.error("Attendance heartbeat shutdown failed:", error?.message || "unknown");
      }
    }
    if (claimed && leaseToken) {
      try {
        const released = await releaseLease(config, leaseToken);
        if (!released) {
          console.warn("Attendance lease was no longer owned at release time.");
        }
      } catch (error) {
        console.error("Attendance sync lease release failed:", error?.message || "unknown");
      }
    }
  }
}
