import assert from "node:assert/strict";
import test from "node:test";
import { isTargetVoiceEntry, sendVoiceEntryDm } from "./voice-entry-alert.mjs";

const targetUserId = "1527006463200071700";
const ownerUserId = "1230975716884086886";

const baseEvent = {
  userId: targetUserId,
  targetUserId,
  guildId: "111111111111111111",
  expectedGuildId: "111111111111111111",
  oldChannelId: null,
  newChannelId: "222222222222222222"
};

test("detects the configured member joining a voice channel", () => {
  assert.equal(isTargetVoiceEntry(baseEvent), true);
});

test("detects the configured member switching voice channels", () => {
  assert.equal(isTargetVoiceEntry({
    ...baseEvent,
    oldChannelId: "333333333333333333"
  }), true);
});

test("ignores other members, other guilds, leaves, and non-movement updates", () => {
  assert.equal(isTargetVoiceEntry({ ...baseEvent, userId: "444444444444444444" }), false);
  assert.equal(isTargetVoiceEntry({ ...baseEvent, guildId: "555555555555555555" }), false);
  assert.equal(isTargetVoiceEntry({ ...baseEvent, newChannelId: null }), false);
  assert.equal(isTargetVoiceEntry({ ...baseEvent, oldChannelId: baseEvent.newChannelId }), false);
});

test("sends the voice-entry notice only to the configured owner DM", async () => {
  const sent = [];
  const client = {
    users: {
      async fetch(id) {
        assert.equal(id, ownerUserId);
        return {
          async send(payload) { sent.push(payload); }
        };
      }
    }
  };

  await sendVoiceEntryDm({
    client,
    recipientId: ownerUserId,
    channelName: "Operations Room",
    enteredAt: new Date("2026-11-20T16:00:00.000Z")
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Operations Room/);
  assert.match(sent[0].content, /بتوقيت الرياض/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});
