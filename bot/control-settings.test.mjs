import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOGGING_EVENTS, LOG_CATEGORIES, normalizeBotControlSettings } from "./control-settings.mjs";

test("defaults logging to enabled and uses the configured fallback channel", () => {
  const settings = normalizeBotControlSettings({}, "72345678901234567");
  assert.equal(settings.logging.enabled, true);
  assert.equal(settings.logging.defaultChannelId, "72345678901234567");
  assert.equal(settings.logging.categories.messages.enabled, true);
  assert.equal(settings.logging.events.messageDelete, true);
  assert.equal(settings.welcome.enabled, false);
  assert.equal(settings.welcome.goodbyeEnabled, false);
});

test("preserves explicit global, category and individual event switches", () => {
  const settings = normalizeBotControlSettings({
    botControl: {
      logging: {
        enabled: false,
        categories: { messages: { enabled: false, channelId: "82345678901234567" } },
        events: { messageDelete: false, voiceJoin: true }
      },
      welcome: { enabled: true, channelId: "92345678901234567", message: "Welcome {{user}}" }
    }
  }, "72345678901234567");
  assert.equal(settings.logging.enabled, false);
  assert.equal(settings.logging.categories.messages.enabled, false);
  assert.equal(settings.logging.categories.messages.channelId, "82345678901234567");
  assert.equal(settings.logging.categories.voice.enabled, true);
  assert.equal(settings.logging.events.messageDelete, false);
  assert.equal(settings.logging.events.voiceJoin, true);
  assert.equal(settings.logging.events.messageUpdate, true);
  assert.equal(settings.welcome.enabled, true);
  assert.equal(settings.welcome.channelId, "92345678901234567");
});

test("ignores malformed channel ids and rejects non-HTTPS welcome images", () => {
  const settings = normalizeBotControlSettings({
    logging: { defaultChannelId: "not-a-channel", categories: { voice: { channelId: "123" } } },
    welcome: { imageUrl: "javascript:alert(1)" }
  }, "72345678901234567");
  assert.equal(settings.logging.defaultChannelId, "72345678901234567");
  assert.equal(settings.logging.categories.voice.channelId, "");
  assert.equal(settings.welcome.imageUrl, "");
});

test("exposes the complete supported event catalog", () => {
  const categories = Object.values(LOG_CATEGORIES).flat();
  assert.equal(new Set(categories).size, categories.length);
  assert.ok(categories.includes("messageDelete"));
  assert.ok(categories.includes("voiceMove"));
  assert.ok(categories.includes("memberRoleUpdate"));
  assert.ok(categories.includes("channelDelete"));
  assert.equal(Object.keys(DEFAULT_LOGGING_EVENTS).length, categories.length);
});
