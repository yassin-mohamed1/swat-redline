import test from "node:test";
import assert from "node:assert/strict";
import { ATTENTION_ALERT_DEFAULTS, readConfig } from "./config.mjs";

const base = {
  DISCORD_BOT_TOKEN: "test-only-token",
  DISCORD_GUILD_ID: "12345678901234567",
  DISCORD_WARNING_MANAGER_ROLE_ID: "22345678901234567",
  LEAVE_REQUEST_CHANNEL_ID: "52345678901234567",
  RESIGNATION_REQUEST_CHANNEL_ID: "1575682539564171324",
  RESIGNATION_PUBLICATION_CHANNEL_ID: "1575685852082741248",
  DISCORD_ADMIN_ALERTS_CHANNEL_ID: "62345678901234567",
  DISCORD_LOG_CHANNEL_ID: "72345678901234567",
  SUPABASE_URL: "https://database.test/",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-service-key"
};

test("uses one clear set of safe Attention Alert defaults", () => {
  const config = readConfig(base);
  assert.equal(config.supabaseUrl, "https://database.test");
  assert.equal(config.leaveRequestChannelId, "52345678901234567");
  assert.equal(config.resignationRequestChannelId, "1575682539564171324");
  assert.equal(config.resignationPublicationChannelId, "1575685852082741248");
  assert.equal(config.adminAlertsChannelId, "62345678901234567");
  assert.equal(config.logChannelId, "72345678901234567");
  assert.equal(config.cycleMs, 5_000);
  assert.equal(config.dwellMs, 0);
  assert.equal(config.maxDurationMs, 0);
  assert.equal(config.cooldownMs, 60_000);
  assert.equal(config.stopPollMs, 1_000);
  assert.equal(ATTENTION_ALERT_DEFAULTS.moveTimeoutMs, 8_000);
});

test("accepts configured timing values and rejects unsafe invalid values", () => {
  const config = readConfig({ ...base, ATTENTION_ALERT_CYCLE_MS: "7000", ATTENTION_ALERT_DWELL_MS: "250", ATTENTION_ALERT_MAX_DURATION_MS: "90000", ATTENTION_ALERT_COOLDOWN_MS: "30000" });
  assert.equal(config.cycleMs, 7_000);
  assert.equal(config.dwellMs, 250);
  assert.equal(config.maxDurationMs, 90_000);
  assert.equal(config.cooldownMs, 30_000);
  assert.throws(() => readConfig({ ...base, ATTENTION_ALERT_CYCLE_MS: "10" }), /ATTENTION_ALERT_CYCLE_MS/);
  assert.throws(() => readConfig({ ...base, ATTENTION_ALERT_DWELL_MS: "-1" }), /ATTENTION_ALERT_DWELL_MS/);
  assert.throws(() => readConfig({ ...base, LEAVE_REQUEST_CHANNEL_ID: "not-a-channel" }), /LEAVE_REQUEST_CHANNEL_ID/);
  assert.throws(() => readConfig({ ...base, RESIGNATION_REQUEST_CHANNEL_ID: "not-a-channel" }), /RESIGNATION_REQUEST_CHANNEL_ID/);
  assert.throws(() => readConfig({ ...base, RESIGNATION_PUBLICATION_CHANNEL_ID: "not-a-channel" }), /RESIGNATION_PUBLICATION_CHANNEL_ID/);
  assert.throws(() => readConfig({ ...base, DISCORD_ADMIN_ALERTS_CHANNEL_ID: "not-a-channel" }), /DISCORD_ADMIN_ALERTS_CHANNEL_ID/);
  assert.throws(() => readConfig({ ...base, DISCORD_LOG_CHANNEL_ID: "not-a-channel" }), /DISCORD_LOG_CHANNEL_ID/);
  assert.doesNotThrow(() => readConfig({ ...base, DISCORD_ATTENTION_ALERT_CHANNEL_ID: "not-a-channel" }));
});
