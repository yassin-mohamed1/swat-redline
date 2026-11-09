const MAX_SECTION_CHARS = 3600;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 5800;

function codePointLength(value) {
  return Array.from(String(value ?? "")).length;
}

export function splitDiscordSection(value, maxChars = MAX_SECTION_CHARS) {
  const text = String(value ?? "");
  const characters = Array.from(text);
  if (!characters.length) return [];
  const chunks = [];
  for (let index = 0; index < characters.length; index += maxChars) {
    chunks.push(characters.slice(index, index + maxChars).join(""));
  }
  return chunks;
}

function embedTextLength(embed) {
  let total = 0;
  for (const value of [embed.title, embed.description, embed.url, embed.author?.name, embed.footer?.text]) {
    total += codePointLength(value);
  }
  for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
    total += codePointLength(field.name) + codePointLength(field.value);
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
export function buildRuleDiscordMessages(rule, actor, now = new Date()) {
  const sentAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const id = String(rule?.id ?? "غير محدد");
  const sender = String(actor ?? "إدارة S.W.A.T.").slice(0, 256);
  const footer = "S.W.A.T. REDLINE • OFFICIAL RULES • " + id.slice(0, 120);

  const embeds = [{
    color: 0xD92735,
    author: { name: "S.W.A.T. REDLINE • RULES & REGULATIONS" },
    title: "📜 S.W.A.T. REDLINE • OFFICIAL RULES",
    description: "تم نشر مادة رسمية من قوانين ولوائح S.W.A.T. REDLINE عبر بوابة القيادة.",
    fields: [
      { name: "رقم المرجع", value: id.slice(0, 1024), inline: true },
      { name: "نشر بواسطة", value: sender || "إدارة S.W.A.T.", inline: true },
      { name: "القسم", value: "S.W.A.T. RULES", inline: true }
    ],
    footer: { text: footer },
    timestamp: sentAt
  }];

  const sections = [
    ["عنوان القانون", rule?.title],
    ["وصف القانون", rule?.description],
    ["نص القانون", rule?.body]
  ];
  for (const [label, value] of sections) {
    if (value === null || value === undefined || String(value).length === 0) continue;
    embeds.push(...sectionEmbeds(label, String(value), footer, sentAt));
  }

  if (embeds.length === 1) {
    embeds[0].fields.push({
      name: "المحتوى",
      value: "لم تتم إضافة عنوان أو وصف أو نص لهذا القانون بعد.",
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
