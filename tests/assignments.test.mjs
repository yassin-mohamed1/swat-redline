import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relativePath, encoding = "utf8") => readFile(new URL(relativePath, import.meta.url), encoding);

test("assignment and personnel APIs use the same warning manager role and enforce it server-side", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const warnings = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(api, /staff_profiles\?discord_user_id=/);
  assert.match(api, /member\.roles\.includes\(managerRoleId\)/);
  assert.match(api, /requireAssignmentManager\(url,key,process\.env\.DISCORD_BOT_TOKEN/);
  assert.match(api, /req\.method==="PATCH"&&!canManagePortal/);
  assert.match(api, /searchParams\.get\("activity"\)==="1"&&!canManagePortal/);
  assert.match(warnings, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  // Warnings now delegate manager authorization to the shared Website Admin verifier.
  assert.match(warnings, /user\.isOwner \|\| await isWebsiteAdmin\(user\)/);
  assert.match(html, /currentCanManageAssignments=currentCanAdmin/);
  assert.match(html, /currentCanManageWarnings=warningAccess\.ok/);
  assert.match(html, /currentCanAdmin\|\|currentCanManageAssignments/);
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
  assert.match(html, /activityPanel\.hidden=!currentCanAdmin/);
  assert.match(html, /const actions=!currentCanAdmin/);
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


test("Website Admin role stays visible but cannot be assigned through the appointments role picker", async () => {
  const api = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /function assignmentRankList\(roles, botPosition, guildId, canManageRoles, protectedRoleIds = \[\]\)/);
  assert.match(api, /protectedIds\.has\(String\(role\.id\)\) \? "protected"/);
  assert.match(api, /const protectedRoleIds=allowWebsiteAdminRole\?\[\]:\[process\.env\.DISCORD_WEBSITE_ADMIN_ROLE_ID\]/);
  assert.match(api, /const protectedRoleIds=user\?\.isOwner\?\[\]:\[process\.env\.DISCORD_WEBSITE_ADMIN_ROLE_ID\]/);
  assert.match(api, /allowWebsiteAdminRole\?\[\]:\[process\.env\.DISCORD_WEBSITE_ADMIN_ROLE_ID\]/);
  assert.match(api, /targetRoles\.some\(role=>!role\|\|!role\.assignable\)/);
  assert.match(html, /role\.unavailable_reason==='protected'/);
  assert.match(html, /رتبة WEBSITE ADMIN محمية ولا يمكن منحها من داخل الموقع/);
});

test("city rank is independent from Discord roles and is saved through the member identity record", async () => {
  const api = await read("../api/admin/members.js", "utf8");
  const html = await read("../index.html", "utf8");
  const migration = await read("../supabase/migrations/20261110231505_staff_member_identities.sql", "utf8");
  const start = api.indexOf("async function handleSaveCityRank(");
  const end = api.indexOf("\nasync function handlePublishMemberIdentity(", start);
  assert.ok(start >= 0 && end > start, "independent City Rank handler exists");
  const handler = api.slice(start, end);
  for (const rank of [
    "swat_commander", "deputy_swat_commander", "swat_team_leader",
    "swat_supervisor", "swat_senior_operator", "swat_operator", "swat_recruit"
  ]) {
    assert.ok(api.includes('key: "' + rank + '"') || migration.includes("'" + rank + "'"));
  }
  assert.match(handler, /staff_member_identities\?on_conflict=discord_user_id/);
  assert.match(handler, /city_rank:cityRank\.key/);
  assert.doesNotMatch(handler, /assignmentDiscord\(|staff_assignments/);
  assert.match(api, /body\.action==="save_city_rank"/);
  assert.match(html, /id="assignmentCityRank"/);
  assert.match(html, /saveAssignmentCityRank\(\)/);
  assert.match(html, /حفظ City Rank فقط/);
  assert.match(html, /city_rank:action==='assign'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.staff_member_identities/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.staff_member_identities FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.staff_member_identities TO service_role/);
});

test("member identity publishing sends one card and updates the stored Discord message instead of duplicating it", async () => {
  const api = await read("../api/admin/members.js", "utf8");
  const html = await read("../index.html", "utf8");
  const migration = await read("../supabase/migrations/20261110231505_staff_member_identities.sql", "utf8");
  const start = api.indexOf("async function handlePublishMemberIdentity(");
  const end = api.indexOf("\nasync function handleAddNextCallsign(", start);
  assert.ok(start >= 0 && end > start, "identity publisher exists");
  const handler = api.slice(start, end);
  assert.match(handler, /SWAT_MEMBERS_CHANNEL_ID/);
  assert.match(handler, /method:"PATCH"/);
  assert.match(handler, /method:"POST"/);
  assert.match(handler, /Number\(error\?\.status\)!==404/);
  assert.match(handler, /staff_member_identities\?discord_user_id=eq\./);
  assert.match(handler, /message_id:String\(message\.id\)/);
  assert.match(handler, /const discordMessagePayload=\{/);
  assert.ok(handler.includes('content:"<@"+targetId+">"'));
  assert.match(handler, /allowed_mentions:\{parse:\[\],users:\[targetId\]\}/);
  assert.match(handler, /body:JSON\.stringify\(discordMessagePayload\)/);
  assert.equal((handler.match(/body:JSON\.stringify\(discordMessagePayload\)/g)||[]).length,2,
    "the exact same targeted mention is included on both create and update");
  assert.doesNotMatch(handler, /@everyone|@here/);
  assert.match(handler, /CITY_RANKS\.find/);
  assert.match(handler, /memberIdentityEmbed/);
  assert.match(handler, /assignment\?\.callsign/);
  const embedStart = api.indexOf("function memberIdentityEmbed(");
  const embedEnd = api.indexOf("\nasync function assignmentSendDm", embedStart);
  assert.ok(embedStart >= 0 && embedEnd > embedStart, "identity embed builder exists");
  const embedBuilder = api.slice(embedStart, embedEnd);
  assert.ok(embedBuilder.includes('description:"**"+safeName+"**"'));
  assert.match(embedBuilder, /thumbnail:\{url:avatar\}/);
  assert.match(embedBuilder, /inline:true/);
  assert.doesNotMatch(embedBuilder, /author:|title:|footer:|timestamp:/);
  assert.match(embedBuilder, /CITY RANK/);
  assert.match(embedBuilder, /CALL SIGN/);
  assert.match(api, /SWAT_MEMBERS_CHANNEL_ID = "1561489833505849505"/);
  assert.match(html, /id="assignmentRows"/);
  assert.match(html, /City Rank/);
  assert.match(html, /publishMemberIdentity\(/);
  assert.match(html, /identity\.message_id\?'تحديث الهوية':'إرسال الهوية'/);
  assert.match(migration, /message_id text/);
  assert.match(migration, /staff_member_identities_message_pair_check/);
  assert.match(migration, /staff_member_identities_message_unique/);
});
