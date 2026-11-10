import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildSiteNoticeDiscordPayload,
  isSiteNoticeId,
  normalizeSiteNoticeInput,
  siteNoticeBatchIsSent
} from "../lib/site-notices.js";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const validId = "6b0c1e75-02e4-4cf8-9b2c-832145b90236";

test("official notice IDs are UUIDs and invalid identifiers are rejected", () => {
  assert.equal(isSiteNoticeId(validId), true);
  assert.equal(isSiteNoticeId("ANN-100"), false);
  assert.equal(isSiteNoticeId(""), false);
  assert.equal(isSiteNoticeId(123), false);
});

test("official notice content requires a title and description and trims input", () => {
  assert.deepEqual(normalizeSiteNoticeInput({
    title: "  تحديث إداري  ",
    description: "  يرجى مراجعة التعليمات الجديدة.  "
  }), {
    title: "تحديث إداري",
    description: "يرجى مراجعة التعليمات الجديدة."
  });
  assert.throws(() => normalizeSiteNoticeInput({ title: "", description: "وصف" }), { status: 400 });
  assert.throws(() => normalizeSiteNoticeInput({ title: "عنوان", description: " " }), { status: 400 });
  assert.throws(() => normalizeSiteNoticeInput({ title: "x".repeat(257), description: "وصف" }), { status: 400 });
  assert.throws(() => normalizeSiteNoticeInput({ title: "عنوان", description: "x".repeat(4001) }), { status: 400 });
});

test("official notice Discord payload contains the saved title and description only", () => {
  const payload = buildSiteNoticeDiscordPayload({
    title: "تعميم إداري",
    description: "يرجى الالتزام بالتعليمات.",
    notificationRoleId: "1561561038263029900",
    roleMentionDisabled: true
  });
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, "تعميم إداري");
  assert.equal(payload.embeds[0].description, "يرجى الالتزام بالتعليمات.");
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal("content" in payload, false);
  assert.equal("fields" in payload.embeds[0], false);
});

test("official notice may mention only the configured SWAT role when mention setting allows it", () => {
  const payload = buildSiteNoticeDiscordPayload({
    title: "تعميم",
    description: "الوصف",
    notificationRoleId: "1561561038263029900",
    roleMentionDisabled: false
  });
  assert.equal(payload.content, "<@&1561561038263029900>");
  assert.deepEqual(payload.allowed_mentions, { parse: [], roles: ["1561561038263029900"] });
  assert.equal(payload.content.includes("@everyone"), false);

  const invalidRole = buildSiteNoticeDiscordPayload({
    title: "تعميم",
    description: "الوصف",
    notificationRoleId: "not-a-role",
    roleMentionDisabled: false
  });
  assert.equal("content" in invalidRole, false);
  assert.deepEqual(invalidRole.allowed_mentions, { parse: [] });
});

test("a notice is considered published only after Discord message ID is recorded", () => {
  assert.equal(siteNoticeBatchIsSent({ channel_status: "sent", channel_message_id: "123456789012345678" }), true);
  assert.equal(siteNoticeBatchIsSent({ channel_status: "sent", channel_message_id: null }), false);
  assert.equal(siteNoticeBatchIsSent({ channel_status: "pending", channel_message_id: null }), false);
});

test("publishing official notices uses only the configured notification channel and never the warning or DM pipeline", async () => {
  const api = await read("../api/notifications/send.js");
  const start = api.indexOf("async function publishSavedSiteNotice(");
  const end = api.indexOf("\nexport default async function handler", start);
  assert.ok(start >= 0 && end > start, "official notice publisher exists");
  const publisher = api.slice(start, end);
  assert.match(publisher, /config\.notificationChannelId/);
  assert.match(publisher, /notificationChannelEnabled/);
  assert.match(publisher, /discord_notification_batches/);
  assert.match(publisher, /channel_status: "sent"/);
  assert.match(publisher, /channel_status: "failed"/);
  assert.doesNotMatch(publisher, /DISCORD_WARNINGS_CHANNEL_ID/);
  assert.doesNotMatch(publisher, /deliverToRecipient|discord_user_id.*recipient|\/users\/@me\/channels/);

  const handler = api.slice(end);
  assert.match(handler, /body\.action === "publish_site_notice"/);
  assert.match(handler, /if \(!websiteAdminAccess\)/);
  assert.match(api, /req\.method === "GET" && statusUrl\.searchParams\.get\("site_notice_status"\) === "1"/);
  assert.match(api, /const noticeIds = new Set/);
  assert.match(api, /const allowedIds = ids\.filter\(id => noticeIds\.has\(id\)\)/);
});

