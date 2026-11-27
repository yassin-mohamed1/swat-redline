const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export class ResignationRequestValidationError extends Error {
  constructor(message, code = "invalid_resignation_request") {
    super(message);
    this.name = "ResignationRequestValidationError";
    this.code = code;
  }
}

export function validateResignationRequestFields({ memberName, reason } = {}) {
  const normalizedName = String(memberName || "").trim().replace(/\s+/g, " ");
  const normalizedReason = String(reason || "").trim();
  if (normalizedName.length < 2 || normalizedName.length > 100) throw new ResignationRequestValidationError("اكتب اسمك (من حرفين إلى 100 حرف).", "invalid_resignation_name");
  if (normalizedReason.length < 3 || normalizedReason.length > 2000) throw new ResignationRequestValidationError("اكتب سبب الاستقالة بوضوح (من 3 إلى 2000 حرف).", "invalid_resignation_reason");
  return { memberName: normalizedName, reason: normalizedReason };
}

export function buildDiscordResignationRequestRecord({ interactionId, userId, guildId, channelId, profile, avatarUrl, memberName, reason, submittedAt = new Date() }) {
  const values = validateResignationRequestFields({ memberName, reason });
  const timestamp = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
  const validSnowflake = value => /^\d{15,22}$/.test(String(value || ""));
  if (!Number.isFinite(timestamp.getTime())) throw new ResignationRequestValidationError("تعذر تحديد وقت تقديم الطلب. أعد المحاولة.", "invalid_submission_time");
  if (![interactionId, userId, guildId, channelId].every(validSnowflake)) throw new ResignationRequestValidationError("تعذر التحقق من بيانات Discord لهذا الطلب.", "invalid_discord_reference");
  return {
    discord_user_id: String(userId),
    display_name: String(profile?.display_name || profile?.username || "SWAT Member").trim().slice(0, 100) || "SWAT Member",
    member_name: values.memberName,
    reason: values.reason,
    status: "pending",
    source: "discord",
    avatar_url: avatarUrl || profile?.avatar_url || null,
    discord_channel_id: String(channelId),
    discord_interaction_id: String(interactionId),
    discord_message_url: "https://discord.com/channels/" + String(guildId) + "/" + String(channelId),
    submitted_at: timestamp.toISOString()
  };
}
