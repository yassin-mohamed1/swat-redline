import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMentionSelections,
  buildSavedMessageEditMultipart,
  selectSavedMessageDmRecipients,
  filterSavedMessageBulkRecipientsBySwatRole
} from "../lib/saved-discord-messages.js";

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


const testGuildId = "777777777777777777";
const testSwatRoleId = "888888888888888888";
const bulkProfile = (id, displayName = "Member") => ({
  discord_user_id:id, display_name:displayName,
  notifications_enabled:true, is_active:true, is_banned:false
});

test("bulk DM role verification fetches guild members once and filters opted-in recipients in memory", async () => {
  const ids = ["111111111111111111","222222222222222222","333333333333333333"];
  const paths = [];
  const result = await filterSavedMessageBulkRecipientsBySwatRole(
    { botToken:"test-token" },
    ids.map((id,index)=>bulkProfile(id,"Member "+index)),
    {
      guildId:testGuildId,
      roleId:testSwatRoleId,
      requestMembersPage:async path=>{
        paths.push(path);
        return [
          { user:{id:ids[0],bot:false}, roles:[testSwatRoleId] },
          { user:{id:ids[1],bot:false}, roles:["999999999999999999"] },
          { user:{id:ids[2],bot:true}, roles:[testSwatRoleId] }
        ];
      }
    }
  );
  assert.deepEqual(result.recipients.map(item=>item.discord_user_id),[ids[0]]);
  assert.equal(result.roleId,testSwatRoleId);
  assert.equal(result.checked,3);
  assert.equal(result.pages_scanned,1);
  assert.equal(paths.length,1);
  assert.equal(paths[0],"/guilds/"+testGuildId+"/members?limit=1000");
});

test("bulk DM role verification paginates only when an unverified recipient is above the current Discord cursor", async () => {
  const firstId="100000000000000005";
  const laterId="200000000000000000";
  const firstPage=Array.from({length:1000},(_,index)=>({
    user:{id:String(100000000000000000n+BigInt(index)),bot:false},
    roles:[]
  }));
  firstPage[5]={user:{id:firstId,bot:false},roles:[testSwatRoleId]};
  const paths=[];
  const result=await filterSavedMessageBulkRecipientsBySwatRole(
    {botToken:"test-token"},
    [bulkProfile(firstId,"First"),bulkProfile(laterId,"Later")],
    {
      guildId:testGuildId,roleId:testSwatRoleId,
      requestMembersPage:async path=>{
        paths.push(path);
        return paths.length===1
          ? firstPage
          : [{user:{id:laterId,bot:false},roles:[]}];
      }
    }
  );
  assert.deepEqual(result.recipients.map(item=>item.discord_user_id),[firstId]);
  assert.equal(result.checked,2);
  assert.equal(result.pages_scanned,2);
  assert.equal(paths.length,2);
  assert.ok(paths[1].includes("after=100000000000000999"));
});

test("bulk DM role verification fails closed when the member scan cannot reach every selected recipient", async () => {
  const laterId="200000000000000000";
  const firstPage=Array.from({length:1000},(_,index)=>({
    user:{id:String(100000000000000000n+BigInt(index)),bot:false},
    roles:[]
  }));
  await assert.rejects(
    filterSavedMessageBulkRecipientsBySwatRole(
      {botToken:"test-token"},
      [bulkProfile(laterId,"Unverified")],
      {
        guildId:testGuildId,roleId:testSwatRoleId,maxPages:1,
        requestMembersPage:async()=>firstPage
      }
    ),
    error=>error.code==="role_verification_incomplete"&&error.status===503
  );
});

test("bulk DM role verification reports Discord rate limits before starting any DM", async () => {
  await assert.rejects(
    filterSavedMessageBulkRecipientsBySwatRole(
      {botToken:"test-token"},
      [bulkProfile("111111111111111111")],
      {
        guildId:testGuildId,roleId:testSwatRoleId,
        requestMembersPage:async()=>{throw Object.assign(new Error("rate limited"),{status:429,code:429});}
      }
    ),
    error=>error.code==="429"&&error.status===503&&error.message.includes("429")
  );
});


test("editing a published message explicitly replaces only the template attachment set", async () => {
  const payload = {
    content:"<#333333333333333333>\\n\\nAnnouncement text",
    allowed_mentions:{parse:[]},
    components:[]
  };
  const emptyEdit = buildSavedMessageEditMultipart(payload, null, []);
  assert.deepEqual(emptyEdit.attachments, []);
  const multipart = buildSavedMessageEditMultipart(
    payload,
    {filename:"announcement.txt",fileContent:"updated full text"},
    [{filename:"image.png",content_type:"image/png",bytes:new Uint8Array([1,2,3])}]
  );
  assert.ok(multipart instanceof FormData);
  const body = JSON.parse(await multipart.get("payload_json").text());
  assert.deepEqual(body.attachments,[
    {id:0,filename:"announcement.txt"},
    {id:1,filename:"image.png"}
  ]);
  assert.equal(await multipart.get("files[0]").text(),"updated full text");
  assert.deepEqual(Array.from(new Uint8Array(await multipart.get("files[1]").arrayBuffer())),[1,2,3]);
});
