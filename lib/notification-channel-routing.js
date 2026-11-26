export const BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID = "1562483351993057320";

const DISCORD_CHANNEL_ID_RE = /^\d{17,20}$/;
const EVIDENCE_ENTITY_TYPES = new Set(["person", "case", "investigation"]);

export function validateAutomaticNotificationChannelId(value) {
  if (typeof value !== "string") {
    throw new Error("معرّف قناة الإشعارات التلقائية يجب أن يكون نصًا.");
  }
  const id = value.trim();
  if (!id) return "";
  if (!DISCORD_CHANNEL_ID_RE.test(id)) {
    throw new Error("اختر قناة Discord نصية صحيحة من قائمة القنوات.");
  }
  if (id === BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID) {
    throw new Error("قناة Redline Server ممنوعة من الإرسال التلقائي.");
  }
  return id;
}

export function resolveNotificationChannelRoute(type, options = {}) {
  const usesEvidenceChannel = EVIDENCE_ENTITY_TYPES.has(String(type || ""));
  const id = String(
    usesEvidenceChannel
      ? options.evidenceChannelId || ""
      : options.automaticChannelId || ""
  ).trim();

  if (id === BLOCKED_AUTOMATIC_NOTIFICATION_CHANNEL_ID) {
    throw new Error("قناة Redline Server ممنوعة من الإرسال التلقائي.");
  }
  if (!DISCORD_CHANNEL_ID_RE.test(id)) {
    throw new Error(usesEvidenceChannel
      ? "قناة الأدلة والملفات غير مضبوطة. راجع إعداد DISCORD_EVIDENCE_CHANNEL_ID."
      : "لم يتم اختيار قناة الإشعارات التلقائية. افتح إعدادات النظام وحدد قناة Discord أولًا.");
  }

  return {
    id,
    label: usesEvidenceChannel ? "الأدلة والملفات" : "الإشعارات التلقائية"
  };
}
