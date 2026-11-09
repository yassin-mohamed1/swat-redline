import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Discord OAuth blocks accounts without the configured access role", async () => {
  const auth = await readFile(new URL("../api/auth/discord.js", import.meta.url), "utf8");
  const session = await readFile(new URL("../api/auth/session.js", import.meta.url), "utf8");

  assert.match(auth, /DISCORD_ROLE_ID: roleId/);
  assert.match(auth, /member\.roles\.includes\(roleId\)/);
  assert.match(auth, /if \(!isOwner && \(!Array\.isArray\(member\.roles\) \|\| !member\.roles\.includes\(roleId\)\)\) return res\.status\(403\)/);
  assert.match(session, /user\.roleId !== process\.env\.DISCORD_ROLE_ID/);
});

test("only the authenticated owner can open the candidate picker or add selected members", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /"list_discord_role_candidates"/);
  assert.match(api, /"register_selected_discord_members"/);
  assert.match(api, /if \(!user\.isOwner\) return send\(res,403/);
  assert.match(api, /requireSameOrigin\(req,res\)/);
  assert.match(api, /handleDiscordRoleSync\(req,res\)/);
  assert.match(helper, /if \(req\.method !== "POST"\)/);
  assert.match(helper, /list_discord_role_candidates/);
  assert.match(helper, /register_selected_discord_members/);
  assert.match(html, /id="discordRoleCandidatesModal"/);
  assert.match(html, /openDiscordRoleCandidates\(\)/);
  assert.match(html, /discordRoleCandidateSelection/);
  assert.match(html, /registerSelectedDiscordRoleCandidates\(\)/);
  assert.match(html, /syncButton\.hidden=!currentIsOwner/);
});

test("candidate preview only lists role-holders missing from the portal and excludes bot accounts", async () => {
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");

  assert.match(helper, /member\.roles\.map\(String\)\.includes\(roleId\)/);
  assert.match(helper, /member\?\.user\?\.bot !== true/);
  assert.match(helper, /user\.bot === true/);
  assert.match(helper, /existingProfileIds\(base, key, matchedIds\)/);
  assert.match(helper, /existing\.has\(candidate\.discord_user_id\)/);
  assert.match(helper, /candidates,/);
  assert.match(helper, /cycle_complete: cycleComplete/);
  assert.doesNotMatch(helper, /saveNewProfiles\(base, key, matches/);
});

test("selected members are revalidated against current Discord role membership before being registered", async () => {
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");

  assert.match(helper, /discordApiRequest\(token, "\/users\/@me"/);
  assert.match(helper, /id === botId/);
  assert.match(helper, /requestGuildMember\(token, guildId, id\)/);
  assert.match(helper, /member\.roles\.map\(String\)\.includes\(roleId\)/);
  assert.match(helper, /const existing = await existingProfileIds/);
  assert.match(helper, /saveNewProfiles\(base, key, toInsert/);
  assert.match(helper, /on_conflict: "discord_user_id"/);
  assert.match(helper, /resolution=ignore-duplicates,return=representation/);
  assert.match(api, /requestBody\.action/);
});

test("new role registrations are marked as bot-added and shown until the first portal login", async () => {
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(helper, /registration_source: "bot_role"/);
  assert.match(helper, /is_manual: false/);
  assert.match(helper, /login_count: 0/);
  assert.match(helper, /last_login: null/);
  assert.match(api, /registration_source,last_login,login_count/);
  assert.match(html, /registration_source==='bot_role'/);
  assert.match(html, /إضافة تلقائية بواسطة بوت S\.W\.A\.T\./);
  assert.match(html, /pendingRegistrationBadge\(member\)/);
});

test("manual registration source is distinct from bot role registration", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261109155000_staff_profile_registration_source.sql", import.meta.url), "utf8");

  assert.match(api, /registration_source:"manual_id"/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS registration_source text/);
  assert.match(migration, /WHEN is_manual IS TRUE THEN 'manual_id'/);
  assert.match(migration, /THEN 'bot_role'/);
  assert.match(migration, /'1561561038263029900'/);
  assert.match(migration, /registration_source IN \('manual_id', 'bot_role', 'oauth'\)/);
});

test("Discord role scan remains manual-only and its cursor is private", async () => {
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261109153000_discord_role_sync_state.sql", import.meta.url), "utf8");
  const workflowPaths = ["../.github/workflows/discord-role-sync.yml"];
  for (const workflowPath of workflowPaths) {
    await assert.rejects(readFile(new URL(workflowPath, import.meta.url), "utf8"), { code: "ENOENT" });
  }
  assert.match(helper, /trigger: "manual_owner_button"/);
  assert.doesNotMatch(helper, /setInterval|schedule/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.discord_role_sync_state/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL PRIVILEGES .* FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE .* TO service_role/);
});
