const DEFAULTS = Object.freeze({
  cycleMs: 5_000,
  dwellMs: 0,
  maxDurationMs: 0,
  cooldownMs: 60_000,
  stopPollMs: 1_000,
  moveTimeoutMs: 8_000
});

function snowflake(value) {
  return /^\d{15,22}$/.test(String(value || ""));
}

function numberSetting(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const config = {
    token: String(env.DISCORD_BOT_TOKEN || ""),
    guildId: String(env.DISCORD_GUILD_ID || ""),
    managerRoleId: String(env.DISCORD_WARNING_MANAGER_ROLE_ID || ""),
    alertChannelId: String(env.DISCORD_ATTENTION_ALERT_CHANNEL_ID || ""),
    supabaseUrl: String(env.SUPABASE_URL || "").replace(/\/+$/, ""),
    supabaseServiceRoleKey: String(env.SUPABASE_SERVICE_ROLE_KEY || ""),
    cycleMs: numberSetting(env, "ATTENTION_ALERT_CYCLE_MS", DEFAULTS.cycleMs, 1_000, 60_000),
    dwellMs: numberSetting(env, "ATTENTION_ALERT_DWELL_MS", DEFAULTS.dwellMs, 0, 10_000),
    maxDurationMs: numberSetting(env, "ATTENTION_ALERT_MAX_DURATION_MS", DEFAULTS.maxDurationMs, 0, 900_000),
    cooldownMs: numberSetting(env, "ATTENTION_ALERT_COOLDOWN_MS", DEFAULTS.cooldownMs, 0, 86_400_000),
    stopPollMs: numberSetting(env, "ATTENTION_ALERT_STOP_POLL_MS", DEFAULTS.stopPollMs, 500, 10_000),
    moveTimeoutMs: numberSetting(env, "ATTENTION_ALERT_MOVE_TIMEOUT_MS", DEFAULTS.moveTimeoutMs, 1_000, 30_000)
  };

  const missing = [];
  if (!config.token) missing.push("DISCORD_BOT_TOKEN");
  if (!snowflake(config.guildId)) missing.push("DISCORD_GUILD_ID");
  if (!snowflake(config.managerRoleId)) missing.push("DISCORD_WARNING_MANAGER_ROLE_ID");
  if (!snowflake(config.alertChannelId)) missing.push("DISCORD_ATTENTION_ALERT_CHANNEL_ID");
  if (!/^https:\/\//i.test(config.supabaseUrl)) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error(`Missing or invalid configuration: ${missing.join(", ")}.`);
  return Object.freeze(config);
}

export { DEFAULTS as ATTENTION_ALERT_DEFAULTS };
