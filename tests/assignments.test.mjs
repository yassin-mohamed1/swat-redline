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
  const currentAssignmentRanks = [
    "swatcommander", "deputyswatcommander", "swatteamleader",
    "swatsupervisor", "swatoperator"
  ];
  for (const role of currentAssignmentRanks) {
    assert.match(api, new RegExp('key: "' + role + '"'), "missing current assignment rank " + role);
  }
  assert.doesNotMatch(api, /swatsenioroperator|swatrecruit/,
    "removed legacy ranks must not be required by the assignment API");
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
    "swat_supervisor", "swat_operator"
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
  assert.match(handler, /MEMBER_IDENTITIES_CHANNEL_ID/);
  assert.match(api, /const MEMBER_IDENTITIES_CHANNEL_ID = "1561490450953670817"/);
  assert.match(handler, /identity\?\.channel_id===MEMBER_IDENTITIES_CHANNEL_ID/);
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
  assert.doesNotMatch(api, /SWAT_MEMBERS_CHANNEL_ID/);
  assert.match(html, /id="assignmentRows"/);
  assert.match(html, /City Rank/);
  assert.match(html, /publishMemberIdentity\(/);
  assert.match(html, /identity\.message_id\?'تحديث الهوية':'إرسال الهوية'/);
  assert.match(migration, /message_id text/);
  assert.match(migration, /staff_member_identities_message_pair_check/);
  assert.match(migration, /staff_member_identities_message_unique/);
});

test("assignment API blocks a callsign reserved by another member before touching Discord roles", async () => {
  const api = await read("../api/admin/members.js");
  const html = await read("../index.html");
  assert.match(api, /callsign:"eq\."\+callsign/);
  assert.match(api, /status:"eq\.assigned"/);
  assert.match(api, /discord_user_id:"neq\."\+targetId/);
  assert.match(api, /CALLSIGN_ALREADY_ASSIGNED/);
  const conflictCheckAt = api.indexOf('staff_assignments?"+conflictQuery.toString()');
  const roleChangeAt = api.indexOf('if(roleChanged)await assignmentDiscord');
  assert.ok(conflictCheckAt > 0 && roleChangeAt > conflictCheckAt,
    "reserved callsigns must be rejected before any Discord role update");
  assert.match(api, /staff_assignments_callsign_unique_idx/);
  assert.match(html, /reservedByOthers/);
  assert.match(html, /محجوز لعضو آخر/);
  assert.match(html, /assignmentCallsignAvailability/);
  assert.match(html, /reserved\?'disabled':''/);
});


test("unit identity cards can be manually reordered from the portal without moving, deleting, or recreating Discord messages", async () => {
  const api = await read("../api/admin/members.js");
  const html = await read("../index.html");
  const migration = await read("../supabase/migrations/20261123010000_add_unit_card_sort_order.sql");

  assert.match(api, /unit_sort_order/);
  assert.match(api, /async function handleSaveUnitCardOrder/);
  assert.match(api, /rpc\/save_staff_unit_card_order/);
  assert.match(api, /body\.action==="save_unit_card_order"/);

  const handlerStart = api.indexOf("async function handleSaveUnitCardOrder");
  const handlerEnd = api.indexOf("\nexport default async function handler", handlerStart);
  const handler = api.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.doesNotMatch(handler, /assignmentDiscord|\/channels\/|method:"DELETE"|method:"PATCH"/);

  assert.match(html, /id="unitCardOrderPanel"/);
  assert.match(html, /id="unitCardOrderRows"/);
  assert.match(html, /function moveUnitCard/);
  assert.match(html, /function saveUnitCardOrder/);
  assert.match(html, /function resetUnitCardOrderToAlpha/);
  assert.match(html, /action:'save_unit_card_order'/);
  assert.match(html, /unit_sort_order/);
  assert.match(html, /رتّب البطاقات كما تريد، ثم امسح رسائل الروم وأعد نشرها كلها/);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS unit_sort_order integer/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.save_staff_unit_card_order/);
  assert.match(migration, /unit_sort_order = requested\.sort_position - 1/);
  assert.match(migration, /identity\.channel_id = '1561490450953670817'/);
  assert.match(migration, /identity\.message_id IS NOT NULL/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.save_staff_unit_card_order/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.save_staff_unit_card_order\(text\[\]\)\s+TO service_role/);
});

test("SWAT UNITS channel controls clear the specified channel and republish existing identity cards in saved order", async () => {
  const api = await read("../api/admin/members.js");
  const html = await read("../index.html");
  const migration = await read("../supabase/migrations/20261123020000_retain_unit_order_after_channel_clear.sql");

  assert.match(api, /const UNIT_CARDS_CHANNEL_ID = "1561490450953670817"/);
  assert.match(api, /async function listUnitChannelMessages/);
  assert.match(api, /\/messages\/bulk-delete/);
  assert.match(api, /DISCORD_BULK_DELETE_MAX_AGE_MS/);
  assert.match(api, /async function handleClearUnitCardChannel/);
  assert.match(api, /async function handlePublishAllUnitCards/);
  assert.match(api, /body\.action==="clear_unit_channel_messages"/);
  assert.match(api, /body\.action==="publish_all_unit_cards"/);

  const clearStart = api.indexOf("async function handleClearUnitCardChannel");
  const publishStart = api.indexOf("async function handlePublishAllUnitCards", clearStart);
  const handlerEnd = api.indexOf("async function handleSaveUnitCardOrder", publishStart);
  const clearHandler = api.slice(clearStart, publishStart);
  const publishHandler = api.slice(publishStart, handlerEnd);
  assert.ok(clearStart >= 0 && publishStart > clearStart && handlerEnd > publishStart);
  assert.match(clearHandler, /listUnitChannelMessages\(token, UNIT_CARD_CHANNEL_ID/);
  assert.match(clearHandler, /deleteUnitChannelMessages\(token,messages\)/);
  assert.match(clearHandler, /channel_id:null,message_id:null,published_at:null/);
  assert.match(clearHandler, /staff_member_identities\?channel_id=eq\./);
  assert.match(publishHandler, /messages\?limit=1/);
  assert.match(publishHandler, /روم SWAT UNITS ليس فارغًا/);
  assert.match(publishHandler, /assignmentMapLimit\(cards,4/);
  assert.match(publishHandler, /memberIdentityEmbed/);
  assert.match(publishHandler, /unit_sort_order:index/);
  assert.match(publishHandler, /allowed_mentions:\{parse:\[\],users:\[card\.id\]\}/);

  assert.match(html, /id="clearUnitChannelButton"/);
  assert.match(html, /id="publishUnitCardsButton"/);
  assert.match(html, /function clearUnitChannelMessages/);
  assert.match(html, /function publishUnitCardsInOrder/);
  assert.match(html, /امسح كل رسائل SWAT UNITS/);
  assert.match(html, /action:\x27clear_unit_channel_messages\x27/);
  assert.match(html, /action:\x27publish_all_unit_cards\x27/);
  assert.match(html, /احفظ ترتيب البطاقات أولًا/);

  assert.match(migration, /identity\.city_rank IS NOT NULL/);
  assert.doesNotMatch(migration, /identity\.message_id IS NOT NULL/);
  assert.match(migration, /unit_sort_order = requested\.sort_position - 1/);
});
