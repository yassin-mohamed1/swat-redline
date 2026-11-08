import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("assignment API is owner-only and reads registered profiles plus live Discord ranks", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  assert.match(api, /if \(!user\.isOwner\) return send\(res, 403/);
  assert.match(api, /staff_profiles\?select=discord_user_id/);
  assert.match(api, /staff_assignments\?select=discord_user_id/);
  assert.match(api, /\/guilds\/.*\/roles/);
  assert.ok(api.includes('"/guilds/"+guildId+"/members?"+query.toString()'), "assignment list should use the bulk guild-member endpoint");
  assert.match(api, /current_rank_roles/);
  assert.match(api, /discord_roles/);
  assert.match(api, /member_sync_warning/);
  assert.match(api, /in_guild/);
  assert.match(api, /requireSameOrigin/);
});

test("assignment role picker exposes every Discord role and respects bot hierarchy", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  for (const role of [
    "swatcommander", "deputyswatcommander", "swatteamleader",
    "swatsupervisor", "swatsenioroperator", "swatoperator", "swatrecruit"
  ]) assert.ok(api.includes(role), "missing screenshot rank " + role);
  assert.match(api, /roles\.map\(role =>/);
  assert.match(api, /unavailableReason/);
  assert.match(api, /position >= Number\(botPosition\)/);
  assert.match(api, /!targetRole\.assignable/);
  assert.match(api, /replaceableRoleIds/);
  assert.match(api, /previousAssignment\?\.rank_role_id/);
  assert.doesNotMatch(api, /rankIds=rankRoles\.map/);
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /assignmentRoleUnavailableReason/);
  assert.doesNotMatch(api, /guilds\/.*\/roles["']?,\s*\{\s*method:\s*["']POST/);
});

test("appointment synchronizes one S.W.A.T rank, sends a portal DM, and rolls back on failures", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  assert.ok(api.includes("body:JSON.stringify({roles:desiredRoles})"));
  assert.match(api, /assignmentSendDm\(token,targetId,embed\)/);
  assert.ok(api.includes("components:assignmentPortalComponents()"));
  assert.match(api, /roles:originalRoles/);
  assert.match(api, /assignmentDeleteDm\(token,dm\)/);
  assert.match(api, /rpc\/save_staff_assignment/);
  assert.match(api, /Manage Roles/);
  assert.match(api, /botTop\.position/);
});

test("assignment list keeps working when Discord member list is rate limited or unavailable", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /member_sync_warning/);
  assert.match(api, /profile\.discord_roles/);
  assert.match(api, /assignmentGuildMembers/);
  assert.match(html, /assignmentSyncNotice/);
  assert.match(html, /member\.in_guild===false/);
  assert.match(html, /سيتم التحقق من العضوية عند الحفظ/);
});

test("Alpha callsigns support presets and open-ended numeric additions", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108131000_unbounded_alpha_callsign_sequence.sql", import.meta.url), "utf8");
  const initialMigration = await readFile(new URL("../supabase/migrations/20261108130000_staff_rank_and_callsign_assignments.sql", import.meta.url), "utf8");
  assert.ok(api.includes("function assignmentCallsign(value)"));
  assert.ok(api.includes('[1-9][0-9]*'));
  assert.ok(html.includes('Array.from({length:16}'));
  assert.match(html, /Add a new Alpha \(16 or higher\)|إضافة Alpha جديد/);
  assert.match(html, /selectedAssignmentCallsign\(\)/);
  assert.ok(html.includes("match(/^Alpha (\\d+)$/i)"), "saved Alpha callsigns should parse as digits when reopening an appointment");
  assert.match(migration, /callsign ~ '\^Alpha \(0\|\[1-9\]\[0-9\]\*\)\$'/);
  assert.match(initialMigration, /staff_assignments_callsign_unique_idx/);
});

test("assignments page exposes manager controls, registered member table, rank modal and audit-backed history", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108130000_staff_rank_and_callsign_assignments.sql", import.meta.url), "utf8");
  assert.match(html, /data-page="assignments"/);
  assert.match(html, /id="page-assignments"/);
  assert.match(html, /id="assignmentRows"/);
  assert.match(html, /id="assignmentRankSelect"/);
  assert.match(html, /id="assignmentCallsignSelect"/);
  assert.match(html, /submitStaffAssignment\('assign'\)/);
  assert.match(html, /submitStaffAssignment\('remove'\)/);
  assert.match(html, /if\(page==='assignments'&&!currentIsOwner\)/);
  assert.ok(html.includes("/api/admin/members?assignments=1"));
  assert.ok(html.includes("api/admin/members"));
  assert.match(migration, /ALTER TABLE public\.staff_assignments ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.staff_assignments FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.save_staff_assignment/);
  assert.match(migration, /INSERT INTO public\.audit_logs/);
  assert.match(migration, /'before',v_before/);
  assert.match(migration, /'after',v_after/);
});

test("owner can add a Discord guild member manually without portal OAuth", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108153000_staff_manual_members.sql", import.meta.url), "utf8");
  assert.match(api, /handleAddManualMember/);
  assert.match(api, /action==="add_manual_member"/);
  assert.match(api, /\/guilds\/\+guildId\+\/members\/\+targetId/);
  assert.match(api, /is_manual:true/);
  assert.match(api, /manual_created_by_discord_id:user\.id/);
  assert.match(html, /إضافة عضو بدون تسجيل/);
  assert.match(html, /manualDiscordUserId/);
  assert.match(html, /submitManualMember/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS is_manual boolean/);
});
