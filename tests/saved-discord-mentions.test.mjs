import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMentionSelections, selectSavedMessageDmRecipients } from "../lib/saved-discord-messages.js";

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
    id: "1111111111111111" + String(index).padStart(2, "0")
  }));
  assert.throws(() => normalizeMentionSelections(roles), /100 رتبة و100 عضو/);
});

const eligibleDmRecipients = [
  { discord_user_id:"111111111111111111", display_name:"Alpha", notifications_enabled:true, is_active:true, is_banned:false },
  { discord_user_id:"222222222222222222", display_name:"Bravo", notifications_enabled:true, is_active:true, is_banned:false },
  { discord_user_id:"333333333333333333", display_name:"Opted Out", notifications_enabled:false, is_active:true, is_banned:false },
  { discord_user_id:"444444444444444444", display_name:"Inactive", notifications_enabled:true, is_active:false, is_banned:false },
  { discord_user_id:"555555555555555555", display_name:"Banned", notifications_enabled:true, is_active:true, is_banned:true }
];

test("saved-message direct delivery selects one eligible, opted-in active member only", () => {
  const result = selectSavedMessageDmRecipients(
    { recipient_mode:"single", recipient_id:"222222222222222222" },
    eligibleDmRecipients,
    { dmEnabled:true, broadcastEnabled:false }
  );
  assert.deepEqual(result.map(item => item.discord_user_id), ["222222222222222222"]);
});

test("saved-message direct delivery refuses a member who opted out, is inactive, or is banned", () => {
  for (const recipientId of ["333333333333333333","444444444444444444","555555555555555555"]) {
    assert.throws(() => selectSavedMessageDmRecipients(
      { recipient_mode:"single", recipient_id:recipientId },
      eligibleDmRecipients,
      { dmEnabled:true, broadcastEnabled:true }
    ), /غير مفعّل لاستقبال رسائل البوت/);
  }
});

test("saved-message bulk direct delivery requires both existing DM switches", () => {
  assert.throws(() => selectSavedMessageDmRecipients(
    { recipient_mode:"all" }, eligibleDmRecipients,
    { dmEnabled:false, broadcastEnabled:true }
  ), /إرسال الرسائل الخاصة متوقف/);
  assert.throws(() => selectSavedMessageDmRecipients(
    { recipient_mode:"all" }, eligibleDmRecipients,
    { dmEnabled:true, broadcastEnabled:false }
  ), /الإرسال الجماعي للرسائل الخاصة غير مفعّل/);
});

test("saved-message bulk direct delivery includes only eligible opted-in active members", () => {
  const result = selectSavedMessageDmRecipients(
    { recipient_mode:"all" }, eligibleDmRecipients,
    { dmEnabled:true, broadcastEnabled:true }
  );
  assert.deepEqual(result.map(item => item.discord_user_id), ["111111111111111111","222222222222222222"]);
});

test("saved-message bulk direct delivery rejects a batch above 200 without a partial send", () => {
  const many = Array.from({length:201},(_,index)=>({
    discord_user_id:String(100000000000000000+index),
    display_name:"Member "+index,
    notifications_enabled:true,
    is_active:true,
    is_banned:false
  }));
  assert.throws(() => selectSavedMessageDmRecipients(
    { recipient_mode:"all" }, many,
    { dmEnabled:true, broadcastEnabled:true }
  ), /الحد الآمن للإرسال من طلب واحد هو 200/);
});
