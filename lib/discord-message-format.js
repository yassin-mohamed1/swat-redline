export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
export const DISCORD_ATTACHMENT_SAFE_LIMIT = 20 * 1024 * 1024;

export function safeDiscordMessageFilename(title) {
  const cleaned = String(title || "SWAT-Message")
    .normalize("NFKC")
    .replace(/[\\u0000-\\u001f\\u007f\\/\\\\:*?"<>|]/g, "-")
    .replace(/\\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return (cleaned || "SWAT-Message") + ".txt";
}

export function buildDiscordMessageEmbed({ title, content, footer = "S.W.A.T. REDLINE • OFFICIAL MESSAGE", timestamp = new Date().toISOString() }) {
  const body = String(content ?? "");
  const normalizedTitle = String(title || "رسالة رسمية").trim().slice(0, 256) || "رسالة رسمية";
  const useAttachment = body.length > DISCORD_EMBED_DESCRIPTION_LIMIT;
  return {
    useAttachment,
    filename: safeDiscordMessageFilename(normalizedTitle),
    embed: {
      color: 0xD92735,
      title: normalizedTitle,
      description: useAttachment
        ? "المحتوى الكامل مرفق في ملف نصي واحد مع هذه الرسالة."
        : body,
      footer: { text: footer },
      timestamp
    }
  };
}
