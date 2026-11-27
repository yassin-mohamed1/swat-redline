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

test("manual disciplinary actions allow Warning 2 or dismissal without earlier warnings", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261108083809_two_warnings_then_dismissal.sql", import.meta.url), "utf8");
  assert.match(migration, /action_type = 'warning' AND warning_level IN \(1, 2\)/);
  assert.match(migration, /action_type = 'dismissal' AND warning_level = 3/);
  assert.match(migration, /v_subject\.warning_level <> 2/);

  const manualMigration = await readFile(new URL("../supabase/migrations/20261110205216_allow_manual_disciplinary_actions_out_of_order.sql", import.meta.url), "utf8");
  assert.match(manualMigration, /p_action_type = 'warning' AND p_warning_level NOT IN \(1,2\)/);
  assert.match(manualMigration, /p_action_type = 'dismissal' AND p_warning_level <> 3/);
  assert.doesNotMatch(manualMigration, /warning_level_out_of_sequence/);
  assert.doesNotMatch(manualMigration, /dismissal_requires_warning_two/);
  assert.match(manualMigration, /v_subject\.status = 'dismissed'/);
  assert.match(manualMigration, /p_action_type <> 'warning' OR p_warning_level <> 1/);

  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const manualHandlerStart = source.indexOf('const actionType = body.action === "dismiss"');
  const manualHandlerEnd = source.indexOf('const expiresAt = actionType === "warning"', manualHandlerStart);
  assert.ok(manualHandlerStart >= 0 && manualHandlerEnd > manualHandlerStart);
  const manualHandler = source.slice(manualHandlerStart, manualHandlerEnd);
  assert.match(manualHandler, /WARNING_LEVELS\.includes\(level\)/);
  assert.doesNotMatch(manualHandler, /warning_level_out_of_sequence|dismissal_requires_warning_two|current_warning_level/);
  assert.match(source, /const WARNING_LEVELS = \[1, 2\]/);
  assert.match(source, /actionType === "dismissal" && level === 3/);

  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<option value="3">الفصل<\/option>/);
  assert.doesNotMatch(html, /<option value="3">Warning 3<\/option>/);
  assert.match(html, /الأعضاء المفصولون/);
  const refreshUiStart = html.indexOf("function refreshWarningForm()");
  const refreshUiEnd = html.indexOf("async function renderWarnings()", refreshUiStart);
  assert.ok(refreshUiStart >= 0 && refreshUiEnd > refreshUiStart);
  const refreshUi = html.slice(refreshUiStart, refreshUiEnd);
  assert.match(refreshUi, /const canIssue=Boolean\(id\)&&\(!isDismissed\|\|restartingDismissed\)&&level<=2/);
  assert.match(refreshUi, /dismiss\.disabled=!id\|\|isDismissed\|\|level!==3/);
  assert.doesNotMatch(refreshUi, /current\+1|current!==2/);
  const manualUiStart = html.indexOf("async function submitWarningAction(action)");
  const manualUiEnd = html.indexOf("\n}\n", manualUiStart);
  assert.ok(manualUiStart >= 0 && manualUiEnd > manualUiStart);
  const manualUiHandler = html.slice(manualUiStart, manualUiEnd);
  assert.doesNotMatch(manualUiHandler, /currentLevel/);
  assert.doesNotMatch(manualUiHandler, /لا يمكن تنفيذ الفصل إلا بعد تسجيل الإنذار الثاني/);
  assert.doesNotMatch(manualUiHandler, /يجب إصدار الإنذارات بالترتيب/);
  assert.ok(manualUiHandler.includes("if(subject?.status==='dismissed'&&!restartingDismissed)"));


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
  const deliveryMigration = await readFile(new URL("../supabase/migrations/20261117175515_decouple_disciplinary_dm_delivery.sql", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /memberPrivateNotificationsEnabled/);
  assert.match(api, /notifications_enabled/);
  assert.match(api, /if \(dmAllowed\)/);
  assert.match(api, /await sendDirectNotice/);
  assert.match(api, /await sendAnnouncement/);
  assert.match(api, /p_dm_status:dmStatus/,
    "the completion RPC receives the explicit sent, failed, or skipped delivery state");
  assert.match(api, /dmStatus="failed"/);
  assert.match(api, /dmStatus="sent"/);
  assert.match(api, /dmStatus="skipped"/);
  assert.match(api, /p_dm_channel_id:dmResult\?\.channelId\|\|null/);
  assert.match(api, /p_dm_message_id:dmResult\?\.messageId\|\|null/);
  assert.match(api, /restoreMemberRoles/);
  assert.match(api, /CRON_SECRET/);
  assert.match(api, /processExpiredWarningRoles/);
  assert.match(api, /searchParams\.get\("task"\) === "expire"/);
  assert.match(api, /DISCORD_WARNING_ROLE_1_ID/);
  assert.match(api, /DISCORD_WARNING_ROLE_2_ID/);

  assert.match(migration, /warning_expires_at timestamptz/);
  assert.match(migration, /dm_status text NOT NULL DEFAULT 'pending'/);
  assert.match(optOutMigration, /'pending', 'sent', 'failed', 'skipped'/);
  assert.match(deliveryMigration, /p_dm_status NOT IN \('sent','failed','skipped'\)/);
  assert.match(deliveryMigration, /A DM is best-effort/);
  assert.match(deliveryMigration, /p_role_sync_status = 'succeeded'/);
  assert.match(deliveryMigration, /p_channel_status = 'sent'/);
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
  assert.ok(api.includes('title: dismissed ? "⛔ MEMBER FIRED" : "⚠️ OFFICIAL " + actionLabel'));
  assert.ok(api.includes('value: actionLabel'));
  assert.ok(api.includes('name: "العضو"'));
  assert.ok(api.includes('name: "سبب الإجراء"'));
  assert.ok(api.includes('name: "الإجراء التأديبي"'));
  assert.ok(api.includes('footer: { text: "S.W.A.T. REDLINE • DISCIPLINARY & COMPLIANCE" }'));
});


