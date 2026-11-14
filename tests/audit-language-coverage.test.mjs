import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("Arabic-English phrase index refreshes after the final translation dictionary", async () => {
  const html = await read("index.html");
  const finalTranslation = html.lastIndexOf('"تم تسجيل الخروج":"Signed out"');
  const refresh = html.lastIndexOf("portalTranslationEntries.splice(0,portalTranslationEntries.length");
  const firstApply = html.lastIndexOf("\napplyPortalLanguage();");
  assert.ok(finalTranslation >= 0, "late phrase translations should exist");
  assert.ok(refresh > finalTranslation, "phrase index must include all late dictionaries");
  assert.ok(firstApply > refresh, "initial translation pass must run after the index refresh");
  assert.match(html, /new MutationObserver\(\(records\)=>\{/);
  assert.match(html, /record\.addedNodes/);
  assert.match(html, /togglePortalLanguage\(\)/);
});

test("saved-message delivery destination controls have English translations", async () => {
  const html = await read("index.html");
  for (const phrase of [
    '"جهة الإرسال":"Delivery destination"',
    '"رسالة خاصة لعضو محدد":"Direct message to one selected member"',
    '"القنوات المحددة: ":"Selected channels: "',
    '"إرسال الخاص متوقف من إعدادات الموقع الحالية. لم يتم تغيير الإعدادات.":"Direct messages are disabled in the current site settings. No settings were changed."'
  ]) assert.ok(html.includes(phrase), "missing delivery translation: " + phrase);
  const lastMap = html.indexOf('"إعادة الإرسال ↻":"Resend ↻"');
  const indexRefresh = html.indexOf("portalTranslationEntries.splice(0,portalTranslationEntries.length");
  assert.ok(lastMap >= 0 && indexRefresh > lastMap, "delivery translations must be indexed before first language apply");
});

test("page views and language changes are sent through the audit API", async () => {
  const html = await read("index.html");
  const auditApi = await read("api/audit/log.js");
  assert.match(html, /type==='عرض'\?'view'/);
  assert.match(html, /log\('عرض','فتح صفحة '/);
  assert.match(html, /Changed interface language to English/);
  assert.match(auditApi, /"permission_change", "view"/);
});

test("saved-message creation, edits, deletions, buttons and deliveries append and forward audit events", async () => {
  const source = await read("lib/saved-discord-messages.js");
  assert.match(source, /import \{ forwardAuditToDiscord \} from "\.\/audit-log\.js"/);
  assert.match(source, /async function appendSavedMessageAudit/);
  for (const event of [
    "إنشاء قالب رسالة محفوظة",
    "تعديل قالب رسالة محفوظة",
    "حذف قالب رسالة محفوظة",
    "تعديل أزرار روابط رسالة محفوظة",
    "إرسال رسالة محفوظة إلى Discord",
    "إرسال رسالة محفوظة إلى الرسائل الخاصة"
  ]) assert.ok(source.includes(event), "missing audit event: " + event);
  assert.match(source, /await forwardAuditToDiscord\(user,auditEvent\)/);
});

test("project-code publishing is added to the administration and Discord audit trail", async () => {
  const source = await read("api/admin/settings.js");
  assert.match(source, /async function appendAdminAuditEvent/);
  assert.match(source, /entity_type:"project_code_publish"/);
  assert.match(source, /await appendAdminAuditEvent\(user,/);
  assert.match(source, /forwardAuditEventsToDiscord, forwardAuditToDiscord/);
});

test("shared-state changes remain server-audited and forwarded to Discord", async () => {
  const source = await read("api/state.js");
  assert.match(source, /buildStateAuditEvents\(current\.data,safeData,user\)/);
  assert.match(source, /appendStateAuditEvents\(supabaseUrl,serviceKey,auditEvents\)/);
  assert.match(source, /forwardAuditEventsToDiscord\(batch\)/);
});
