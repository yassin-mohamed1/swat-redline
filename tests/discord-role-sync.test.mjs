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

test("Discord role sync can only be triggered by the authenticated owner with a same-origin POST", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const workflowUrl = new URL("../.github/workflows/discord-role-sync.yml", import.meta.url);

  assert.match(api, /requestBody\.action === "sync_discord_role_members"/);
  assert.match(api, /if \(!user\.isOwner\) return send\(res,403/);
  assert.match(api, /requireSameOrigin\(req,res\)/);
  assert.match(api, /handleDiscordRoleSync\(req,res\)/);
  assert.match(helper, /if \(req\.method !== "POST"\)/);
  assert.doesNotMatch(helper, /verifyGitHubActionsRequest|token\.actions\.githubusercontent\.com/);
  assert.match(helper, /trigger: "manual_owner_button"/);
  assert.match(html, /id="syncDiscordRoleMembersButton"/);
  assert.match(html, /if\(!currentIsOwner\)/);
  assert.match(html, /syncButton\.hidden=!currentIsOwner/);
  await assert.rejects(readFile(workflowUrl, "utf8"), { code: "ENOENT" });
});

test("role sync inserts only new members with the access role and preserves existing records", async () => {
  const helper = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const membersApi = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(helper, /member\.roles\.map\(String\)\.includes\(roleId\)/);
  assert.match(helper, /on_conflict: "discord_user_id"/);
  assert.match(helper, /resolution=ignore-duplicates,return=representation/);
  assert.match(helper, /is_manual: false/);
  assert.match(helper, /registration_source: "bot_role"/);
  assert.match(helper, /manual_created_by_discord_id: null/);
  assert.match(helper, /login_count: 0/);
  assert.match(helper, /last_login: null/);
  assert.match(helper, /cursor_id: cursor/);
  assert.match(helper, /MAX_PAGES_PER_RUN/);
  assert.doesNotMatch(helper, /setInterval|schedule/);
  assert.match(membersApi, /registration_source:"manual_id"/);
  assert.match(membersApi, /registration_source,last_login,login_count/);
  assert.match(html, /registration_source==='bot_role'/);
  assert.match(html, /إضافة تلقائية بواسطة بوت S\.W\.A\.T\./);
  assert.match(html, /pendingRegistrationBadge\(member\)/);
});

test("registration source migration marks the previous bot-added members and keeps portal-login status separate", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261109155000_staff_profile_registration_source.sql", import.meta.url), "utf8");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS registration_source text/);
  assert.match(migration, /WHEN is_manual IS TRUE THEN 'manual_id'/);
  assert.match(migration, /THEN 'bot_role'/);
  assert.match(migration, /'1561561038263029900'/);
  assert.match(migration, /registration_source IN \('manual_id', 'bot_role', 'oauth'\)/);
});

test("new Discord role sync state is private and writable only by the service role", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261109153000_discord_role_sync_state.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.discord_role_sync_state/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL PRIVILEGES .* FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE .* TO service_role/);
});
