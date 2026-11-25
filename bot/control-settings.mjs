const SNOWFLAKE = /^\d{15,22}$/;

export const LOG_CATEGORIES = Object.freeze({
  messages: Object.freeze([
    "messageDelete", "messageUpdate", "messageBulkDelete", "messagePin", "messageUnpin"
  ]),
  members: Object.freeze([
    "memberJoin", "memberLeave", "memberNicknameUpdate", "memberUpdate"
  ]),
  voice: Object.freeze(["voiceJoin", "voiceLeave", "voiceMove"]),
  roles: Object.freeze([
    "memberRoleUpdate", "roleCreate", "roleUpdate", "roleDelete", "rolePositionUpdate"
  ]),
  moderation: Object.freeze([
    "kick", "memberPrune", "ban", "unban", "timeout", "memberMove", "memberDisconnect", "botAdd"
  ]),
  channels: Object.freeze([
    "channelCreate", "channelUpdate", "channelDelete",
    "channelOverwriteCreate", "channelOverwriteUpdate", "channelOverwriteDelete", "channelPositionUpdate"
  ]),
  server: Object.freeze(["guildUpdate"]),
  audit: Object.freeze([
    "inviteCreate", "inviteUpdate", "inviteDelete",
    "webhookCreate", "webhookUpdate", "webhookDelete",
    "emojiCreate", "emojiUpdate", "emojiDelete",
    "integrationCreate", "integrationUpdate", "integrationDelete",
    "stageInstanceCreate", "stageInstanceUpdate", "stageInstanceDelete",
    "stickerCreate", "stickerUpdate", "stickerDelete",
    "guildScheduledEventCreate", "guildScheduledEventUpdate", "guildScheduledEventDelete",
    "threadCreate", "threadUpdate", "threadDelete",
    "applicationCommandPermissionUpdate",
    "soundboardSoundCreate", "soundboardSoundUpdate", "soundboardSoundDelete",
    "autoModerationRuleCreate", "autoModerationRuleUpdate", "autoModerationRuleDelete",
    "autoModerationBlockMessage", "autoModerationFlagToChannel",
    "autoModerationUserCommunicationDisabled", "autoModerationQuarantineUser",
    "creatorMonetizationRequestCreated", "creatorMonetizationTermsAccepted",
    "onboardingPromptCreate", "onboardingPromptUpdate", "onboardingPromptDelete",
    "onboardingCreate", "onboardingUpdate",
    "homeSettingsCreate", "homeSettingsUpdate",
    "voiceChannelStatusCreate", "voiceChannelStatusDelete",
    "auditLogOther"
  ])
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

function safeColor(value, fallback) {
  const candidate = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : fallback;
}

function safeNumber(value, fallback, min, max, precision = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const factor = 10 ** precision;
  return Math.max(min, Math.min(max, Math.round(number * factor) / factor));
}

function safeImageUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > 2048) return "";
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
  const rawImage = rawWelcome.image && typeof rawWelcome.image === "object" ? rawWelcome.image : {};
  const backgroundImageUrl = safeImageUrl(rawImage.backgroundImageUrl || rawWelcome.imageUrl);
  const template = ["redline-operator", "custom"].includes(rawImage.template)
    ? rawImage.template
    : backgroundImageUrl ? "custom" : "redline-operator";
  const layout = ["classic", "text", "left", "right"].includes(rawImage.layout) ? rawImage.layout : "classic";
  const avatarShape = rawImage.avatarShape === "square" ? "square" : "circle";
  const font = ["condensed", "discord", "inter", "arabic", "serif"].includes(rawImage.font) ? rawImage.font : "condensed";
  const opacityValue = Number(rawImage.overlayOpacity);
  const overlayOpacity = Number.isFinite(opacityValue)
    ? Math.max(0, Math.min(70, Math.round(opacityValue)))
    : 0;
  const image = {
    enabled: rawImage.enabled !== false,
    template,
    layout,
    avatarShape,
    avatarX: safeNumber(rawImage.avatarX, 82.8, 0, 100, 1),
    avatarY: safeNumber(rawImage.avatarY, 40, 0, 100, 1),
    avatarSize: safeNumber(rawImage.avatarSize, 17.2, 8, 35, 1),
    nameX: safeNumber(rawImage.nameX, 51.1, 0, 100, 1),
    nameY: safeNumber(rawImage.nameY, 58, 0, 100, 1),
    nameSize: safeNumber(rawImage.nameSize, 4.8, 2, 10, 1),
    nameWidth: safeNumber(rawImage.nameWidth, 36, 10, 65, 1),
    nameColor: safeColor(rawImage.nameColor, "#f1f3f4"),
    backgroundImageUrl,
    backgroundColor: safeColor(rawImage.backgroundColor, "#11151d"),
    overlayColor: safeColor(rawImage.overlayColor, "#05070b"),
    overlayOpacity,
    accentColor: safeColor(rawImage.accentColor, "#ed3545"),
    font,
    title: safeMessage(rawImage.title || "WELCOME", 60) || "WELCOME",
    serverText: safeMessage(rawImage.serverText || "TO {{server}}", 120) || "TO {{server}}"
  };
  const welcome = {
    enabled: rawWelcome.enabled === true,
    channelId: safeChannelId(rawWelcome.channelId),
    message: safeMessage(rawWelcome.message),
    imageUrl: backgroundImageUrl,
    image,
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
