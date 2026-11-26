import test from "node:test";
import assert from "node:assert/strict";
import { createWelcomeAutomation } from "./welcome-automation.mjs";

function harness(settings) {
  const sent = [];
  const channel = {
    id: "72345678901234567",
    guildId: "12345678901234567",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => { sent.push(payload); }
  };
  const client = { user: { id: "82345678901234567" }, channels: { fetch: async () => channel } };
  const automation = createWelcomeAutomation({
    client,
    guildId: "12345678901234567",
    getSettings: () => settings
  });
  return { automation, sent };
}

test("welcome automation is disabled by default", async () => {
  const { automation, sent } = harness({ enabled: false, message: "Welcome {{user}}" });
  assert.equal(await automation.memberJoined({
    guild: { id: "12345678901234567" },
    user: { id: "92345678901234567", username: "NewMember" }
  }), false);
  assert.equal(sent.length, 0);
});

test("sends a configured welcome message with the supported template tokens", async () => {
  const { automation, sent } = harness({
    enabled: true,
    channelId: "72345678901234567",
    message: "Welcome {{username}} to {{server}} — {{memberCount}} members",
    imageUrl: "https://cdn.example.com/welcome.png"
  });
  assert.equal(await automation.memberJoined({
    guild: { id: "12345678901234567", name: "REDLINE", memberCount: 42 },
    user: { id: "92345678901234567", username: "NewMember" },
    displayName: "New Member"
  }), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /NewMember/);
  assert.match(sent[0].content, /REDLINE/);
  assert.match(sent[0].content, /42/);
  assert.equal(sent[0].embeds[0].image.url, "https://cdn.example.com/welcome.png");
  assert.deepEqual(sent[0].allowedMentions.users, ["92345678901234567"]);
});

test("does not mention users in goodbye messages", async () => {
  const { automation, sent } = harness({
    goodbyeEnabled: true,
    goodbyeChannelId: "72345678901234567",
    goodbyeMessage: "Goodbye {{user}}"
  });
  assert.equal(await automation.memberLeft({
    guild: { id: "12345678901234567" },
    user: { id: "92345678901234567", username: "Member" },
    displayName: "Member"
  }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].allowedMentions.users.length, 0);
  assert.equal(sent[0].allowedMentions.parse.length, 0);
});

test("does not send into a channel from another server", async () => {
  const { automation, sent } = harness({ enabled: true, channelId: "72345678901234567", message: "Welcome" });
  assert.equal(await automation.memberJoined({
    guild: { id: "99999999999999999" },
    user: { id: "92345678901234567", username: "Member" }
  }), false);
  assert.equal(sent.length, 0);
});
