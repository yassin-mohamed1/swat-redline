function isSnowflake(value) {
  return /^\\d{15,22}$/.test(String(value || ""));
}

export function isTargetVoiceEntry({
  userId,
  targetUserId,
  guildId,
  expectedGuildId,
  oldChannelId,
  newChannelId
}) {
  return isSnowflake(userId) &&
    isSnowflake(targetUserId) &&
    String(userId) === String(targetUserId) &&
    String(guildId || "") === String(expectedGuildId || "") &&
    Boolean(newChannelId) &&
    String(newChannelId) !== String(oldChannelId || "");
}

export async function sendVoiceEntryDm({ client, recipientId, channelName, enteredAt }) {
  if (!isSnowflake(recipientId)) throw new Error("voice_alert_recipient_invalid");
  if (!client?.users?.fetch) throw new Error("voice_alert_client_unavailable");

  const safeChannelName = String(channelName || "روم صوتي")
    .replace(/[\\r\\n]/g, " ")
    .replace(/@/g, "@\\u200b")
    .slice(0, 80);
  const date = enteredAt instanceof Date ? enteredAt : new Date(enteredAt || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("voice_alert_timestamp_invalid");

  const localTime = new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh"
  }).format(date);
  const recipient = await client.users.fetch(String(recipientId));
  if (!recipient || typeof recipient.send !== "function") {
    throw new Error("voice_alert_recipient_unavailable");
  }

  await recipient.send({
    content: `🔔 **تنبيه دخول صوتي**\\nدخل العضو المحدد روم **${safeChannelName}**.\\nالوقت: ${localTime} (بتوقيت الرياض).`,
    allowedMentions: { parse: [] }
  });
  return true;
}
