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

test("warning DM and announcement delivery are mandatory and expiry is scheduled", async () => {
  const api = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20261108084856_warning_expiry_and_required_dm.sql", import.meta.url), "utf8");
  const schedule = await readFile(new URL("../supabase/migrations/20261108085251_warning_expiry_endpoint_consolidation.sql", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(api, /await sendDirectNotice/);
  assert.match(api, /await sendAnnouncement/);
  assert.match(api, /تعذّر إرسال الرسالة الخاصة إلى العضو/);
  assert.match(api, /restoreMemberRoles/);
  assert.match(api, /CRON_SECRET/);
  assert.match(api, /processExpiredWarningRoles/);
  assert.match(api, /searchParams\.get\("task"\) === "expire"/);
  assert.match(api, /DISCORD_WARNING_ROLE_1_ID/);
  assert.match(api, /DISCORD_WARNING_ROLE_2_ID/);

  assert.match(migration, /warning_expires_at timestamptz/);
  assert.match(migration, /dm_status text NOT NULL DEFAULT 'pending'/);
  assert.match(migration, /claim_expired_warning_roles/);
  assert.match(migration, /complete_expired_warning_role/);
  assert.match(schedule, /\* \* \* \* \*/);
  assert.match(schedule, /swat-warning-role-expiry/);
  assert.match(schedule, /api\/warnings\?task=expire/);
  assert.match(html, /تلقائيًا/);
  assert.match(html, /الرسالة الخاصة/);
  assert.match(html, /30 يومًا/);
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
  assert.match(api, /label: "فتح بوابة S\\.W\\.A\\.T\\. REDLINE"/);
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
