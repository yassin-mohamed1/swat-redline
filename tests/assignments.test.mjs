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

test("a failed or opted-out Discord DM never rolls back a saved appointment or role update", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const roleWrite = api.indexOf("if(roleChanged)await assignmentDiscord");
  const databaseSave = api.indexOf('rpc/save_staff_assignment_v2', roleWrite);
  const dmAttempt = api.indexOf("await assignmentSendDm(token,targetId,embed)", databaseSave);
  assert.ok(roleWrite >= 0 && databaseSave > roleWrite && dmAttempt > databaseSave,
    "Discord roles must be updated, then the appointment saved, before the optional DM");
  assert.match(api, /let dmStatus=dmAllowed\?"sent":"skipped",dmFailure=null/);
  assert.match(api, /dmStatus="failed"/);
  assert.match(api, /dm_status:dmStatus/);
  assert.match(api, /profile\.notifications_enabled!==false/);
  assert.match(api, /dm_skipped_reason:"recipient_opted_out"/);
  assert.match(html, /data\.dm_status==='skipped'/);
  assert.match(html, /العضو أوقف استقبال الرسائل/);
  assert.match(api, /code==="50278"/);
  assert.match(api, /The appointment and Discord roles were saved/);
  assert.match(html, /data\.dm_status==='failed'/);
  assert.match(html, /DM delivery failure will not undo the appointment/);
});

test("assignment persistence failures return a safe database diagnostic and parse wrapped RPC results", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /assignment_rpc_network_error/);
  assert.match(api, /database_diagnostic:diagnostic/);
  assert.match(api, /rpcResult=Array\.isArray\(payload\)/);
  assert.match(api, /Assignment database save failed:/);
  assert.match(html, /data\.database_diagnostic/);
  assert.match(html, /Database diagnostic:/);
});

test("assignment handler defines its display name, reference and DM embed before mutations", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const start = api.indexOf("async function handleAssignmentPost(");
  const end = api.indexOf("\nasync function handleAddNextCallsign", start);
  assert.ok(start >= 0 && end > start, "assignment handler is present");
  const handler = api.slice(start, end);
  assert.match(handler, /const displayName=assignmentMemberName\(member,profile\.display_name\|\|"Discord member"\)/);
  assert.match(handler, /const reference=crypto\.randomUUID\(\)/);
  assert.match(handler, /const embed=assignmentEmbed\(/);
  assert.match(handler, /p_display_name:displayName/);
  assert.match(handler, /"تم تعيين "\+displayName/);
  assert.match(handler, /assignmentSendDm\(token,targetId,embed\)/);
  assert.doesNotMatch(handler, /p_display_name:name/);
  assert.doesNotMatch(handler, /\+"\+name\+/);
});

test("one click adds the next Alpha without a manually entered number", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /async function handleAddNextCallsign/);
  assert.match(api, /body\.action==="add_next_callsign"/);
  assert.match(api, /staff_callsigns\?select=callsign,is_active/);
  assert.match(api, /Math\.max\(\.\.\.used\)\+1/);
  assert.match(api, /entity_type:"staff_callsign"/);
  assert.match(html, /id="addCallsignButton" onclick="addNextCallsign\(\)"/);
  assert.match(html, /action:'add_next_callsign'/);
  assert.doesNotMatch(html, /newCallsignNumber|submitNewCallsign|إضافة Alpha جديد \(16 أو أكثر\)/);
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
  assert.match(html, /const profileType=pendingRegistrationBadge\(m\)/);
  assert.match(html, /إضافة تلقائية بواسطة بوت S\.W\.A\.T\./);
  assert.match(html, /registration_source==='bot_role'/);
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
  assert.match(html, /سيتم التحقق من العضوية عند الحفظ/);
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
