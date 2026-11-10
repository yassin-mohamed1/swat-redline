import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warnings API separates editor authorization from bot role execution", async () => {
  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(source, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(source, /DISCORD_BOT_ROLE_ID/);
  assert.match(source, /DISCORD_WARNING_ROLE_1_ID/);
  assert.match(source, /DISCORD_WARNING_ROLE_2_ID/);
  assert.doesNotMatch(source, /DISCORD_WARNING_ROLE_3_ID/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /DISCORD_BOT_TOKEN/);
  assert.match(source, /params.get\("diagnostics"\) === "1"/);
  assert.match(source, /sendDirectNotice/);
  assert.match(source, /complete_disciplinary_action_v2/);
  assert.match(source, /restoreMemberRoles/);
  assert.match(source, /function warningValidityDays\(level\)/);
  assert.match(source, /warningValidityDays\(level\) \* 24 \* 60 \* 60 \* 1000/);
});

test("disciplinary ladder permits Warning 1, Warning 2, then Dismissal only", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261108083809_two_warnings_then_dismissal.sql", import.meta.url), "utf8");
  assert.match(migration, /action_type = 'warning' AND warning_level IN \(1, 2\)/);
  assert.match(migration, /action_type = 'dismissal' AND warning_level = 3/);
  assert.match(migration, /v_subject\.warning_level <> 2/);

  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(source, /const WARNING_LEVELS = \[1, 2\]/);
  assert.match(source, /actionType === "dismissal" && level === 3/);

  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<option value="3">الفصل<\/option>/);
  assert.doesNotMatch(html, /<option value="3">Warning 3<\/option>/);
  assert.match(html, /الأعضاء المفصولون/);

  const restartMigration = await readFile(new URL("../supabase/migrations/20261108091704_allow_warning_cycle_restart_after_dismissal.sql", import.meta.url), "utf8");
  assert.match(restartMigration, /v_subject\.status = 'dismissed'/);
  assert.match(restartMigration, /p_action_type <> 'warning' or p_warning_level <> 1/);
  assert.match(html, /subject\?\.status==='dismissed'&&level===1/);
  assert.match(html, /بدء دورة جديدة/);
});