test("FIRED card is sent as one warning-channel message with an image attachment", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const settings = await readFile(new URL("../api/admin/settings.js", import.meta.url), "utf8");

  assert.ok(api.includes("function decodeMessageCardImage(value)"));
  assert.ok(api.includes("function decodeDismissalCardImage(value)"));
  assert.ok(api.includes("cardImageBytes = decodeMessageCardImage(body.image_data)"));
  assert.ok(api.includes('image: { url: "attachment://redline-fired.png" }'));
  assert.ok(api.includes('image: { url: "attachment://redline-warning-1.png" }'));
  assert.ok(api.includes('image: { url: "attachment://redline-warning-2.png" }'));
  assert.ok(api.includes('form.append("files[0]"'));
  assert.ok(api.includes("body.card_type !== cardType"));
  assert.ok(api.includes("targetId, cardImageBytes, cardType"));
  assert.ok(api.includes("users: mentionSettings.targetMentionEnabled ? [targetId] : []"));
  assert.ok(api.includes("components: portalLinkComponents()"));

  assert.ok(html.includes('id="dismissalCardEditorButton"'));
  assert.ok(html.includes('id="messageTemplateChooserModalBack"'));
  assert.ok(html.includes("تعديل الرسالة"));
  assert.ok(html.includes("openMessageTemplateEditor('dismissal')"));
  assert.ok(html.includes("openMessageTemplateEditor('warning1')"));
  assert.ok(html.includes("openMessageTemplateEditor('warning2')"));
  assert.ok(html.includes("function openDismissalCardEditor()"));
  assert.ok(html.includes("function createDismissalCardDataUrl(discordUserId)"));
  assert.ok(html.includes("image_data:imageData"));
  assert.ok(html.includes("warning1TemplateUrl"));
  assert.ok(html.includes("warning2TemplateUrl"));
  assert.ok(settings.includes('"dismissalTemplateUrl"'));
  assert.ok(settings.includes('"dismissalCardDesign"'));
  assert.ok(settings.includes('"warning1TemplateUrl"'));
  assert.ok(settings.includes('"warning1CardDesign"'));
  assert.ok(settings.includes('"warning2TemplateUrl"'));
  assert.ok(settings.includes('"warning2CardDesign"'));
});


