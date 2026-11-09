import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Discord OAuth requires the configured S.W.A.T. website access role", async () => {
  const auth = await readFile(new URL("../api/auth/discord.js", import.meta.url), "utf8");
  const session = await readFile(new URL("../api/auth/session.js", import.meta.url), "utf8");

  assert.match(auth, /DISCORD_ROLE_ID: roleId/);
  assert.match(auth, /member\.roles\.includes\(roleId\)/);
  assert.match(auth, /if \(!isOwner && \(!Array\.isArray\(member\.roles\) \|\| !member\.roles\.includes\(roleId\)\)\) return res\.status\(403\)/);
  assert.match(session, /user\.roleId !== process\.env\.DISCORD_ROLE_ID/);
});

test("scheduled Discord role sync verifies GitHub OIDC and the exact repository workflow", async () => {
  const api = await readFile(new URL("../api/cron/sync-discord-role-members.js", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/discord-role-sync.yml", import.meta.url), "utf8");

  assert.match(api, /token\.actions\.githubusercontent\.com/);
  assert.match(api, /crypto\.verify\("RSA-SHA256"/);
  assert.match(api, /EXPECTED_AUDIENCE = "swat-redline-discord-role-sync"/);
  assert.match(api, /claims\.repository !== EXPECTED_REPOSITORY/);
  assert.match(api, /claims\.workflow_ref !== EXPECTED_WORKFLOW/);
  assert.match(api, /claims\.ref !== EXPECTED_REF/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /api\/cron\/sync-discord-role-members/);
});

test("role sync inserts only new Discord profiles and ignores conflicts without rewriting existing records", async () => {
  const api = await readFile(new URL("../api/cron/sync-discord-role-members.js", import.meta.url), "utf8");

  assert.match(api, /GET.*members|\/members\?/s);
  assert.match(api, /member\.roles\.map\(String\)\.includes\(roleId\)/);
  assert.match(api, /on_conflict: "discord_user_id"/);
  assert.match(api, /resolution=ignore-duplicates,return=representation/);
  assert.match(api, /is_manual: false/);
  assert.match(api, /manual_created_by_discord_id: null/);
  assert.match(api, /login_count: 0/);
  assert.match(api, /last_login: null/);
  assert.match(api, /notifications_enabled: true/);
  assert.match(api, /cursor_id: cursor/);
  assert.match(api, /MAX_PAGES_PER_RUN/);
  assert.match(api, /Server Members Intent \(GUILD_MEMBERS\)/);
  assert.doesNotMatch(api, /staff_profiles\?[^\n]*PATCH/);
});

test("new Discord role sync state is private and writable only by the service role", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261109153000_discord_role_sync_state.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.discord_role_sync_state/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL PRIVILEGES .* FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE .* TO service_role/);
});
