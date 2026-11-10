const MAX_SECTION_CHARS = 3600;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 5800;

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

function sectionEmbeds(label, value, footer, timestamp) {
  const chunks = splitDiscordSection(value);
  return chunks.map((chunk, index) => ({
    color: 0xD92735,
    title: chunks.length > 1 ? label + " • " + (index + 1) + "/" + chunks.length : label,
    description: chunk,
    footer: { text: footer },
    timestamp
  }));
}

/**
 * Build Discord embeds without trimming, summarizing, or truncating saved rule
 * text. Long sections are split at Unicode code-point boundaries and packed
 * into legal Discord messages while preserving their original order.
 */
export function buildRuleDiscordMessages(rule, actor, now = new Date(), options = {}) {
  const sentAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const destination = options?.destination === "server" ? "server" : "city";
  const destinationLabel = destination === "server" ? "SERVER RULES" : "S.W.A.T. CITY RULES";
  const id = String(rule?.id ?? "غير محدد");
  const sender = String(actor ?? "إدارة S.W.A.T.").slice(0, 256);
  const footer = "S.W.A.T. REDLINE • " + destinationLabel + " • " + id.slice(0, 120) + " • نشر بواسطة: " + sender.slice(0, 100);

  const embeds = [{
    color: 0xD92735,
    author: { name: "S.W.A.T. REDLINE • RULES & REGULATIONS" },
    title: destination === "server" ? "📚 S.W.A.T. REDLINE • SERVER RULES" : "📜 S.W.A.T. REDLINE • OFFICIAL CITY RULES",
    description: destination === "server"
      ? "تم نشر قانون رسمي عبر بوابة S.W.A.T. REDLINE."
      : "تم نشر قانون رسمي عبر بوابة S.W.A.T. REDLINE.",
    fields: [
      { name: "رقم المرجع", value: id.slice(0, 1024), inline: true },
      { name: "نشر بواسطة", value: sender || "إدارة S.W.A.T.", inline: true },
      { name: "القسم", value: destinationLabel, inline: true }
    ],
    footer: { text: footer },
    timestamp: sentAt
  }];

  const sections = [
    ["اسم القانون", rule?.title],
    ["القانون", rule?.body || rule?.description]
  ];
  for (const [label, value] of sections) {
    if (value === null || value === undefined || String(value).length === 0) continue;
    embeds.push(...sectionEmbeds(label, String(value), footer, sentAt));
  }

  if (embeds.length === 1) {
    embeds[0].fields.push({
      name: "المحتوى",
      value: "لم تتم إضافة اسم القانون أو نصه بعد.",
      inline: false
    });
  }

  const messages = [];
  let currentEmbeds = [];
  let currentChars = 0;
  for (const embed of embeds) {
    const size = embedTextLength(embed);
    if (size > MAX_EMBED_CHARS_PER_MESSAGE) {
      throw new Error("A rules message section exceeds Discord's embed character limit.");
    }
    if (currentEmbeds.length &&
        (currentEmbeds.length >= MAX_EMBEDS_PER_MESSAGE || currentChars + size > MAX_EMBED_CHARS_PER_MESSAGE)) {
      messages.push({ embeds: currentEmbeds });
      currentEmbeds = [];
      currentChars = 0;
    }
    currentEmbeds.push(embed);
    currentChars += size;
  }
  if (currentEmbeds.length) messages.push({ embeds: currentEmbeds });
  return messages;
}