test("FIRED, Warning 1 and Warning 2 editors use independent saved templates and designs", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const settings = await readFile(new URL("../api/admin/settings.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");

  for (const type of ["dismissal", "warning1", "warning2"]) {
    assert.ok(html.includes(type + ":{urlKey:"));
    assert.ok(html.includes(type + "CardDesign"));
    assert.ok(html.includes(type + "TemplateUrl"));
  }
  assert.ok(html.includes("activeMessageCardType=type"));
  assert.ok(html.includes("[definition.designKey]:normalizeMessageCardDesign(asset.design)"));
  assert.ok(html.includes("[definition.urlKey]:asset.url"));
  assert.ok(html.includes("const cardType=action==='dismiss'?'dismissal':level===1?'warning1':'warning2'"));
  assert.ok(html.includes("createMessageCardDataUrl(id,cardType,action==='dismiss')"));

  assert.ok(settings.includes('"warning1TemplateUrl"'));
  assert.ok(settings.includes('"warning1CardDesign"'));
  assert.ok(settings.includes('"warning2TemplateUrl"'));
  assert.ok(settings.includes('"warning2CardDesign"'));

  assert.ok(api.includes('cardType === "warning1" ? "attachment://redline-warning-1.png"'));
  assert.ok(api.includes('cardType === "warning2" ? "attachment://redline-warning-2.png"'));
  assert.ok(api.includes('cardType === "dismissal" ? "attachment://redline-fired.png"'));
  assert.ok(api.includes('actionType === "dismissal" && !cardImageBytes'));
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

  assert.ok(settingsApi.includes('"disciplinaryTargetMentionEnabled"'));
  assert.doesNotMatch(settingsApi, /disciplinaryEveryoneMentionEnabled/);
  assert.match(html, /id="notificationMentionDisabledToggle"/);
  assert.match(html, /إعلانات التحذيرات وقرارات الفصل/);
  assert.match(html, /id="disciplinaryTargetMentionToggle"/);
  assert.doesNotMatch(html, /disciplinaryEveryoneMentionToggle|disciplinaryEveryoneMentionEnabled/);
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
  assert.match(html, /const activeRows=attendanceData\.members\.filter\(member=>member\.is_swat_member\)/);
  assert.match(api, /days_since_last/);
  assert.match(api, /last_attendance_at/);
  assert.match(html, /const days=Math\.max\(0,Math\.floor\(Number\(member\.display_days_since_last\?\?member\.days_since_last\)\|\|0\)\)/);
  assert.match(html, /attendanceDuration\(days\)/);
});


