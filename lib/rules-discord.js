const MAX_SECTION_CHARS = 3400;

function safeDiscordLength(value) {
  return String(value ?? "").length;
}

export function splitDiscordSection(value, maxChars = MAX_SECTION_CHARS) {
  const text = String(value ?? "");
  if (!text.length) return [];
  const chunks = [];
  let current = "";
  for (const character of Array.from(text)) {
    if (current.length && current.length + character.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function embedTextLength(embed) {
  let total = 0;
  for (const value of [embed.title, embed.description, embed.url, embed.author?.name, embed.footer?.text]) {
    total += safeDiscordLength(value);
  }
  for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
    total += safeDiscordLength(field.name) + safeDiscordLength(field.value);
  }
  return total;
}

/**
 * Build one polished Discord embed for a normal law. Very long laws are
 * continued in identically styled messages only when Discord's 4096-char
 * description limit requires it. The name and law text stay together.
 */
export function buildRuleDiscordMessages(rule, actor, now = new Date(), options = {}) {
  const sentAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const destination = options?.destination === "server" ? "server" : "city";
  const destinationLabel = destination === "server" ? "SERVER RULES" : "S.W.A.T. CITY RULES";
  const id = String(rule?.id ?? "غير محدد");
  const sender = String(actor ?? "إدارة S.W.A.T.").slice(0, 120);
  const footer = "S.W.A.T. REDLINE • " + destinationLabel + " • " + id.slice(0, 120) + " • نشر بواسطة: " + sender;
  const lawName = String(rule?.title ?? "").trim() || "بدون اسم";
  const lawTextValue = String(rule?.body || rule?.description || "");
  const lawText = lawTextValue.trim() ? lawTextValue : "لم تتم إضافة نص القانون بعد.";
  const chunks = splitDiscordSection(lawText, MAX_SECTION_CHARS);
  const title = destination === "server"
    ? "📚 S.W.A.T. REDLINE • SERVER RULES"
    : "📜 S.W.A.T. REDLINE • OFFICIAL CITY RULES";

  return chunks.map((chunk, index) => {
    const first = index === 0;
    const description = first
      ? "**اسم القانون**\n" + lawName + "\n\n**القانون**\n" + chunk
      : "**متابعة القانون • " + (index + 1) + "/" + chunks.length + "**\n" + chunk;
    const embed = {
      color: 0xD92735,
      author: { name: "S.W.A.T. REDLINE • RULES & REGULATIONS" },
      title: first ? title : title + " • CONTINUED",
      description,
      footer: { text: footer },
      timestamp: sentAt
    };

    if (embedTextLength(embed) > 6000 || safeDiscordLength(description) > 4096) {
      throw new Error("A rules message section exceeds Discord's embed character limit.");
    }
    return { embeds: [embed] };
  });
}
