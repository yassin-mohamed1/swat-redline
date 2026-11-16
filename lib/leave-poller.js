import crypto from "node:crypto";
import { discordApiRequest } from "./discord-rest.js";

const TIME_ZONE = "Asia/Riyadh";
const MIN_MESSAGE_AGE_MS = 60_000;
const LEAVE_MESSAGE_RETENTION_MS = 10 * 60_000;
// Messages posted before this rollout keep their existing channel history.
const LEAVE_MESSAGE_AUTO_DELETE_START_AT_MS = Date.parse("2026-11-16T22:11:30:00.000Z");
const MAX_CLEANUP_HISTORY_PAGES = 2;
const MAX_CLEANUP_DELETES_PER_RUN = 100;
const MAX_MESSAGES_PER_RUN = 5;
const LEASE_HEARTBEAT_MS = 5_000;
const LEASE_RENEW_TIMEOUT_MS = 5_000;
const LEASE_RELEASE_TIMEOUT_MS = 20_000;
const DISCORD_REQUEST_TIMEOUT_MS = 8_000;
const MAX_RUN_PROCESSING_MS = 35_000;

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
  const channelId = String(process.env.LEAVE_REQUEST_CHANNEL_ID || "");
  const syncSecret = process.env.ANNOUNCEMENT_SYNC_SECRET;

  if (!base || !serviceKey || !botToken || !syncSecret ||
      !/^\d{15,22}$/.test(guildId) ||
      !/^\d{15,22}$/.test(swatRoleId) ||
      !/^\d{15,22}$/.test(channelId)) {
    return { error: "Leave request poller configuration is incomplete." };
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
    signal: options.signal || AbortSignal.timeout(8_000)
  });
}

async function discordRequest(config, path, options = {}) {
  return discordApiRequest(config.botToken, path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS)
  }, {
    maxRetries: 1,
    maxRetryWaitMs: 2_500
  });
}

async function claimLease(config) {
  const response = await supabaseRequest(config, "rpc/claim_swat_attendance_sync_v2", {
    method: "POST",
    body: JSON.stringify({ p_channel_id: config.channelId })
  });
  if (!response.ok) {
    throw new Error("leave_sync_claim_failed_" + response.status + ": " + (await response.text()).slice(0, 250));
  }
  return response.json();
}

