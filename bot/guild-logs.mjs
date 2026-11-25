const DEFAULT_COLOR = 0xed2635;
const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 3900;

function text(value, limit = MAX_FIELD_VALUE) {
  const normalized = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/@everyone/gi, "@ everyone")
    .replace(/@here/gi, "@ here")
    .trim();
  if (!normalized) return "غير متاح";
  return normalized.length > limit ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function displayUser(userOrMember) {
  const user = userOrMember?.user || userOrMember;
  if (!user) return "عضو غير معروف";
  const name = user.tag || user.globalName || user.username || user.displayName || "Discord user";
  return user.id ? text(name, 80) + " (<@" + user.id + ">) · " + user.id : text(name, 100);
}

function displayChannel(channelOrState, fallbackId = "") {
  const channel = channelOrState?.channel || channelOrState;
  const id = String(channel?.id || fallbackId || "");
  const name = channel?.name ? "#" + text(channel.name, 80) : "قناة غير معروفة";
  return id ? name + " (<#" + id + ">)" : name;
}

function makeEmbed({ title, description, color = DEFAULT_COLOR, fields = [], timestamp }) {
  const safeFields = fields.filter(field => field && field.name).slice(0, 25).map(field => ({
    name: text(field.name, 256),
    value: text(field.value, MAX_FIELD_VALUE),
    inline: Boolean(field.inline)
  }));
  const embed = {
    color,
    title: text(title, 256),
    timestamp: new Date(timestamp ?? Date.now()).toISOString(),
    footer: { text: "S.W.A.T. REDLINE • SERVER LOGS" }
  };
  if (description) embed.description = text(description, MAX_DESCRIPTION);
  if (safeFields.length) embed.fields = safeFields;
  return embed;
}