test("existing Discord announcement forwarder has its required text helper", async () => {
  const forwarder = await readFile(new URL("../lib/announcement-forwarder.js", import.meta.url), "utf8");
  assert.match(forwarder, /function truncate\(value, max = 900\)/);
  assert.match(forwarder, /function buildForwardParts\(/);
});

test("warning DMs respect member opt-out while announcements and expiry remain active", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108084856_warning_expiry_and_required_dm.sql", import.meta.url), "utf8");
  const optOutMigration = await readFile(new URL("../supabase/migrations/20261109135000_allow_disciplinary_dm_opt_out.sql", import.meta.url), "utf8");
  const schedule = await readFile(new URL("../supabase/migrations/20261108085251_warning_expiry_endpoint_consolidation.sql", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /memberPrivateNotificationsEnabled/);
  assert.match(api, /notifications_enabled/);
  assert.match(api, /if \(dmAllowed\)/);
  assert.match(api, /await sendDirectNotice/);
  assert.match(api, /await sendAnnouncement/);
  assert.match(api, /p_dm_status: dmResult \? "sent" : "skipped"/);
  assert.match(api, /dm_status: dmResult \? "sent" : "skipped"/);
  assert.match(api, /restoreMemberRoles/);
  assert.match(api, /CRON_SECRET/);
  assert.match(api, /processExpiredWarningRoles/);
  assert.match(api, /searchParams\.get\("task"\) === "expire"/);
  assert.match(api, /DISCORD_WARNING_ROLE_1_ID/);
  assert.match(api, /DISCORD_WARNING_ROLE_2_ID/);

  assert.match(migration, /warning_expires_at timestamptz/);
  assert.match(migration, /dm_status text NOT NULL DEFAULT 'pending'/);
  assert.match(optOutMigration, /'pending', 'sent', 'failed', 'skipped'/);
  assert.match(optOutMigration, /p_dm_status IN \('sent','skipped'\)/);
  assert.match(optOutMigration, /p_dm_status = 'failed'/);
  assert.match(migration, /claim_expired_warning_roles/);
  assert.match(migration, /complete_expired_warning_role/);
  assert.match(schedule, /\* \* \* \* \*/);
  assert.match(schedule, /swat-warning-role-expiry/);
  assert.match(schedule, /api\/warnings\?task=expire/);
  assert.match(html, /تلقائيًا/);
  assert.match(html, /الرسالة الخاصة/);
  assert.match(html, /30 يومًا/);
});


test("all site DM delivery paths honor each member's personal opt-out", async () => {
  const assignments = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const warnings = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const notifications = await readFile(new URL("../api/notifications/send.js", import.meta.url), "utf8");
  const forwarder = await readFile(new URL("../lib/announcement-forwarder.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(assignments, /notifications_enabled&limit=1/);
  assert.match(assignments, /profile\.notifications_enabled!==false/);
  assert.match(assignments, /dmStatus=dmAllowed\?"sent":"skipped"/);
  assert.match(warnings, /memberPrivateNotificationsEnabled/);
  assert.match(warnings, /return !rows\.length \|\| rows\[0\]\.notifications_enabled !== false/);
  assert.match(warnings, /if \(dmAllowed\)/);
  assert.match(notifications, /notifications_enabled: "eq\.true"/);
  assert.doesNotMatch(notifications, /recipientMap\.set\(ownerDiscordId/);
  assert.match(notifications, /ownerIncluded = recipients\.some/);
  assert.match(forwarder, /notifications_enabled: "eq\.true"/);
  assert.doesNotMatch(forwarder, /recipientMap\.set\(ownerDiscordId/);
  assert.match(html, /data\.dm_status==='skipped'/);
  assert.match(html, /استقبال الرسائل من إعداداته/);
});

test("disciplinary embeds use English branding and warning titles with Arabic field labels", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.ok(api.includes('author: { name: "S.W.A.T. REDLINE • OFFICIAL DISCIPLINARY RECORD" }'));
  assert.ok(api.includes('title: dismissed ? "⛔ MEMBER DISMISSED" : "⚠️ OFFICIAL " + actionLabel'));
  assert.ok(api.includes('value: actionLabel'));
  assert.ok(api.includes('name: "العضو"'));
  assert.ok(api.includes('name: "سبب الإجراء"'));
  assert.ok(api.includes('name: "الإجراء التأديبي"'));
  assert.ok(api.includes('footer: { text: "S.W.A.T. REDLINE • DISCIPLINARY & COMPLIANCE" }'));
});

test("warnings page follows the existing Arabic and English portal switch", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /"التحذيرات":"Warnings"/);
  assert.match(html, /"الإنذار الأول":"Warning 1"/);
  assert.match(html, /"الإنذار الثاني":"Warning 2"/);
  assert.match(html, /"سبب الإجراء":"Reason"/);
  assert.match(html, /"الإجراء التأديبي":"Disciplinary Action"/);
  assert.match(html, /"قناة التحذيرات":"Warnings Channel"/);
  assert.match(html, /"تم إصدار الإنذار الأول وإرسال الإشعار الخاص/);
  assert.match(html, /function fmtWarningDate\(value\)/);
  assert.match(html, /currentPortalLanguage\(\)==='en'/);
  assert.match(html, /Are you sure you want to /);
  assert.match(html, /function togglePortalLanguage\(\)/);
  assert.match(html, /page-warnings.*classList\.contains\('active'\).*renderWarnings\(\)/s);
  assert.match(html, /Object\.assign\(PORTAL_ATTRIBUTE_TRANSLATIONS/);
});

test("Warning 1 expires after 30 days and Warning 2 expires after 60 days", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /function warningValidityDays\(level\)\s*\{\s*return Number\(level\) === 2 \? 60 : 30;/);
  assert.match(api, /warningValidityDays\(level\) \* 24 \* 60 \* 60 \* 1000/);
  assert.match(api, /warningValidityDays\(level\) \+ " يومًا"/);
  assert.match(html, /function warningDurationDays\(level\)\s*\{\s*return Number\(level\)===2\?60:30;/);
  assert.match(html, /يظل الإنذار الأول ساريًا لمدة 30 يومًا/);
  assert.match(html, /يظل الإنذار الثاني ساريًا لمدة 60 يومًا/);
  assert.match(html, /ينتهي بعد '\+warningDurationDays\(level\)\+' يومًا\.'/);
  assert.match(html, /"ينتهي بعد 60 يومًا\."\s*:\s*"Expires after 60 days\."/);
});

test("warning announcements use the existing SWAT role toggle and target mention", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const settingsApi = await readFile(new URL("../api/admin/settings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /notificationRoleId = process\.env\.DISCORD_NOTIFICATION_ROLE_ID/);
  assert.match(api, /swatRoleMentionEnabled: values\.notificationRoleMentionDisabled === false/);
  assert.match(api, /targetMentionEnabled: values\.disciplinaryTargetMentionEnabled !== false/);
  assert.match(api, /swatRoleMentionEnabled \? "<@&" \+ cfg\.notificationRoleId \+ ">" : null/);
  assert.match(api, /targetMentionEnabled \? "<@" \+ targetId \+ ">" : null/);
  assert.match(api, /parse: \[\]/);
  assert.match(api, /roles: mentionSettings\.swatRoleMentionEnabled \? \[cfg\.notificationRoleId\] : \[\]/);
  assert.match(api, /users: mentionSettings\.targetMentionEnabled \? \[targetId\] : \[\]/);
  assert.doesNotMatch(api, /@everyone|disciplinaryEveryoneMentionEnabled/);

  assert.ok(settingsApi.includes('"disciplinaryTargetMentionEnabled"]'));
  assert.doesNotMatch(settingsApi, /disciplinaryEveryoneMentionEnabled/);
  assert.match(html, /id="notificationMentionDisabledToggle"/);
  assert.match(html, /إعلانات التحذيرات وقرارات الفصل/);
  assert.match(html, /id="disciplinaryTargetMentionToggle"/);
  assert.doesNotMatch(html, /disciplinaryEveryoneMentionToggle|disciplinaryEveryoneMentionEnabled|@everyone/);
  assert.match(html, /saveDisciplinaryTargetMentionPreference\(this\.checked\)/);
});

test("disciplinary embeds display the Discord member avatar and fallback avatar", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(api, /function discordAvatarUrl\(member, guildId\)/);
  assert.match(api, /cdn\.discordapp\.com\/guilds\//);
  assert.match(api, /cdn\.discordapp\.com\/avatars\//);
  assert.match(api, /cdn\.discordapp\.com\/embed\/avatars\//);
  assert.match(api, /thumbnail: \{ url: target\.avatarUrl \}/);
  assert.match(api, /avatarUrl: discordAvatarUrl\(target, cfg\.guildId\)/);
  assert.match(api, /p_avatar_url: targetProfile\.avatarUrl/);
});

test("every disciplinary Discord message includes the portal link button", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(api, /function portalLinkComponents\(\)/);
  assert.ok(api.includes('label: "فتح بوابة S.W.A.T. REDLINE"'));
  assert.match(api, /components: portalLinkComponents\(\)/);
  assert.match(api, /embeds: \[embed\], components: portalLinkComponents\(\)/);
});

test("every website notification chunk includes the portal link button", async () => {
  const api = await readFile(new URL("../api/notifications/send.js", import.meta.url), "utf8");
  assert.match(api, /const siteComponents = siteUrl \? \[\{/);
  assert.match(api, /components: siteComponents/);
  assert.match(api, /notificationBodyChunks\.slice\(1\)\.forEach/);
  assert.match(api, /images: \[\],\s*components: siteComponents,\s*content: ""/);
});


test("disciplinary status changes synchronize warning roles and save an immutable audit trail", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108093000_manage_disciplinary_records.sql", import.meta.url), "utf8");
  assert.match(api, /body\.action === "adjust_state"/);
  assert.match(api, /async function syncWarningLevel/);
  assert.match(api, /await restoreMemberRoles\(cfg, targetId, roleResult\.originalRoles\)/);
  assert.match(api, /rpc\(cfg, "set_disciplinary_subject_state"/);
  assert.match(migration, /INSERT INTO public\.audit_logs/);
  assert.match(migration, /'before', v_before/);
  assert.match(migration, /'after', v_after/);
});

test("disciplinary warning editing updates name, level and history even when Discord messages are missing", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261110143307_disciplinary_action_management.sql", import.meta.url), "utf8");
  assert.match(api, /body\.action === "edit_action"/);
  assert.match(api, /target_name: targetName/);
  assert.match(api, /p_warning_level: requestedLevel/);
  assert.match(api, /rpc\(cfg, "edit_disciplinary_action_record_v2"/);
  assert.match(api, /if \(!path\) continue/);
  assert.match(api, /syncWarningLevel\(cfg, record\.discord_user_id, requestedLevel\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.edit_disciplinary_action_record_v2/);
  assert.match(migration, /'before',v_before/);
  assert.match(migration, /'after',v_after/);
});

test("warning page groups member states, new actions, and message history into separate views", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="warningViewMembers"/);
  assert.match(html, /id="warningViewCreate"/);
  assert.match(html, /id="warningViewHistory"/);
  assert.match(html, /data-warning-filter="first"/);
  assert.match(html, /data-warning-filter="second"/);
  assert.match(html, /data-warning-filter="dismissed"/);
  assert.match(html, /data-warning-filter="clear"/);
  assert.match(html, /function submitWarningAdjustment\(\)/);
  assert.match(html, /function submitWarningEdit\(\)/);
  assert.match(html, /function showWarningView\(view\)/);
});


test("warning actions can be voided without hard-deleting their records", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261110143307_disciplinary_action_management.sql", import.meta.url), "utf8");
  const start = api.indexOf('if (body.action === "void_action")');
  const end = api.indexOf('if (body.action === "edit_action")', start);
  const handler = api.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /rpc\(cfg, "void_disciplinary_action_record"/);
  assert.match(handler, /method: "DELETE"/);
  assert.match(handler, /syncWarningLevel\(cfg, record\.discord_user_id/);
  assert.match(handler, /roles_synced: rolesSynced/);
  assert.match(migration, /status IN \('pending','completed','failed','voided'\)/);
  assert.match(migration, /void_reason text/);
  assert.match(migration, /voided_by_discord_id text/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.void_disciplinary_action_record/);
  assert.match(migration, /'before',v_before/);
  assert.match(migration, /'after',v_after/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.void_disciplinary_action_record/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.void_disciplinary_action_record[\s\S]*TO service_role/);
});

test("warning management remains restricted to the existing owner and Website Admin gate", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const handler = api.slice(api.indexOf("export default async function handler"));
  const managerGate = handler.indexOf("await requireManager(cfg, user)");
  const voidAction = handler.indexOf('if (body.action === "void_action")');
  const editAction = handler.indexOf('if (body.action === "edit_action")');
  assert.ok(managerGate >= 0 && voidAction > managerGate && editAction > managerGate);
  assert.match(api, /async function requireManager\(cfg, user\)/);
  assert.match(api, /if \(user\.isOwner \|\| await isWebsiteAdmin\(user\)\) return/);
  assert.match(api, /if \(!requireSameOrigin\(req, res\)\) return/);
});

test("warning member names can be edited from the manager-only state editor", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /const requestedName = typeof body\.display_name === "string"/);
  assert.match(api, /p_display_name: targetName/);
  assert.match(html, /id="warningManageName"/);
  assert.match(html, /display_name:String\(document\.getElementById\('warningManageName'\)/);
});

test("warning history exposes edit and void actions for completed warnings, independent of old Discord IDs", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("function renderWarningHistory()");
  const end = html.indexOf("function openWarningManage(", start);
  const renderer = html.slice(start, end);
  assert.match(html, /id="warningEditName"/);
  assert.match(html, /id="warningEditLevel"/);
  assert.match(html, /function voidWarningAction\(actionId\)/);
  assert.match(html, /action:'void_action'/);
  assert.match(html, /<option value="voided">الإجراءات الملغاة<\/option>/);
  assert.match(renderer, /a\.status==='completed'&&a\.action_type==='warning'/);
  assert.match(renderer, /onclick="openWarningEdit/);
  assert.match(renderer, /onclick="voidWarningAction/);
  assert.doesNotMatch(renderer, /a\.dm_channel_id&&a\.dm_message_id&&a\.channel_message_id/);
});


test("disciplinary subjects can be archived from the current list without deleting their history", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261110144840_archive_disciplinary_subjects.sql", import.meta.url), "utf8");
  const start = api.indexOf('if (body.action === "archive_subject"');
  const end = api.indexOf('if (body.action === "adjust_state")', start);
  const handler = api.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes('rpc(cfg, "set_disciplinary_subject_archive"'));
  assert.ok(handler.includes("p_actor_discord_id: user.id"));
  assert.ok(!handler.includes("cannot_archive_subject_with_active_warning"));
  assert.ok(api.includes('listData(cfg, params.get("include_archived") === "1")'));
  assert.ok(api.includes("is_archived=eq.false"));
  assert.ok(migration.includes("ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false"));
  assert.ok(migration.includes("CREATE OR REPLACE FUNCTION public.set_disciplinary_subject_archive"));
  assert.ok(migration.includes("INSERT INTO public.audit_logs"));
  assert.ok(migration.includes("is_archived = false"));
  assert.ok(migration.includes("REVOKE ALL ON FUNCTION public.set_disciplinary_subject_archive"));
  assert.ok(migration.includes("GRANT EXECUTE ON FUNCTION public.set_disciplinary_subject_archive"));
});

test("the warnings page hides archived subjects by default and offers manager restore", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes("let warningShowArchived=false"));
  assert.ok(html.includes("include_archived=1"));
  assert.ok(html.includes("Boolean(s.is_archived)!==warningShowArchived"));
  assert.ok(!html.includes("لا يمكن إخفاء عضو لديه إنذار فعّال"));
  assert.ok(!html.includes("const canArchive=level===0||s.status==='dismissed'"));
  assert.ok(html.includes("حتى لو كان عليه إنذار فعّال"));

  assert.ok(html.includes("function toggleWarningArchivedView()"));
  assert.ok(html.includes("function archiveWarningSubject(id)"));
  assert.ok(html.includes("function restoreWarningSubject(id)"));
  assert.ok(html.includes("action:'archive_subject'"));
  assert.ok(html.includes("action:'restore_subject'"));
});


test("attendance dashboard is a separate page directly below warnings", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /params\.get\("attendance"\) === "1"/);
  assert.match(api, /async function listAttendanceDashboard\(cfg\)/);
  assert.match(api, /attendance_records/);
  assert.match(api, /profile\.is_active === true/);
  assert.match(api, /is_banned: "eq\.false"/);
  assert.match(html, /id="attendanceNav"/);
  assert.match(html, /id="page-attendance"/);
  assert.doesNotMatch(html, /id="warningTabAttendance"/);
  assert.doesNotMatch(html, /id="warningViewAttendance"/);
  assert.match(html, /fetch\('\/api\/warnings\?attendance=1'/);
  assert.match(html, /current_streak_days/);
  assert.match(html, /last_seven_days/);
});


test("automatic attendance discipline reuses the existing warning ladder at 7, 14, and 21 days", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261110175528_attendance_disciplinary_automation.sql", import.meta.url), "utf8");
  assert.match(api, /async function processAutomaticAttendanceDiscipline\(cfg\)/);
  assert.match(api, /member\.next_stage \* 7/);
  assert.match(api, /applyAutomaticAttendanceAction\(/);
  assert.match(api, /begin_disciplinary_action/);
  assert.match(api, /complete_disciplinary_action_v2/);
  assert.match(api, /updateMemberRoles\(cfg,discordUserId,level,actionType==="dismissal"\)/);
  assert.match(api, /await sendDirectNotice/);
  assert.match(api, /await sendAnnouncement/);
  assert.match(api, /processAutomaticAttendanceDiscipline\(cronCfg\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.attendance_discipline_claims/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_swat_attendance_discipline/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_swat_attendance_discipline/);
  const guardMigration = await readFile(new URL("../supabase/migrations/20261110180500_guard_attendance_discipline_until_production.sql", import.meta.url), "utf8");
  assert.match(guardMigration, /enabled boolean NOT NULL DEFAULT false/);
  assert.match(guardMigration, /'status','disabled'/);
  assert.match(api, /next_allowed_at_ms/);
  assert.match(api, /Date\.now\(\) >= member\.next_allowed_at_ms/);
  assert.match(api, /Date\.now\(\) - lastActionMs < 7 \* 86400000/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.claim_swat_attendance_discipline/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_swat_attendance_discipline[\s\S]*TO service_role/);
});

test("attendance roster checks live SWAT roles and keeps dismissed members in history", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(api, /const swatRoleId = process\.env\.DISCORD_ROLE_ID/);
  assert.match(api, /member\.roles\.includes\(cfg\.swatRoleId\)/);
  assert.match(api, /subject\?\.status === "dismissed"/);
  assert.match(api, /is_swat_member/);
  assert.match(api, /absence_started_at/);
  assert.match(html, /const activeRows=rows\.filter\(member=>member\.is_swat_member\)/);
  assert.match(html, /منذ انضمام العضو:/);
});