test("approved resignations remove every manageable Discord role except Activated and Family", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(api, /RESIGNATION_PRESERVED_ROLE_IDS = Object\.freeze\(\[/);
  assert.match(api, /"1561666360717606993"/);
  assert.match(api, /"1569390325364162650"/);

  const helperStart = api.indexOf("async function prepareResignationRoleRemoval");
  const helperEnd = api.indexOf("async function restoreMemberRoles", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = api.slice(helperStart, helperEnd);
  assert.match(helper, /loadGuildRoleData\(cfg\)/);
  assert.match(helper, /role\.managed \|\| role\.position >= guild\.botTop\.position/);
  assert.match(helper, /method: "PATCH"/);
  assert.match(helper, /roles: plan\.preservedRoles/);
  assert.match(helper, /unexpected\.length/);
  assert.match(helper, /process\.env\.DISCORD_OWNER_ID/);
  assert.doesNotMatch(helper, /\\\\d\{15,22\}/);

  const reviewStart = api.indexOf('if (body.action === "review_resignation_request")');
  const reviewEnd = api.indexOf('if (body.action === "create_attendance_leave" || body.action === "submit_attendance_leave")', reviewStart);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart);
  const review = api.slice(reviewStart, reviewEnd);
  assert.match(review, /if \(status === "approved"\)[\s\S]*?prepareResignationRoleRemoval/);
  assert.match(review, /applyResignationRoleRemoval/);
  assert.match(review, /approval_rolled_back: rollbackSucceeded/);
  assert.match(review, /status: "pending"/);
  assert.match(review, /removed_role_count: resignationRoleCleanup\?\.removedRoleCount/);
});

test("resignation admin is a dedicated dashboard with safe test-data cleanup", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const cleanupStart = api.indexOf('if (body.action === "delete_resignation_test_requests")');
  const cleanupEnd = api.indexOf('if (body.action === "save_attendance_exemptions")', cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
  const cleanup = api.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /request_ids/);
  assert.match(cleanup, /allowedTestReasons/);
  assert.match(cleanup, /invalidRows\.length/);
  assert.match(cleanup, /publication_channel_id/);
  assert.match(cleanup, /method: "DELETE"/);
  assert.match(cleanup, /resignation_test_cleanup/);

  assert.match(html, /class="modal resignation-admin-modal"/);
  assert.match(html, /id="resignationAdminStats"/);
  assert.match(html, /data-resign-filter="pending"/);
  assert.match(html, /id="resignationAdminSearch"/);
  assert.match(html, /deleteResignationTestRequests\(\)/);
  assert.match(html, /function isResignationTestRecord\(item\)/);
  assert.match(html, /resign-card/);
  assert.match(html, /resign-avatar/);
  assert.match(html, /#resignationAdminModalBack \.resign-avatar\{display:block!important;width:48px!important/);
  assert.match(html, /TEST DATA/);
});

test("inactive former staff are excluded from resignation selection and cannot submit a new resignation", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const optionsStart = api.indexOf('if (req.method === "GET" && params.get("resignation_member_options") === "1")');
  const optionsEnd = api.indexOf('if (req.method === "GET" && params.get("resignation_requests") === "1")', optionsStart);
  assert.ok(optionsStart >= 0 && optionsEnd > optionsStart);
  const options = api.slice(optionsStart, optionsEnd);
  assert.ok(options.includes("await requireManager(cfg, user)"));
  assert.ok(options.includes('is_active: "eq.true"'));
  assert.ok(options.includes('is_banned: "eq.false"'));
  assert.ok(options.includes('status: "eq.pending"'));

  const createStart = api.indexOf('if (body.action === "submit_resignation_request" || body.action === "create_resignation_request")');
  const reviewStart = api.indexOf('if (body.action === "review_resignation_request")', createStart);
  assert.ok(createStart >= 0 && reviewStart > createStart);
  const create = api.slice(createStart, reviewStart);
  assert.ok(create.includes("profile.is_active !== true"));
  assert.ok(create.includes("Only a currently active staff profile"));
  assert.ok(!create.includes("discordMember.roles.includes(cfg.swatRoleId)"));

  const modalStart = html.indexOf("async function openResignationAdminModal(){");
  const modalEnd = html.indexOf("function closeResignationAdminModal(){", modalStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart);
  const modal = html.slice(modalStart, modalEnd);
  assert.ok(modal.includes("resignation_member_options=1"));
  assert.ok(modal.includes("resignationMemberOptions.map"));
  assert.ok(!modal.includes("attendanceData.members.filter(member=>member.is_swat_member)"));
});

test("approved resignation retires portal access and unassigns the member without erasing history", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261127065237_retire_staff_on_resignation_and_dismissal.sql", import.meta.url), "utf8");
  const start = api.indexOf('if (body.action === "review_resignation_request")');
  const end = api.indexOf('if (body.action === "create_attendance_leave" || body.action === "submit_attendance_leave")', start);
  const handler = api.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.includes('rpc(cfg, "retire_staff_member"'));
  assert.ok(handler.includes("p_remaining_role_ids: resignationRoleCleanup.remainingRoleIds"));
  assert.ok(handler.includes("approval_rolled_back: rollbackSucceeded"));
  assert.ok(handler.includes("roles_restored: rolesRestored"));
  assert.ok(migration.includes("UPDATE public.staff_profiles"));
  assert.ok(migration.includes("is_active = false"));
  assert.ok(migration.includes("UPDATE public.staff_assignments"));
  assert.ok(migration.includes("status = 'unassigned'"));
  assert.ok(migration.includes("UPDATE public.disciplinary_subjects"));
  assert.ok(migration.includes("is_archived = true"));
  assert.ok(migration.includes("REVOKE ALL ON FUNCTION public.retire_staff_member"));
  assert.ok(migration.includes("GRANT EXECUTE ON FUNCTION public.retire_staff_member"));
  assert.ok(api.includes("is_active=eq.true&is_banned=eq.false"));
});

test("successful manual and attendance dismissals retire portal profiles and archive warning subjects", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261127065237_retire_staff_on_resignation_and_dismissal.sql", import.meta.url), "utf8");
  assert.ok(api.includes("profile.is_active !== true"));
  assert.ok(api.includes("target.roles.includes(cfg.swatRoleId)"));
  assert.ok(api.includes("complete_disciplinary_action_v2"));
  assert.ok(migration.includes("IF v_action.action_type = 'dismissal' THEN"));
  assert.ok(migration.includes("public.retire_staff_member("));
  assert.ok(migration.includes("is_archived = (v_action.action_type = 'dismissal')"));
  assert.ok(migration.includes("disciplinary_subjects_archived"));
});