export function createGuildLogService({
  client,
  guildId,
  channelId,
  enabled = () => true,
  logger = console,
  now = () => Date.now()
} = {}) {
  const targetGuildId = String(guildId || "");
  const targetChannelId = String(channelId || "");

  async function resolveChannel() {
    if (!targetChannelId) throw new Error("discord_log_channel_id_missing");
    if (typeof client?.channels?.fetch !== "function") throw new Error("discord_channel_manager_unavailable");
    const channel = await client.channels.fetch(targetChannelId);
    const actualGuildId = String(channel?.guildId || channel?.guild?.id || "");
    if (!channel || actualGuildId !== targetGuildId) throw new Error("discord_log_channel_wrong_guild");
    if (typeof channel.send !== "function" || !channel.isTextBased?.()) throw new Error("discord_log_channel_not_text_based");
    const permissions = channel.permissionsFor?.(client.user);
    if (permissions && !permissions.has(["ViewChannel", "SendMessages", "EmbedLinks"])) {
      throw new Error("discord_log_channel_permissions_missing");
    }
    return channel;
  }

  async function verify() {
    if (!targetChannelId) return { ok: false, reason: "channel_id_missing" };
    try {
      const channel = await resolveChannel();
      return { ok: true, channelId: String(channel.id), guildId: targetGuildId };
    } catch (error) {
      return { ok: false, reason: error?.message || "channel_unavailable" };
    }
  }

  async function send({ title, description, fields = [], color = DEFAULT_COLOR } = {}) {
    if (!targetChannelId || !enabled()) return false;
    try {
      const channel = await resolveChannel();
      const embed = makeEmbed({ title, description, fields, color, timestamp: now() });
      await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
      });
      return true;
    } catch (error) {
      const method = logger?.warn || logger?.log;
      method?.call(logger, "discord_guild_log_send_failed", {
        reason: error?.message || "unknown",
        channelId: targetChannelId,
        guildId: targetGuildId
      });
      return false;
    }
  }

  async function messageDeleted(message) {
    const messageGuildId = String(message?.guildId || message?.guild?.id || "");
    if (messageGuildId !== targetGuildId || message?.author?.bot) return false;
    const attachments = Array.from(message?.attachments?.values?.() || [])
      .map(item => item.name || item.url).filter(Boolean).slice(0, 5);
    return send({
      title: "🗑️ تم حذف رسالة",
      description: "تم حذف رسالة من السيرفر.",
      color: 0xe05252,
      fields: [
        { name: "صاحب الرسالة", value: displayUser(message?.author) },
        { name: "القناة", value: displayChannel(message?.channel, message?.channelId) },
        { name: "محتوى الرسالة", value: message?.content ? text(message.content, 950) : "لم يكن محتوى الرسالة متاحًا في ذاكرة البوت وقت الحذف." },
        ...(attachments.length ? [{ name: "المرفقات", value: attachments.join("\n") }] : []),
        { name: "معرّف الرسالة", value: String(message?.id || "غير متاح") }
      ]
    });
  }

  async function messageUpdated(oldMessage, newMessage) {
    const messageGuildId = String(newMessage?.guildId || newMessage?.guild?.id || oldMessage?.guildId || "");
    if (messageGuildId !== targetGuildId || newMessage?.author?.bot) return false;
    const before = String(oldMessage?.content || "");
    const after = String(newMessage?.content || "");
    if (before === after) return false;
    return send({
      title: "✏️ تم تعديل رسالة",
      description: "تم تعديل محتوى رسالة داخل السيرفر.",
      color: 0xe2a33b,
      fields: [
        { name: "صاحب الرسالة", value: displayUser(newMessage?.author || oldMessage?.author) },
        { name: "القناة", value: displayChannel(newMessage?.channel || oldMessage?.channel, newMessage?.channelId || oldMessage?.channelId) },
        { name: "قبل التعديل", value: before ? text(before, 900) : "المحتوى السابق غير متاح." },
        { name: "بعد التعديل", value: after ? text(after, 900) : "المحتوى الجديد غير متاح." },
        { name: "معرّف الرسالة", value: String(newMessage?.id || oldMessage?.id || "غير متاح") }
      ]
    });
  }

  async function messagesBulkDeleted(messages, channel) {
    const first = Array.from(messages?.values?.() || [])[0];
    const messageGuildId = String(channel?.guildId || channel?.guild?.id || first?.guildId || "");
    if (messageGuildId !== targetGuildId) return false;
    return send({
      title: "🧹 تم حذف مجموعة رسائل",
      description: "تم حذف مجموعة من الرسائل دفعة واحدة.",
      color: 0xe05252,
      fields: [
        { name: "القناة", value: displayChannel(channel, channel?.id) },
        { name: "عدد الرسائل", value: String(messages?.size ?? messages?.length ?? 0) }
      ]
    });
  }

  async function memberJoined(member) {
    if (String(member?.guild?.id || member?.guildId || "") !== targetGuildId) return false;
    const user = member.user;
    return send({
      title: "📥 عضو جديد انضم إلى السيرفر",
      description: displayUser(user) + " انضم إلى S.W.A.T. REDLINE.",
      color: 0x35b779,
      fields: [
        { name: "معرّف العضو", value: String(user?.id || member?.id || "غير متاح") },
        { name: "تاريخ إنشاء الحساب", value: user?.createdAt?.toISOString?.() || "غير متاح", inline: true },
        { name: "وقت الانضمام", value: member?.joinedAt?.toISOString?.() || new Date(now()).toISOString(), inline: true },
        { name: "نوع الحساب", value: user?.bot ? "Bot" : "عضو", inline: true }
      ]
    });
  }

  async function memberLeft(member) {
    if (String(member?.guild?.id || member?.guildId || "") !== targetGuildId) return false;
    const user = member.user;
    return send({
      title: "📤 عضو غادر السيرفر",
      description: displayUser(user) + " غادر S.W.A.T. REDLINE.",
      color: 0x8b929d,
      fields: [
        { name: "معرّف العضو", value: String(user?.id || member?.id || "غير متاح") },
        { name: "آخر اسم ظاهر", value: text(member?.displayName || user?.username || "غير متاح", 100) },
        { name: "نوع الحساب", value: user?.bot ? "Bot" : "عضو", inline: true }
      ]
    });
  }

  async function memberUpdated(oldMember, newMember) {
    if (String(newMember?.guild?.id || newMember?.guildId || "") !== targetGuildId) return false;
    const oldRoles = oldMember?.roles?.cache;
    const newRoles = newMember?.roles?.cache;
    const added = newRoles && oldRoles ? [...newRoles.values()].filter(role => !oldRoles.has(role.id)) : [];
    const removed = newRoles && oldRoles ? [...oldRoles.values()].filter(role => !newRoles.has(role.id)) : [];
    const oldNick = String(oldMember?.nickname || "");
    const newNick = String(newMember?.nickname || "");
    if (!added.length && !removed.length && oldNick === newNick) return false;

    const fields = [
      { name: "العضو", value: displayUser(newMember?.user || newMember) },
      { name: "معرّف العضو", value: String(newMember?.id || newMember?.user?.id || "غير متاح") }
    ];
    if (added.length) fields.push({ name: "رتب تمت إضافتها", value: added.map(role => "+ " + text(role.name, 80)).join("\n") });
    if (removed.length) fields.push({ name: "رتب تمت إزالتها", value: removed.map(role => "− " + text(role.name, 80)).join("\n") });
    if (oldNick !== newNick) {
      fields.push({ name: "الاسم السابق", value: oldNick || "بدون اسم مستعار" });
      fields.push({ name: "الاسم الجديد", value: newNick || "بدون اسم مستعار" });
    }
    return send({
      title: added.length || removed.length ? "🛡️ تم تحديث رتب عضو" : "✏️ تم تغيير اسم عضو",
      description: "تم رصد تغيير في بيانات أحد أعضاء السيرفر.",
      color: 0x4d86dc,
      fields
    });
  }

  async function roleCreated(role) {
    if (String(role?.guild?.id || "") !== targetGuildId) return false;
    return send({
      title: "➕ تم إنشاء رتبة",
      color: 0x35b779,
      fields: [
        { name: "الرتبة", value: text(role?.name || "غير معروف", 100) },
        { name: "معرّف الرتبة", value: String(role?.id || "غير متاح") }
      ]
    });
  }

  async function roleDeleted(role) {
    if (String(role?.guild?.id || "") !== targetGuildId) return false;
    return send({
      title: "➖ تم حذف رتبة",
      color: 0xe05252,
      fields: [
        { name: "اسم الرتبة", value: text(role?.name || "غير معروف", 100) },
        { name: "معرّف الرتبة", value: String(role?.id || "غير متاح") }
      ]
    });
  }

  async function roleUpdated(oldRole, newRole) {
    if (String(newRole?.guild?.id || "") !== targetGuildId) return false;
    const changes = [];
    if (oldRole?.name !== newRole?.name) changes.push({ name: "الاسم", value: text(oldRole?.name) + " ← " + text(newRole?.name) });
    if (oldRole?.color !== newRole?.color) changes.push({ name: "اللون", value: String(oldRole?.hexColor || oldRole?.color) + " ← " + String(newRole?.hexColor || newRole?.color) });
    if (oldRole?.hoist !== newRole?.hoist) changes.push({ name: "إظهار منفصل", value: (oldRole?.hoist ? "نعم" : "لا") + " ← " + (newRole?.hoist ? "نعم" : "لا") });
    if (oldRole?.mentionable !== newRole?.mentionable) changes.push({ name: "قابلية المنشن", value: (oldRole?.mentionable ? "نعم" : "لا") + " ← " + (newRole?.mentionable ? "نعم" : "لا") });
    if (oldRole?.position !== newRole?.position) changes.push({ name: "الموضع", value: String(oldRole?.position) + " ← " + String(newRole?.position) });
    if (!changes.length) return false;
    return send({
      title: "⚙️ تم تعديل رتبة",
      color: 0xe2a33b,
      fields: [
        { name: "الرتبة", value: text(newRole?.name || "غير معروف", 100) },
        { name: "معرّف الرتبة", value: String(newRole?.id || "غير متاح") },
        ...changes
      ]
    });
  }

  async function voiceStateUpdated(oldState, newState) {
    const eventGuildId = String(newState?.guild?.id || oldState?.guild?.id || "");
    if (eventGuildId !== targetGuildId || oldState?.channelId === newState?.channelId) return false;
    const user = newState?.member?.user || oldState?.member?.user;
    const oldChannel = oldState?.channel;
    const newChannel = newState?.channel;
    let title = "🔊 انتقال بين الرومات الصوتية";
    let description = "انتقل عضو بين قنوات الصوت.";
    let color = 0x4d86dc;
    if (!oldState?.channelId && newState?.channelId) {
      title = "🔊 دخل رومًا صوتيًا";
      description = "انضم عضو إلى قناة صوتية.";
      color = 0x35b779;
    } else if (oldState?.channelId && !newState?.channelId) {
      title = "🔇 غادر رومًا صوتيًا";
      description = "غادر عضو قناة صوتية.";
      color = 0x8b929d;
    }
    return send({
      title,
      description: displayUser(user) + " — " + description,
      color,
      fields: [
        { name: "العضو", value: displayUser(user) },
        { name: "من", value: displayChannel(oldChannel, oldState?.channelId) },
        { name: "إلى", value: displayChannel(newChannel, newState?.channelId) }
      ]
    });
  }

  async function auditLogEntry(entry, guild) {
    if (String(guild?.id || entry?.guild?.id || "") !== targetGuildId) return false;
    const actionLabels = new Map([
      [20, "طرد عضو"], [22, "حظر عضو"], [23, "إلغاء حظر عضو"], [25, "تغيير رتب عضو"],
      [72, "حذف رسالة"], [73, "حذف مجموعة رسائل"], [30, "إنشاء رتبة"], [31, "تعديل رتبة"], [32, "حذف رتبة"]
    ]);
    const label = actionLabels.get(Number(entry?.action));
    if (!label) return false;
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    const changeLines = changes.slice(0, 8).map(change => {
      const key = text(change.key || "تغيير", 80);
      const before = change.old_value === undefined ? "" : JSON.stringify(change.old_value);
      const after = change.new_value === undefined ? "" : JSON.stringify(change.new_value);
      return key + ": " + (before ? text(before, 180) : "—") + " ← " + (after ? text(after, 180) : "—");
    });
    const extra = entry?.extra;
    const extraText = extra?.channel?.name
      ? "#" + extra.channel.name + " (" + extra.channel.id + ")"
      : extra?.count !== undefined ? "عدد العناصر: " + extra.count : "";
    return send({
      title: "📋 سجل الإدارة: " + label,
      description: "تم تسجيل إجراء إداري في Discord Audit Log.",
      color: 0xb45bd3,
      fields: [
        { name: "منفذ الإجراء", value: displayUser(entry?.executor) },
        { name: "العضو أو العنصر المستهدف", value: entry?.target ? displayUser(entry.target) : String(entry?.targetId || "غير متاح") },
        ...(extraText ? [{ name: "تفاصيل إضافية", value: extraText }] : []),
        ...(entry?.reason ? [{ name: "السبب", value: text(entry.reason, 900) }] : []),
        ...(changeLines.length ? [{ name: "التغييرات", value: changeLines.join("\n") }] : [])
      ]
    });
  }

  return Object.freeze({
    verify,
    messageDeleted,
    messageUpdated,
    messagesBulkDeleted,
    memberJoined,
    memberLeft,
    memberUpdated,
    roleCreated,
    roleDeleted,
    roleUpdated,
    voiceStateUpdated,
    auditLogEntry
  });
}
