import { renderWelcomeImage } from "./welcome-image.mjs";

const SNOWFLAKE = /^\d{15,22}$/;

function safeText(value, max = 1800) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/@everyone/gi, "@ everyone")
    .replace(/@here/gi, "@ here")
    .trim()
    .slice(0, max);
}

function templateValue(template, member, isWelcome) {
  const user = member?.user || {};
  const name = String(member?.displayName || user.globalName || user.username || "عضو");
  const username = String(user.username || name);
  const guildName = String(member?.guild?.name || "S.W.A.T. REDLINE");
  const userToken = isWelcome ? "<@" + String(user.id || member?.id || "") + ">" : name;
  return safeText(template)
    .replace(/\{\{user\}\}/g, userToken)
    .replace(/\{\{username\}\}/g, username)
    .replace(/\{\{server\}\}/g, guildName)
    .replace(/\{\{memberCount\}\}/g, String(member?.guild?.memberCount || "غير متاح"));
}

export function createWelcomeAutomation({
  client,
  guildId,
  getSettings = () => ({}),
  logger = console,
  renderImage = renderWelcomeImage
} = {}) {
  async function send(member, mode) {
    const current = typeof getSettings === "function" ? getSettings() : getSettings;
    const welcome = current && typeof current === "object" ? current : {};
    const isWelcome = mode === "welcome";
    const enabled = isWelcome ? welcome.enabled === true : welcome.goodbyeEnabled === true;
    if (!enabled) return false;
    const channelId = String(isWelcome ? welcome.channelId || "" : welcome.goodbyeChannelId || "");
    const messageTemplate = isWelcome ? welcome.message : welcome.goodbyeMessage;
    const userId = String(member?.user?.id || member?.id || "");
    if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(userId)) return false;
    if (String(member?.guild?.id || member?.guildId || "") !== String(guildId || "")) return false;

    try {
      const channel = await client.channels.fetch(channelId);
      const actualGuildId = String(channel?.guildId || channel?.guild?.id || "");
      if (!channel || actualGuildId !== String(guildId) || !channel.isTextBased?.() || typeof channel.send !== "function") {
        throw new Error("welcome_channel_unavailable");
      }

      let image = null;
      const embeds = [];
      if (isWelcome && welcome.image && welcome.image.enabled !== false) {
        const user = member?.user || {};
        let avatarUrl = "";
        try { avatarUrl = member.displayAvatarURL?.({ extension: "png", size: 512 }) || ""; } catch {}
        image = await renderImage(welcome.image || {}, {
          id: userId,
          username: String(user.username || member?.displayName || "New member"),
          displayName: String(member?.displayName || user.globalName || user.username || "New member"),
          serverName: String(member?.guild?.name || "S.W.A.T. REDLINE"),
          memberCount: Number(member?.guild?.memberCount || 0),
          avatarUrl
        });
      } else if (isWelcome && !welcome.image && /^https:\/\/[^\s]+$/i.test(String(welcome.imageUrl || ""))) {
        // Preserve compatibility with older saved settings until the new editor is saved.
        embeds.push({ image: { url: String(welcome.imageUrl) } });
      }

      const permissions = channel.permissionsFor?.(client.user);
      if (permissions) {
        const required = ["ViewChannel", "SendMessages"];
        if (image) required.push("AttachFiles");
        if (embeds.length) required.push("EmbedLinks");
        if (!permissions.has(required)) throw new Error("welcome_channel_permissions_missing");
      }

      const rendered = templateValue(messageTemplate, member, isWelcome);
      const content = isWelcome
        ? [`<@${userId}>`, rendered.replace(new RegExp("<@!?" + userId + ">", "g"), " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()].filter(Boolean).join("\n")
        : rendered;
      if (!content && !image && !embeds.length) return false;

      const allowedMentions = isWelcome
        ? { parse: [], users: [userId], roles: [], repliedUser: false }
        : { parse: [], users: [], roles: [], repliedUser: false };
      await channel.send({
        ...(content ? { content } : {}),
        ...(image ? { files: [{ attachment: image, name: "welcome.png" }] } : {}),
        ...(embeds.length ? { embeds } : {}),
        allowedMentions
      });
      return true;
    } catch (error) {
      const method = logger?.warn || logger?.log;
      method?.call(logger, "discord_welcome_automation_send_failed", {
        mode,
        reason: error?.message || "unknown",
        channelId
      });
      return false;
    }
  }

  return Object.freeze({
    memberJoined: member => send(member, "welcome"),
    memberLeft: member => send(member, "goodbye")
  });
}