test("former staff remain visible in the directory and portal access follows the live Discord role", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const membersApi = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");
  const oauth = await readFile(new URL("../api/auth/discord.js", import.meta.url), "utf8");
  const session = await readFile(new URL("../api/auth/session.js", import.meta.url), "utf8");
  const roleSync = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");

  assert.ok(html.includes("const visibleMembers=members;"));
  assert.ok(!html.includes("showFormerPersonnelList"));
  assert.ok(!html.includes("personnelFormerToggle"));

  const activityRoute = membersApi.indexOf('searchParams.get("activity") === "1"');
  const directoryStart = membersApi.indexOf("const q = new URLSearchParams({", activityRoute);
  const directoryEnd = membersApi.indexOf("Backward-compatible fallback", directoryStart);
  assert.ok(directoryStart >= 0 && directoryEnd > directoryStart);
  const directory = membersApi.slice(directoryStart, directoryEnd);
  assert.ok(directory.includes('"staff_profiles?" + q'));
  assert.ok(!directory.includes("is_active=eq.true"));

  assert.ok(oauth.includes("member.roles.includes(roleId)"));
  assert.ok(oauth.includes("existingProfile?.is_banned"));
  assert.ok(!oauth.includes("existingProfile.is_active === false"));
  assert.ok(oauth.includes("is_active: true"));

  assert.ok(session.includes("discordApiRequest(token, \"/guilds/\" + guildId + \"/members/\" + user.id"));
  assert.ok(session.includes("member.roles.includes(accessRoleId)"));
  assert.ok(!session.includes("rows[0].is_active === false"));
  assert.ok(session.includes("rows[0].is_banned"));

  assert.ok(roleSync.includes("existingProfilesById"));
  assert.ok(roleSync.includes("requires_reactivation"));
  assert.ok(roleSync.includes("profile.is_active === false"));
  assert.ok(roleSync.includes("reactivated_count"));
});

test("returning former personnel are restored in place, not inserted as duplicate profiles", async () => {
  const roleSync = await readFile(new URL("../lib/discord-role-sync.js", import.meta.url), "utf8");
  const membersApi = await readFile(new URL("../api/admin/members.js", import.meta.url), "utf8");

  assert.ok(roleSync.includes('is_active: true'));
  assert.ok(roleSync.includes('is_active: "eq.false"'));
  assert.ok(roleSync.includes('is_banned: "eq.false"'));
  assert.ok(roleSync.includes("reactivated_ids"));
  assert.ok(membersApi.includes("if(existing){"));
  assert.ok(membersApi.includes("const accessRoleId=String(process.env.DISCORD_ROLE_ID||\"\")"));
  assert.ok(membersApi.includes("reactivated:true"));
  assert.ok(membersApi.includes('action==="delete"') || membersApi.includes('action === "delete"'));
  assert.ok(membersApi.includes('rpc/forget_staff_member_data'));
});

test("FIRED preview fetches the selected member live and prevents stale async renders overwriting a newer selection", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes("let dismissalPreviewSelectionRevision=0"));
  assert.ok(html.includes("let dismissalPreviewRenderRevision=0"));
  assert.ok(html.includes("dismissal_card_member=1&discord_user_id="));
  assert.ok(html.includes("if(revision!==dismissalPreviewSelectionRevision)return"));
  assert.ok(html.includes("if(revision!==dismissalPreviewRenderRevision)return"));
  assert.ok(html.includes("const stage=document.createElement('canvas')"));
  assert.ok(api.includes('is_active: "eq.true"'));
  assert.ok(api.includes("member.roles.includes(cfg.swatRoleId)"));
});

test("resignation review confirmation dialog appears above the admin dashboard", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /#resignationAdminModalBack\.modalback\{z-index:120!important/);
  assert.match(html, /#resignationReviewModalBack\{[\s\S]*?z-index:140!important/);
  assert.match(html, /#resignationReviewModalBack\.open\{[\s\S]*?display:flex!important/);
  assert.match(html, /function openResignationApproval\(id\)\{openResignationReview\(id,'approved'\);\}/);
  assert.match(html, /id="resignationReviewSubmitButton"[^>]*onclick="submitResignationReview\(\)"/);
});