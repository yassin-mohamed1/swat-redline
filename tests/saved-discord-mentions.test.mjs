import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMentionSelections } from "../lib/saved-discord-messages.js";

test("explicit role, user and channel mentions are allow-listed only", () => {
  const result = normalizeMentionSelections([
    { kind: "role", id: "111111111111111111" },
    { kind: "user", id: "222222222222222222" },
    { kind: "channel", id: "333333333333333333" }
  ]);
  assert.equal(result.content, "<@&111111111111111111> <@222222222222222222> <#333333333333333333>");
  assert.deepEqual(result.allowed_mentions.parse, []);
  assert.deepEqual(result.allowed_mentions.roles, ["111111111111111111"]);
  assert.deepEqual(result.allowed_mentions.users, ["222222222222222222"]);
  assert.equal(result.channel_reference_count, 1);
});

test("@everyone and @here use the dedicated everyone permission only when selected", () => {
  const result = normalizeMentionSelections([
    { kind: "everyone", id: "everyone" },
    { kind: "role", id: "111111111111111111" }
  ]);
  assert.equal(result.content, "@everyone <@&111111111111111111>");
  assert.deepEqual(result.allowed_mentions.parse, ["everyone"]);
  assert.deepEqual(result.allowed_mentions.roles, ["111111111111111111"]);
  assert.equal(result.includes_everyone, true);
});

test("duplicate mentions are removed and broad everyone/here options cannot stack", () => {
  const result = normalizeMentionSelections([
    { kind: "here", id: "here" },
    { kind: "everyone", id: "everyone" },
    { kind: "here", id: "here" }
  ]);
  assert.equal(result.content, "@here");
  assert.equal(result.includes_here, true);
  assert.equal(result.includes_everyone, false);
});

test("unselected mentions are not parsed and invalid IDs are rejected", () => {
  const empty = normalizeMentionSelections([]);
  assert.deepEqual(empty.allowed_mentions.parse, []);
  assert.deepEqual(empty.allowed_mentions.roles, []);
  assert.deepEqual(empty.allowed_mentions.users, []);
  assert.throws(() => normalizeMentionSelections([{ kind: "role", id: "bad" }]), /معرّف منشن غير صالح/);
});

test("Discord role and member mention lists are limited to 100 each", () => {
  const roles = Array.from({ length: 101 }, (_, index) => ({
    kind: "role",
    id: String(100000000000000000 + index)
  }));
  assert.throws(() => normalizeMentionSelections(roles), /100 رتبة و100 عضو/);
});
