import { discordApiRequest } from "./discord-rest.js";

const MAX_PAGES_PER_REQUEST = 15;
const DISCORD_PAGE_SIZE = 1000;
const MAX_SELECTED_MEMBERS = 100;
const EXISTING_ID_CHUNK = 100;

function json(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(body);
}

async function supabaseRequest(base, key, path, init = {}) {
  return fetch(base + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      ...(init.headers || {})
    },
    signal: init.signal || AbortSignal.timeout(12000)
  });
}

function discordAvatar(member, userId) {
  const user = member?.user || {};
  const hash = user.avatar;
  if (typeof hash === "string" && /^[a-zA-Z0-9_]+$/.test(hash)) {
    return "https://cdn.discordapp.com/avatars/" + userId + "/" + hash + "." +
      (hash.startsWith("a_") ? "gif" : "png") + "?size=128";
  }
  const index = Number(BigInt(userId) >> 22n) % 6;
  return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
}

function toCandidate(member) {
  const user = member?.user || {};
  const id = String(user.id || "");
  if (!/^\d{15,22}$/.test(id) || user.bot === true) return null;
  const username = String(user.username || "").slice(0, 100);
  return {
    discord_user_id: id,
    display_name: String(member.nick || user.global_name || username || "Discord user").slice(0, 100),
    username,
    avatar_url: discordAvatar(member, id)
  };
}

function profileFromDiscordMember(member, now) {
  const user = member?.user || {};
  const id = String(user.id || "");
  if (!/^\d{15,22}$/.test(id) || user.bot === true) return null;
  const username = String(user.username || "").slice(0, 100);
  const displayName = String(member.nick || user.global_name || username || "Discord user").slice(0, 100);
  return {
    discord_user_id: id,
    display_name: displayName,
    username,
    avatar_url: discordAvatar(member, id),
    is_active: true,
    is_banned: false,
    login_count: 0,
    last_seen: null,
    last_login: null,
    notifications_enabled: true,
    discord_roles: Array.isArray(member.roles) ? member.roles : [],
    discord_roles_synced_at: now,
    is_manual: false,
    manual_created_by_discord_id: null,
    registration_source: "bot_role",
    created_at: now,
    updated_at: now
  };
}

async function loadSyncConfig() {
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = String(process.env.DISCORD_GUILD_ID || "");
  const roleId = String(process.env.DISCORD_ROLE_ID || "");
  if (!base || !key || !token || !/^\d{15,22}$/.test(guildId) || !/^\d{15,22}$/.test(roleId)) {
    throw Object.assign(new Error("إعدادات Discord أو Supabase المطلوبة للفحص غير مكتملة."), { status: 503 });
  }
  return { base, key, token, guildId, roleId };
}

async function loadSyncCursor(base, key, guildId) {
  const query = new URLSearchParams({
    guild_id: "eq." + guildId,
    select: "guild_id,cursor_id",
    limit: "1"
  });
  const response = await supabaseRequest(base, key, "discord_role_sync_state?" + query.toString());
  if (!response.ok) {
    throw Object.assign(new Error("تعذّر قراءة موضع فحص أعضاء Discord."), { status: 503 });
  }
  const rows = await response.json();
  if (rows.length) return rows[0].cursor_id || "0";

  const create = await supabaseRequest(base, key, "discord_role_sync_state", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ guild_id: guildId, cursor_id: "0" })
  });
  if (!create.ok && create.status !== 409) {
    throw Object.assign(new Error("تعذّر إنشاء حالة فحص أعضاء Discord."), { status: 503 });
  }
  return "0";
}

async function saveSyncCursor(base, key, guildId, cursor, cycleComplete = false) {
  const query = new URLSearchParams({ guild_id: "eq." + guildId });
  const response = await supabaseRequest(base, key, "discord_role_sync_state?" + query.toString(), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      cursor_id: cursor,
      ...(cycleComplete ? { last_completed_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString()
    })
  });
  if (!response.ok) {
    throw Object.assign(new Error("تعذّر حفظ موضع استكمال فحص أعضاء Discord."), { status: 503 });
  }
}