async function renewLease(config, leaseToken) {
  const response = await supabaseRequest(config, "rpc/renew_swat_attendance_sync_v2", {
    method: "POST",
    body: JSON.stringify({ p_channel_id: config.channelId, p_lease_token: leaseToken }),
    signal: AbortSignal.timeout(LEASE_RENEW_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("leave_sync_renew_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  return response.json();
}

async function releaseLease(config, leaseToken) {
  const response = await supabaseRequest(config, "rpc/release_swat_attendance_sync_v2", {
    method: "POST",
    body: JSON.stringify({ p_channel_id: config.channelId, p_lease_token: leaseToken }),
    signal: AbortSignal.timeout(LEASE_RELEASE_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error("leave_sync_release_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  return (await response.json()).released === true;
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
    throw new Error("leave_sync_cursor_update_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  const result = await response.json();
  if (result.advanced !== true) throw new Error("leave_sync_lease_lost_before_cursor_advance");
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
          console.error("SWAT leave request lease ownership was lost.");
        }
      })
      .catch(error => {
        lost = true;
        console.error("SWAT leave request lease heartbeat failed:", error?.message || "unknown");
      })
      .finally(() => { inFlight = null; });
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

function isPersistentLeaveInstruction(message) {
  const author = message?.author || {};
  return author.bot === true && (message.pinned === true || !message.message_reference);
}

function discordSnowflakeAt(timestampMs) {
  const discordEpochMs = 1_420_070_400_000n;
  const timestamp = BigInt(Math.max(0, Math.trunc(timestampMs))) - discordEpochMs;
  return ((timestamp > 0n ? timestamp : 0n) << 22n).toString();
}

async function deleteExpiredLeaveMessages(config) {
  const channelPath = "/channels/" + encodeURIComponent(config.channelId) + "/messages";
  const messages = [];
  const deleteBefore = Date.now() - LEAVE_MESSAGE_RETENTION_MS;
  let before = discordSnowflakeAt(deleteBefore);
  let pages = 0;
  let scanComplete = false;

  try {
    for (; pages < MAX_CLEANUP_HISTORY_PAGES; pages++) {
      const query = new URLSearchParams({ before, limit: "100" });
      const page = await discordRequest(config, channelPath + "?" + query.toString(), {
        signal: AbortSignal.timeout(5_000)
      });
      if (!Array.isArray(page) || !page.length) {
        scanComplete = true;
        break;
      }
      messages.push(...page);
      const oldest = page[page.length - 1];
      const oldestAt = Date.parse(oldest?.timestamp || "");
      if (!oldest?.id || !Number.isFinite(oldestAt) ||
          oldestAt < LEAVE_MESSAGE_AUTO_DELETE_START_AT_MS || page.length < 100) {
        scanComplete = true;
        break;
      }
      before = String(oldest.id);
    }

    const seen = new Set();
    const expired = messages
      .filter(message => {
        const id = String(message?.id || "");
        const sentAt = Date.parse(message?.timestamp || "");
        if (!id || seen.has(id) || !Number.isFinite(sentAt)) return false;
        seen.add(id);
        return sentAt >= LEAVE_MESSAGE_AUTO_DELETE_START_AT_MS &&
          sentAt <= deleteBefore &&
          !isPersistentLeaveInstruction(message);
      })
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(0, MAX_CLEANUP_DELETES_PER_RUN);
    const ids = expired.map(message => String(message.id));

    if (!ids.length) {
      return { scanned: messages.length, due: 0, deleted: 0, failed: 0, pages, scan_complete: scanComplete };
    }

    const auditReason = "Leave request messages expire after 10 minutes";
    if (ids.length === 1) {
      await discordRequest(config, channelPath + "/" + encodeURIComponent(ids[0]), {
        method: "DELETE",
        headers: { "X-Audit-Log-Reason": auditReason }
      });
    } else {
      await discordRequest(config, channelPath + "/bulk-delete", {
        method: "POST",
        headers: { "X-Audit-Log-Reason": auditReason },
        body: JSON.stringify({ messages: ids })
      });
    }

    return {
      scanned: messages.length,
      due: expired.length,
      deleted: ids.length,
      failed: 0,
      pages,
      scan_complete: scanComplete
    };
  } catch (error) {
    return {
      scanned: messages.length,
      due: 0,
      deleted: 0,
      failed: 1,
      pages,
      scan_complete: scanComplete,
      error: String(error?.code || error?.status || error?.message || "leave_message_cleanup_failed").slice(0, 120)
    };
  }
}

function discordAvatarUrl(member, guildId) {
  const user = member?.user || {};
  const userId = String(user.id || "");
  const validHash = value => typeof value === "string" && /^[a-zA-Z0-9_]+$/.test(value);
  if (validHash(member?.avatar) && /^\d{15,22}$/.test(userId)) {
    const ext = member.avatar.startsWith("a_") ? "gif" : "png";
    return "https://cdn.discordapp.com/guilds/" + guildId + "/users/" + userId + "/avatars/" + member.avatar + "." + ext + "?size=256";
  }
  if (validHash(user.avatar) && /^\d{15,22}$/.test(userId)) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";
    return "https://cdn.discordapp.com/avatars/" + userId + "/" + user.avatar + "." + ext + "?size=256";
  }
  if (/^\d{15,22}$/.test(userId)) {
    return "https://cdn.discordapp.com/embed/avatars/" + Number((BigInt(userId) >> 22n) % 6n) + ".png";
  }
  return null;
}

async function getProfile(config, userId) {
  const query = new URLSearchParams({
    discord_user_id: "eq." + String(userId),
    is_active: "eq.true",
    is_banned: "eq.false",
    select: "discord_user_id,display_name,username,avatar_url",
    limit: "1"
  });
  const response = await supabaseRequest(config, "staff_profiles?" + query.toString());
  if (!response.ok) {
    throw new Error("leave_profile_lookup_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  return (await response.json())[0] || null;
}

async function findExistingRequest(config, messageId) {
  const query = new URLSearchParams({
    discord_channel_id: "eq." + config.channelId,
    discord_message_id: "eq." + String(messageId),
    select: "id,acknowledgement_message_id",
    limit: "1"
  });
  const response = await supabaseRequest(config, "attendance_leave_requests?" + query.toString());
  if (!response.ok) {
    throw new Error("leave_request_duplicate_lookup_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
  return (await response.json())[0] || null;
}

async function updateAcknowledgementId(config, requestId, acknowledgementId) {
  const response = await supabaseRequest(
    config,
    "attendance_leave_requests?id=eq." + encodeURIComponent(requestId),
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ acknowledgement_message_id: String(acknowledgementId), updated_at: new Date().toISOString() })
    }
  );
  if (!response.ok) {
    throw new Error("leave_acknowledgement_save_failed_" + response.status + ": " + (await response.text()).slice(0, 200));
  }
}

async function createOrLoadRequest(config, message, member, profile) {
  const existing = await findExistingRequest(config, message.id);
  if (existing) return existing;

  const rawContent = String(message.content || "").trim();
  const submittedAt = new Date(message.timestamp);
  const displayName = String(member.nick || member.user?.global_name || member.user?.username || profile.display_name || "SWAT Member").slice(0, 100);
  const payload = {
    discord_user_id: String(message.author.id),
    display_name: displayName,
    avatar_url: profile.avatar_url || discordAvatarUrl(member, config.guildId),
    reason: rawContent.slice(0, 2_000),
    start_date: null,
    end_date: null,
    status: "pending",
    source: "discord",
    discord_channel_id: config.channelId,
    discord_message_id: String(message.id),
    discord_message_url: "https://discord.com/channels/" + config.guildId + "/" + config.channelId + "/" + String(message.id),
    submitted_at: submittedAt.toISOString(),
    dm_status: "not_sent"
  };

  const response = await supabaseRequest(config, "attendance_leave_requests", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(payload)
  });

  if (response.ok) {
    const rows = await response.json();
    if (rows[0]) return { id: rows[0].id, acknowledgement_message_id: rows[0].acknowledgement_message_id || null };
  } else if (response.status !== 409) {
    throw new Error("leave_request_create_failed_" + response.status + ": " + (await response.text()).slice(0, 250));
  }

  const concurrent = await findExistingRequest(config, message.id);
  if (!concurrent) throw new Error("leave_request_create_conflict_without_existing_row");
  return concurrent;
}

async function processMessage(config, message) {
  const author = message.author || {};
  if (!author.id || author.bot || author.system) return { skipped: "bot_or_system" };

  const member = await getGuildMember(config, author.id);
  if (!member || !Array.isArray(member.roles) || !member.roles.includes(config.swatRoleId)) {
    await replyToMessage(
      config,
      message,
      "⚠️ قناة طلبات الإجازة مخصصة لأعضاء S.W.A.T النشطين فقط. راجع الإدارة إذا كنت تعتقد أن هذا خطأ.",
      null
    );
    return { skipped: "not_swat" };
  }

  const profile = await getProfile(config, author.id);
  if (!profile) {
    await replyToMessage(
      config,
      message,
      "⚠️ لم يتم العثور على حساب S.W.A.T نشط لك في الموقع. راجع الإدارة لتفعيل حسابك.",
      null
    );
    return { skipped: "inactive_portal_profile" };
  }

  const content = String(message.content || "").trim();
  if (content.length < 3) {
    await replyToMessage(
      config,
      message,
      "⚠️ لم أتمكن من تسجيل الطلب لأن الرسالة قصيرة جدًا. اكتب تفاصيل الإجازة وسببها ثم أرسل رسالة جديدة.",
      author.id
    );
    return { skipped: "empty_or_short_message" };
  }

  const request = await createOrLoadRequest(config, message, member, profile);
  if (!request.acknowledgement_message_id) {
    const acknowledgement = await replyToMessage(
      config,
      message,
      "✅ <@" + author.id + "> تم استلام طلب الإجازة بنجاح. تم إرسال طلبك إلى الإدارة للمراجعة، وسيصلك القرار عبر رسالة خاصة على Discord.",
      author.id
    );
    if (!acknowledgement?.id) throw new Error("leave_acknowledgement_message_missing");
    await updateAcknowledgementId(config, request.id, acknowledgement.id);
  }

  return { recorded: true, request_id: request.id, user_id: author.id };
}

export async function handleLeaveRequestPoller(req, res) {
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
      return res.status(200).json({ ok: true, skipped: true, reason: "leave_sync_already_running" });
    }

    leaseToken = String(lease.lease_token || "");
    if (!leaseToken) throw new Error("leave_sync_lease_token_missing");
    claimed = true;
    heartbeat = startLeaseHeartbeat(config, leaseToken);

    const messageCleanup = await deleteExpiredLeaveMessages(config);
    if (messageCleanup.failed) {
      console.error("SWAT leave message cleanup failed:", messageCleanup.error || "unknown");
    }

    let cursor = lease.cursor_message_id ? String(lease.cursor_message_id) : null;
    if (!cursor) {
      const latest = await discordRequest(
        config,
        "/channels/" + encodeURIComponent(config.channelId) + "/messages?limit=1"
      );
      cursor = Array.isArray(latest) && latest[0]?.id ? String(latest[0].id) : "0";
      if (heartbeat.isLost()) throw new Error("leave_sync_lease_lost_during_initialization");
      await advanceCursor(config, leaseToken, cursor);
      return res.status(200).json({
        ok: true,
        initialized: true,
        baseline_message_id: cursor,
        message: "Leave request polling initialized; new messages will be processed after the 60-second review buffer.",
        message_cleanup: messageCleanup
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
    let skipped = 0;
    let waitingForMaturity = false;
    const processingStartedAt = Date.now();

    for (const message of messages) {
      if (heartbeat.isLost() || Date.now() - processingStartedAt >= MAX_RUN_PROCESSING_MS) break;

      // The bot's own acknowledgement must not wait another 60 seconds,
      // otherwise it would hold the cursor ahead of the next staff request.
      const author = message.author || {};
      if (!author.id || author.bot || author.system) {
        await advanceCursor(config, leaseToken, String(message.id));
        processed++;
        skipped++;
        continue;
      }

      const messageDate = new Date(message.timestamp || "");
      if (Number.isNaN(messageDate.getTime())) throw new Error("leave_message_timestamp_invalid");
      if (Date.now() - messageDate.getTime() < MIN_MESSAGE_AGE_MS) {
        waitingForMaturity = true;
        break;
      }

      const result = await processMessage(config, message);
      if (heartbeat.isLost()) break;

      await advanceCursor(config, leaseToken, String(message.id));
      processed++;
      if (result.recorded) recorded++;
      else skipped++;
    }

    return res.status(200).json({
      ok: true,
      processed,
      recorded,
      skipped,
      waiting_for_60_second_window: waitingForMaturity,
      lease_lost: heartbeat.isLost(),
      remaining_batch: Math.max(0, (Array.isArray(fetched) ? fetched.length : 0) - processed),
      cursor_message_id: processed ? String(messages[processed - 1].id) : cursor,
      message_cleanup: messageCleanup
    });
  } catch (error) {
    const code = String(error?.code || error?.message || "unknown").slice(0, 120);
    console.error("SWAT leave request polling failed:", code);
    return res.status(500).json({ error: "Leave request sync failed. The current message will be retried.", code });
  } finally {
    if (heartbeat) {
      try { await heartbeat.stop(); }
      catch (error) { console.error("Leave request heartbeat shutdown failed:", error?.message || "unknown"); }
    }
    if (claimed && leaseToken) {
      try {
        const released = await releaseLease(config, leaseToken);
        if (!released) console.warn("Leave request sync lease was no longer owned at release time.");
      } catch (error) {
        console.error("Leave request sync lease release failed:", error?.message || "unknown");
      }
    }
  }
}
