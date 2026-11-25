const SNOWFLAKE = /^\d{15,22}$/;

export const LOG_CATEGORIES = Object.freeze({
  messages: Object.freeze(["messageDelete", "messageUpdate", "messageBulkDelete"]),
  members: Object.freeze(["memberJoin", "memberLeave", "memberNicknameUpdate"]),
  voice: Object.freeze(["voiceJoin", "voiceLeave", "voiceMove"]),
  roles: Object.freeze(["memberRoleUpdate", "roleCreate", "roleUpdate", "roleDelete"]),
  moderation: Object.freeze(["kick", "ban", "unban", "timeout"]),
  channels: Object.freeze(["channelCreate", "channelUpdate", "channelDelete"])
});

export const DEFAULT_LOGGING_EVENTS = Object.freeze(
  Object.fromEntries(Object.values(LOG_CATEGORIES).flat().map(key => [key, true]))
);

function safeChannelId(value, fallback = "") {
  const candidate = String(value || "").trim();
  return SNOWFLAKE.test(candidate) ? candidate : fallback;
}

function safeMessage(value, max = 1800) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeImageUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? candidate.slice(0, 2048) : "";
  } catch {
    return "";
  }
}

export function normalizeBotControlSettings(raw, fallbackChannelId = "") {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const source = root.botControl && typeof root.botControl === "object" ? root.botControl : root;
  const rawLogging = source.logging && typeof source.logging === "object" ? source.logging : {};
  const rawCategories = rawLogging.categories && typeof rawLogging.categories === "object" ? rawLogging.categories : {};
  const rawEvents = rawLogging.events && typeof rawLogging.events === "object" ? rawLogging.events : {};

  const categories = {};
  for (const category of Object.keys(LOG_CATEGORIES)) {
    const value = rawCategories[category] && typeof rawCategories[category] === "object"
      ? rawCategories[category]
      : {};
    categories[category] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : true,
      channelId: safeChannelId(value.channelId)
    };
  }

  const events = {};
  for (const key of Object.keys(DEFAULT_LOGGING_EVENTS)) {
    events[key] = typeof rawEvents[key] === "boolean" ? rawEvents[key] : true;
  }

  const rawWelcome = source.welcome && typeof source.welcome === "object" ? source.welcome : {};
  const welcome = {
    enabled: rawWelcome.enabled === true,
    channelId: safeChannelId(rawWelcome.channelId),
    message: safeMessage(rawWelcome.message),
    imageUrl: safeImageUrl(rawWelcome.imageUrl),
    goodbyeEnabled: rawWelcome.goodbyeEnabled === true,
    goodbyeChannelId: safeChannelId(rawWelcome.goodbyeChannelId),
    goodbyeMessage: safeMessage(rawWelcome.goodbyeMessage)
  };

  return {
    logging: {
      enabled: rawLogging.enabled !== false,
      defaultChannelId: safeChannelId(rawLogging.defaultChannelId, safeChannelId(fallbackChannelId)),
      categories,
      events
    },
    welcome
  };
}

export async function fetchBotControlSettings({
  supabaseUrl,
  serviceRoleKey,
  fallbackChannelId = "",
  fetchImpl = fetch,
  timeoutMs = 6000
} = {}) {
  const baseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl || !serviceRoleKey) throw new Error("bot_control_supabase_configuration_missing");

  const query = new URLSearchParams({
    id: "eq.swat-bot-control",
    select: "data",
    limit: "1"
  });
  const response = await fetchImpl(baseUrl + "/rest/v1/app_state?" + query, {
    method: "GET",
    headers: {
      apikey: serviceRoleKey,
      Authorization: "Bearer " + serviceRoleKey,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const error = new Error("bot_control_settings_read_failed");
    error.status = response.status;
    throw error;
  }
  const rows = await response.json();
  return normalizeBotControlSettings(rows[0]?.data || {}, fallbackChannelId);
}
