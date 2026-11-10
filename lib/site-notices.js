const DISCORD_SNOWFLAKE = /^\d{15,22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSiteNoticeId(value) {
  return typeof value === "string" && UUID.test(value);
}

export function normalizeSiteNoticeInput(value) {
  const title = String(value?.title ?? "").trim();
  const description = String(value?.description ?? "").trim();
  if (!title) throw Object.assign(new Error("اكتب اسم التعميم أولًا."), { status: 400 });
  if (title.length > 256) throw Object.assign(new Error("اسم التعميم أطول من الحد المسموح."), { status: 400 });
  if (!description) throw Object.assign(new Error("اكتب وصف التعميم أولًا."), { status: 400 });
  if (description.length > 4000) throw Object.assign(new Error("وصف التعميم أطول من الحد المسموح."), { status: 400 });
  return { title, description };
}

export function buildSiteNoticeDiscordPayload({
  title,
  description,
  notificationRoleId,
  roleMentionDisabled = true
}) {
  const roleId = String(notificationRoleId || "");
  const canMention = roleMentionDisabled === false && DISCORD_SNOWFLAKE.test(roleId);
  return {
    ...(canMention ? { content: "<@&" + roleId + ">" } : {}),
    embeds: [{
      author: { name: "S.W.A.T. REDLINE • تعميم رسمي" },
      title: String(title),
      description: String(description),
      color: 0xD92735,
      footer: { text: "S.W.A.T. REDLINE • COMMAND PORTAL" },
      timestamp: new Date().toISOString()
    }],
    allowed_mentions: canMention
      ? { parse: [], roles: [roleId] }
      : { parse: [] }
  };
}

export function siteNoticeBatchIsSent(batch) {
  return batch?.channel_status === "sent" && Boolean(batch?.channel_message_id);
}
