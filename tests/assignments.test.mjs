import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("assignment and personnel APIs use the same warning manager role and enforce it server-side", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const warnings = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(api, /staff_profiles\?discord_user_id=/);
  assert.match(api, /member\.roles\.includes\(managerRoleId\)/);
  assert.match(api, /requireAssignmentManager\(url,key,process\.env\.DISCORD_BOT_TOKEN/);
  assert.match(api, /req\.method==="PATCH"&&!user\.isOwner/);
  assert.match(api, /searchParams\.get\("activity"\)==="1"&&!user\.isOwner/);
  assert.match(warnings, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(warnings, /member\.roles\.includes\(cfg\.managerRoleId\)/);
  assert.match(html, /currentCanManageAssignments=currentCanManageWarnings/);
  assert.match(html, /currentIsOwner\|\|currentCanManageAssignments/);
});

test("assignment API exposes every Discord role and explains hierarchy and permission limits", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const role of [
    "swatcommander", "deputyswatcommander", "swatteamleader",
    "swatsupervisor", "swatsenioroperator", "swatoperator", "swatrecruit"
  ]) assert.ok(api.includes(role), "missing screenshot rank " + role);
  assert.match(api, /return roles\.map\(role =>/);
  assert.match(api, /unavailableReason/);
  assert.match(api, /position >= Number\(botPosition\)/);
  assert.match(api, /!targetRoles\.some|targetRoles\.some/);
  assert.match(api, /Manage Roles/);
  assert.match(html, /assignmentRoleUnavailableReason/);
  assert.match(html, /assignmentBotRoleInfo/);
  assert.match(html, /assignmentRankOptions/);
});

test("one appointment can apply multiple Discord roles and persists both role ID and name arrays", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108203000_multi_rank_assignments_and_callsign_catalog.sql", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /Array\.isArray\(body\.rank_role_ids\)/);
  assert.match(api, /requestedRoleIds\.length>20/);
  assert.match(api, /p_rank_role_ids:/);
  assert.match(api, /p_rank_role_names:/);
  assert.match(api, /rpc\/save_staff_assignment_v2/);
  assert.match(api, /const desiredRoles=\[\.\.\.next\]/);
  assert.match(api, /roles:desiredRoles/);
  assert.match(api, /roles:originalRoles/);
  assert.match(api, /assignmentSendDm\(token,targetId,embed\)/);
  assert.match(migration, /rank_role_ids text\[\]/);
  assert.match(migration, /rank_role_names text\[\]/);
  assert.match(migration, /save_staff_assignment_v2/);
  assert.match(migration, /'rank_role_ids', v_row\.rank_role_ids/);
  assert.match(html, /assignment-rank-checkbox/);
  assert.match(html, /selectedAssignmentRoleIds\(\)/);
  assert.match(html, /rank_role_ids:rankRoleIds/);
});

test("callsign creation is a separate persistent action, not an inline custom select option", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108203000_multi_rank_assignments_and_callsign_catalog.sql", import.meta.url), "utf8");
  assert.match(api, /async function handleAddCallsign/);
  assert.match(api, /body\.action==="add_callsign"/);
  assert.match(api, /staff_callsigns/);
  assert.match(api, /entity_type:"staff_callsign"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.staff_callsigns/);
  assert.match(migration, /generate_series\(0,15\)/);
  assert.match(html, /＋ إضافة كود نداء جديد/);
  assert.match(html, /submitNewCallsign\(\)/);
  assert.doesNotMatch(html, /assignmentCustomCallsignWrap|id="assignmentCustomCallsign"/);
  assert.doesNotMatch(html, /إضافة Alpha جديد \(16 أو أكثر\)/);
});

test("manual personnel creation lives under Personnel and does not require member OAuth", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const personnelStart = html.indexOf('id="page-personnel"');
  const assignmentStart = html.indexOf('id="page-assignments"');
  const warningsStart = html.indexOf('id="page-warnings"');
  const personnel = html.slice(personnelStart, assignmentStart);
  const assignments = html.slice(assignmentStart, warningsStart);
  assert.match(api, /handleAddManualMember/);
  assert.match(api, /body\.action==="add_manual_member"/);
  assert.ok(api.includes('assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId)'));
  assert.match(api, /is_manual:true/);
  assert.match(api, /manual_created_by_discord_id:user\.id/);
  assert.match(api, /assignmentAvatar\(member,guildId\)/);
  assert.match(api, /entity_type:"staff_profile"/);
  assert.match(personnel, /إضافة عضو بدون تسجيل/);
  assert.match(personnel, /manualDiscordUserId/);
  assert.match(personnel, /submitManualMember/);
  assert.doesNotMatch(assignments, /openManualMemberModal\(\)/);
  assert.match(html, /profileType=m\.is_manual/);
});

test("assignment directory is above Discord roles and manager controls protect login history", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const directory = html.indexOf("دليل الأفراد والتعيينات");
  const roles = html.indexOf("الرتب المتاحة من سيرفر Discord");
  assert.ok(directory > 0 && roles > directory);
  assert.match(html, /personnelLoginActivityPanel/);
  assert.match(html, /activityPanel\.hidden=!currentIsOwner/);
  assert.match(html, /const actions=!currentIsOwner/);
});

test("assignment list keeps working when Discord member list is rate limited or unavailable", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /member_sync_warning/);
  assert.match(api, /profile\.discord_roles/);
  assert.match(api, /assignmentGuildMembers/);
  assert.match(html, /assignmentSyncNotice/);
  assert.match(html, /member\.in_guild===false/);
  assert.match(html, /سيتم التحقق من العضوية عند التعيين/);
});

test("manual additions, callsigns and multi-rank assignment have auditable writes", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108203000_multi_rank_assignments_and_callsign_catalog.sql", import.meta.url), "utf8");
  assert.match(api, /entity_type:"staff_profile"/);
  assert.match(api, /entity_type:"staff_callsign"/);
  assert.match(migration, /INSERT INTO public\.audit_logs/);
  assert.match(migration, /'before', v_before/);
  assert.match(migration, /'after', v_after/);
});