test("regular staff can read notice publication status but cannot publish notices", async () => {
  const api = await read("../api/notifications/send.js");
  const statusAt = api.indexOf('statusUrl.searchParams.get("site_notice_status") === "1"');
  const adminGateAt = api.indexOf("if (!websiteAdminAccess)");
  const publishAt = api.indexOf('body.action === "publish_site_notice"');
  assert.ok(statusAt >= 0 && statusAt < adminGateAt);
  assert.ok(publishAt > adminGateAt);
  assert.match(api.slice(statusAt - 120, adminGateAt), /getSiteNoticePublicationStatuses\(user, statusUrl, res\)/);
});

test("only active owner or Website Admin can change the official notices collection", async () => {
  const state = await read("../api/state.js");
  assert.match(state, /siteNotices: "التنبيهات والتعاميم الرسمية"/);
  assert.match(state, /"announcements", "siteNotices", "rules"/);
  assert.match(state, /isWebsiteAdmin\(user\)/);
  assert.match(state, /requireActivePortalStaff\(user\)/);
  assert.match(state, /Only the portal owner or Website Admin may manage official notices/);
  assert.match(state, /An official notice contains an invalid ID/);
  assert.match(state, /const normalizeNotice = notice =>/);
  assert.match(state, /const changedNotices = JSON\.stringify\(previousNotices\) !== JSON\.stringify\(incomingNotices\)/);
  assert.match(state, /safeData\.siteNotices = incomingNotices/);
  assert.doesNotMatch(state, /safeData\.siteNotices = data\.siteNotices/);
});

test("portal notice editor has exactly title and description fields and a separate publish action", async () => {
  const html = await read("../index.html");
  assert.match(html, /id="siteNoticesPanel"/);
  assert.match(html, /onclick="openSiteNoticeModal\(\)">＋ إضافة تعميم/);
  assert.match(html, /id="siteNoticeTitle" maxlength="256" required/);
  assert.match(html, /id="siteNoticeDescription" rows="7" maxlength="4000" required/);
  assert.match(html, /async function saveSiteNotice\(event\)/);
  assert.match(html, /async function publishSiteNotice\(id,button\)/);
  assert.match(html, /body:JSON\.stringify\(\{action:'publish_site_notice',noticeId:String\(id\)\}\)/);
  assert.match(html, /لن تُرسل رسائل خاصة للأعضاء/);
  assert.match(html, /التحذيرات تستمر في روم التحذيرات المنفصلة/);
  assert.match(html, /data:\{people,cases,investigations,tasks,operations,reports,announcements,siteNotices,/);
});

test("official notices appear in Warnings only and follow Warnings page access", async () => {
  const html = await read("../index.html");
  const warningsStart = html.indexOf('<section class="page" id="page-warnings">');
  const announcementsStart = html.indexOf('<section class="page" id="page-announcements">');
  const personnelStart = html.indexOf('<section class="page" id="page-personnel">');
  const noticesStart = html.indexOf('id="siteNoticesPanel"');
  const warningsNext = html.indexOf('<section class="page"', warningsStart + 20);
  assert.ok(warningsStart >= 0 && noticesStart > warningsStart && noticesStart < warningsNext);
  assert.doesNotMatch(html.slice(announcementsStart, personnelStart), /siteNoticesPanel/);
  assert.match(html, /if\(page==='warnings'&&currentCanManageWarnings\)\{renderWarnings\(\);renderSiteNotices\(\);\}/);
  assert.match(html, /function openSiteNoticeModal\(\)\{\s*if\(!currentCanManageWarnings\)/);
  assert.match(html, /function publishSiteNotice\(id,button\)\{\s*if\(!currentCanManageWarnings\)/);
});


test("shared state initializes safeData before validating and normalizing official notices", async () => {
  const state = await read("../api/state.js");
  const writeHandler = state.indexOf('if (req.method === "PUT")');
  const safeDataDeclaration = state.indexOf("const safeData = {}", writeHandler);
  const noticeGuard = state.indexOf('if (Object.prototype.hasOwnProperty.call(data, "siteNotices"))', writeHandler);
  const normalizedAssignment = state.indexOf("safeData.siteNotices = incomingNotices", writeHandler);
  const databaseWrite = state.indexOf('body: JSON.stringify({', writeHandler);
  assert.ok(safeDataDeclaration >= 0 && noticeGuard > safeDataDeclaration);
  assert.ok(normalizedAssignment > noticeGuard);
  assert.ok(databaseWrite > normalizedAssignment);
});