async function existingProfileIds(base, key, ids) {
  const found = new Set();
  for (let offset = 0; offset < ids.length; offset += EXISTING_ID_CHUNK) {
    const chunk = ids.slice(offset, offset + EXISTING_ID_CHUNK);
    if (!chunk.length) continue;
    const query = new URLSearchParams({
      select: "discord_user_id",
      discord_user_id: "in.(" + chunk.join(",") + ")",
      limit: String(EXISTING_ID_CHUNK)
    });
    const response = await supabaseRequest(base, key, "staff_profiles?" + query.toString());
    if (!response.ok) {
      console.error("Existing staff profile lookup failed:", response.status, (await response.text()).slice(0, 250));
      throw Object.assign(new Error("تعذّر استبعاد الأعضاء المسجلين بالفعل في الموقع."), { status: 503 });
    }
    for (const row of await response.json()) found.add(String(row.discord_user_id));
  }
  return found;
}

async function saveNewProfiles(base, key, members, now) {
  const profiles = members.map(member => profileFromDiscordMember(member, now)).filter(Boolean);
  if (!profiles.length) return 0;

  // Duplicate IDs are ignored. The preview is never allowed to overwrite existing
  // profiles, and the final insert repeats the check atomically at the database.
  const query = new URLSearchParams({ on_conflict: "discord_user_id" });
  const response = await supabaseRequest(base, key, "staff_profiles?" + query.toString(), {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(profiles)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw Object.assign(new Error("تعذّر حفظ الأعضاء الذين اخترتهم في دليل الموقع."), {
      status: 502, detail
    });
  }
  const inserted = await response.json();
  return Array.isArray(inserted) ? inserted.length : 0;
}

async function requestGuildMember(token, guildId, id) {
  try {
    return await discordApiRequest(token, "/guilds/" + guildId + "/members/" + id, {}, {
      maxRetries: 2,
      maxRetryWaitMs: 5000
    });
  } catch (error) {
    if (Number(error.status) === 404) return null;
    throw error;
  }
}

async function listCandidates(res, config) {
  const { base, key, token, guildId, roleId } = config;
  let cursor = await loadSyncCursor(base, key, guildId);
  let pages = 0, scanned = 0, matchesCount = 0;
  let cycleComplete = false;
  const candidates = [];
  const seen = new Set();

  while (pages < MAX_PAGES_PER_REQUEST) {
    const query = new URLSearchParams({ limit: String(DISCORD_PAGE_SIZE) });
    if (cursor !== "0") query.set("after", cursor);
    let batch;
    try {
      batch = await discordApiRequest(token, "/guilds/" + guildId + "/members?" + query.toString(), {}, {
        maxRetries: 2,
        maxRetryWaitMs: 7000
      });
    } catch (error) {
      const code = String(error.code || error.status || "unknown");
      if (Number(error.status) === 403 && code === "50001") {
        return json(res, 403, {
          error: "Discord رفض قراءة قائمة الأعضاء. تأكد من تفعيل Server Members Intent للبوت.",
          code
        });
      }
      console.error("Discord role candidate scan failed:", JSON.stringify({
        status: Number(error.status || 0), code, path: error.path || null
      }));
      return json(res, Number(error.status) === 429 ? 503 : 502, {
        error: "تعذّر جلب قائمة أعضاء Discord.",
        code
      });
    }
    if (!Array.isArray(batch)) return json(res, 502, { error: "أعاد Discord قائمة أعضاء غير صالحة." });

    pages += 1;
    scanned += batch.length;
    const matchedMembers = batch.filter(member =>
      member?.user?.bot !== true &&
      Array.isArray(member?.roles) &&
      member.roles.map(String).includes(roleId)
    );
    matchesCount += matchedMembers.length;

    const matchedIds = matchedMembers.map(member => String(member.user.id));
    const existing = await existingProfileIds(base, key, matchedIds);
    for (const member of matchedMembers) {
      const candidate = toCandidate(member);
      if (!candidate || existing.has(candidate.discord_user_id) || seen.has(candidate.discord_user_id)) continue;
      seen.add(candidate.discord_user_id);
      candidates.push(candidate);
    }

    if (!batch.length || batch.length < DISCORD_PAGE_SIZE) {
      cycleComplete = true;
      cursor = "0";
      break;
    }
    const nextCursor = String(batch[batch.length - 1]?.user?.id || "");
    if (!/^\d{15,22}$/.test(nextCursor) || nextCursor === cursor) {
      return json(res, 502, { error: "تعذّر استكمال صفحات أعضاء Discord بأمان." });
    }
    cursor = nextCursor;
    await saveSyncCursor(base, key, guildId, cursor, false);
  }

  await saveSyncCursor(base, key, guildId, cursor, cycleComplete);
  return json(res, 200, {
    ok: true,
    candidates,
    candidates_count: candidates.length,
    pages_scanned: pages,
    members_scanned: scanned,
    members_with_access_role: matchesCount,
    cycle_complete: cycleComplete,
    cursor,
    trigger: "manual_owner_button"
  });
}

async function registerSelected(res, config, selectedIds) {
  const { base, key, token, guildId, roleId } = config;
  const selected = [...new Set((Array.isArray(selectedIds) ? selectedIds : [])
    .map(value => String(value || "").trim())
    .filter(value => /^\d{15,22}$/.test(value)))];
  if (!selected.length) return json(res, 400, { error: "اختر عضوًا واحدًا على الأقل." });
  if (selected.length > MAX_SELECTED_MEMBERS) {
    return json(res, 400, { error: "يمكن إضافة 100 عضو كحد أقصى في كل مرة." });
  }

  let botId = "";
  try {
    const botUser = await discordApiRequest(token, "/users/@me");
    botId = String(botUser?.id || "");
  } catch (error) {
    console.error("Discord bot identity lookup failed:", error.status || error.message);
    return json(res, 502, { error: "تعذّر التحقق من هوية بوت S.W.A.T." });
  }

  const eligible = [];
  let notEligible = 0;
  for (let offset = 0; offset < selected.length; offset += 10) {
    const chunk = selected.slice(offset, offset + 10);
    const members = await Promise.all(chunk.map(async id => ({
      id,
      member: id === botId ? null : await requestGuildMember(token, guildId, id)
    })));
    for (const { id, member } of members) {
      if (!member || member?.user?.bot === true ||
          !Array.isArray(member?.roles) || !member.roles.map(String).includes(roleId)) {
        notEligible += 1;
        continue;
      }
      eligible.push(member);
    }
  }

  const selectedEligibleIds = eligible.map(member => String(member.user.id));
  const existing = await existingProfileIds(base, key, selectedEligibleIds);
  const alreadyRegistered = eligible.filter(member => existing.has(String(member.user.id))).length;
  const toInsert = eligible.filter(member => !existing.has(String(member.user.id)));
  const inserted = await saveNewProfiles(base, key, toInsert, new Date().toISOString());

  return json(res, 200, {
    ok: true,
    selected_count: selected.length,
    eligible_count: eligible.length,
    newly_registered: inserted,
    skipped_existing: alreadyRegistered + Math.max(0, toInsert.length - inserted),
    skipped_not_eligible: notEligible,
    registered_ids: toInsert.map(member => String(member.user.id)),
    trigger: "manual_owner_button"
  });
}

export async function handleDiscordRoleSync(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed." });
  }

  const config = await loadSyncConfig().catch(error => {
    throw error;
  });
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const action = String(body.action || "");
  if (action === "list_discord_role_candidates") return listCandidates(res, config);
  if (action === "register_selected_discord_members") {
    return registerSelected(res, config, body.discord_user_ids);
  }
  return json(res, 400, { error: "طلب فحص أعضاء Discord غير معروف." });
}
