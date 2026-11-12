export const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;
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

export function buildDiscordMessageContent({ title, content }) {
  const rawBody = String(content ?? "");
  const body = rawBody.trim() ? rawBody : "إشعار إداري من S.W.A.T. REDLINE.";
  const normalizedTitle = String(title ?? "").trim().slice(0, 256);
  const displayTitle = normalizedTitle || (!rawBody.trim() ? "رسالة من S.W.A.T." : "");
  const heading = displayTitle ? "# 🔴 " + displayTitle : "";
  const fullContent = heading ? heading + "\n\n" + body : body;
  const useAttachment = fullContent.length > DISCORD_MESSAGE_CONTENT_LIMIT;
  const attachmentNotice = "📎 **المحتوى الكامل مرفق في ملف نصي واحد.**";
  const visibleContent = useAttachment
    ? (heading ? heading + "\n\n" + attachmentNotice : attachmentNotice)
    : fullContent;
  return {
    useAttachment,
    filename: safeDiscordMessageFilename(normalizedTitle),
    content: visibleContent,
    fileContent: body,
    title: normalizedTitle,
    characterCount: body.length
  };
}
