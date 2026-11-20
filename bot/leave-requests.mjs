const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function normalizeDigits(value) {
  return String(value || "").replace(/[٠-٩۰-۹]/g, digit => {
    const arabic = ARABIC_DIGITS.indexOf(digit);
    if (arabic >= 0) return String(arabic);
    const persian = PERSIAN_DIGITS.indexOf(digit);
    return persian >= 0 ? String(persian) : digit;
  });
}

export class LeaveRequestValidationError extends Error {
  constructor(message, code = "invalid_leave_request") {
    super(message);
    this.name = "LeaveRequestValidationError";
    this.code = code;
  }
}

export function validateLeaveRequestFields({ militaryName, reason, durationDays } = {}) {
  const normalizedName = String(militaryName || "").trim().replace(/\s+/g, " ");
  const normalizedReason = String(reason || "").trim();
  const rawDuration = normalizeDigits(durationDays).trim();
  const durationMatch = /^(\d{1,3})(?:\s*(?:يوم|أيام|يوما|يومًا|day|days))?$/i.exec(rawDuration);
  const days = durationMatch ? Number(durationMatch[1]) : NaN;

  if (normalizedName.length < 2 || normalizedName.length > 100) {
    throw new LeaveRequestValidationError("اكتب اسمك العسكري داخل المدينة (من حرفين إلى 100 حرف).", "invalid_military_name");
  }
  if (normalizedReason.length < 3 || normalizedReason.length > 1000) {
    throw new LeaveRequestValidationError("اكتب سبب الإجازة بوضوح (من 3 إلى 1000 حرف).", "invalid_leave_reason");
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new LeaveRequestValidationError("مدة الإجازة يجب أن تكون عدد أيام صحيحًا من 1 إلى 365.", "invalid_leave_duration");
  }

  return {
    militaryName: normalizedName,
    reason: normalizedReason,
    durationDays: days
  };
}

export function buildDiscordLeaveRequestRecord({
  interactionId,
  userId,
  guildId,
  channelId,
  profile,
  avatarUrl,
  militaryName,
  reason,
  durationDays,
  submittedAt = new Date()
}) {
  const values = validateLeaveRequestFields({ militaryName, reason, durationDays });
  const timestamp = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new LeaveRequestValidationError("تعذر تحديد وقت تقديم الطلب. أعد المحاولة.", "invalid_submission_time");
  }

  const validSnowflake = value => /^\d{15,22}$/.test(String(value || ""));
  if (![interactionId, userId, guildId, channelId].every(validSnowflake)) {
    throw new LeaveRequestValidationError("تعذر التحقق من بيانات Discord لهذا الطلب.", "invalid_discord_reference");
  }

  return {
    discord_user_id: String(userId),
    display_name: String(profile?.display_name || profile?.username || "SWAT Member").trim().slice(0, 100) || "SWAT Member",
    military_name: values.militaryName,
    reason: values.reason,
    requested_duration_days: values.durationDays,
    start_date: null,
    end_date: null,
    status: "pending",
    source: "discord",
    avatar_url: avatarUrl || profile?.avatar_url || null,
    discord_channel_id: String(channelId),
    discord_message_id: null,
    discord_message_url: "https://discord.com/channels/" + String(guildId) + "/" + String(channelId),
    discord_interaction_id: String(interactionId),
    submitted_at: timestamp.toISOString()
  };
}
