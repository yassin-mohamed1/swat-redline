export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
export const DISCORD_ATTACHMENT_SAFE_LIMIT = 20 * 1024 * 1024;

export function safeDiscordMessageFilename(title) {
  const normalized = String(title || "SWAT-Message").normalize("NFKC");
  const forbidden = new Set(Array.from('/\\:*?"<>|'));
  let cleaned = "";
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    cleaned += codePoint < 32 || codePoint === 127 || forbidden.has(character) ? "-" : character;
  }
  cleaned = cleaned.trim().split(/\s+/u).join("-");
  cleaned = cleaned.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
  return (cleaned || "SWAT-Message") + ".txt";
}

export function buildDiscordMessageEmbed({ title, content, footer = "S.W.A.T. REDLINE • OFFICIAL MESSAGE", timestamp = new Date().toISOString() }) {
  const rawBody = String(content ?? "");
  const body = rawBody.trim() ? rawBody : "إشعار إداري من S.W.A.T. REDLINE.";
  const normalizedTitle = String(title || "رسالة من S.W.A.T.").trim().slice(0, 256) || "رسالة من S.W.A.T.";
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
