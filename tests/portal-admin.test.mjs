import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("Website Admin is verified live against its configured Discord role", async () => {
  const helper = await read("../lib/portal-admin.js");
  assert.match(helper, /DISCORD_WEBSITE_ADMIN_ROLE_ID/);
  assert.match(helper, /discordApiRequest/);
  assert.match(helper, /\/guilds\//);
  assert.match(helper, /\/members\//);
  assert.match(helper, /ROLE_CACHE_TTL_MS = 5_000/);
  assert.match(helper, /requireActivePortalStaff/);
});

test("Website Admin can use owner-level portal management APIs", async () => {
  const members = await read("../api/admin/members.js");
  const settings = await read("../api/admin/settings.js");
  const media = await read("../api/admin/media.js");
  const warnings = await read("../api/warnings.js");
  const notifications = await read("../api/notifications/send.js");
  const session = await read("../api/auth/session.js");

  assert.match(members, /user\.isWebsiteAdmin\s*=\s*websiteAdmin/);
  assert.match(members, /user\.isOwner \|\| websiteAdmin/);
  assert.match(members, /if\(user\?\.isWebsiteAdmin\)return/);
  assert.match(members, /The protected owner cannot be modified/);
  assert.match(settings, /!user\.isOwner && !websiteAdmin/);
  assert.match(media, /!user\.isOwner && !websiteAdmin/);
  assert.match(warnings, /user\.isOwner \|\| await isWebsiteAdmin\(user\)/);
  assert.match(notifications, /Website Admin permission required to inspect notification diagnostics/);
  assert.match(session, /isWebsiteAdmin,\s*websiteAdminRoleId/);
});

test("Personnel directory refreshes live Discord roles and labels Website Admin separately from owner", async () => {
  const html = await read("../index.html");
  const members = await read("../api/admin/members.js");
  assert.match(html, /currentIsWebsiteAdmin=Boolean\(data\.user\.isWebsiteAdmin\)/);
  assert.match(html, /currentCanAdmin=currentIsOwner\|\|currentIsWebsiteAdmin/);
  assert.match(html, /websiteAdmin\?'ADMIN':'نشط'/);
  assert.match(html, /المالك ADMIN/);
  assert.match(html, /حساب المالك ADMIN محمي ولا يمكن حذفه أو حظره/);
  assert.doesNotMatch(html, /const adminBadge=websiteAdmin/);
  assert.match(members, /refreshPersonnelDiscordRoles/);
  assert.match(members, /assignmentGuildMembers\(token,guildId,profiles\)/);
  assert.match(members, /memberRolesLive: liveRoles\.synced/);
});
