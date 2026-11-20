import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes
} from "discord.js";
import { AttentionAlertError, AttentionAlertManager } from "./attention-alerts.mjs";
import { readConfig } from "./config.mjs";
import { AttentionAlertRepository } from "./repository.mjs";
import { buildDiscordLeaveRequestRecord, LeaveRequestValidationError, validateLeaveRequestFields } from "./leave-requests.mjs";

const COMMAND_NAME = "S.W.A.T. Attention Alert";
const LEAVE_PANEL_BUTTON_ID = "swat_leave_request_open";
const LEAVE_MODAL_ID = "swat_leave_request_submit";
const config = readConfig();
const repository = new AttentionAlertRepository({
  baseUrl: config.supabaseUrl,
  serviceRoleKey: config.supabaseServiceRoleKey
});
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let leaseHealthy = false;
let manager;
let swatRoleIds = new Set();
let stopPollTimer = null;
let leaseRenewTimer = null;
let stopping = false;
let leaseRenewBusy = false;
const instanceId = randomUUID();

function safeLog(level, event, values = {}) {
  const details = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    !/token|secret|password|key/i.test(key) && value !== undefined
  ));
  const method = console[level] || console.log;
  method(event, details);
}

function roleIds(interaction) {
  const roles = interaction.member?.roles;
  if (Array.isArray(roles)) return roles.map(String);
  if (roles?.cache) return [...roles.cache.keys()].map(String);
  return [];
}

async function registerContextCommand(applicationId) {
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.post(Routes.applicationGuildCommands(applicationId, config.guildId), {
    body: {
      name: COMMAND_NAME,
      type: ApplicationCommandType.User,
      default_member_permissions: PermissionFlagsBits.MoveMembers.toString()
    }
  });
}


function isSwatRoleName(name) {
  const normalized = String(name || "");
  return /s\\s*\\.?\\s*w\\s*\\.?\\s*a\\s*\\.?\\s*t/i.test(normalized) &&
    !/(warning|website|admin|manager|bot)/i.test(normalized);
}

async function loadSwatRoleIds(guild) {
  const roles = await guild.roles.fetch();
  return new Set([...roles.values()].filter(role => isSwatRoleName(role.name)).map(role => String(role.id)));
}

function hasCurrentSwatRole(interaction, profile) {
  const current = new Set(roleIds(interaction));
  if (swatRoleIds.size) return [...swatRoleIds].some(id => current.has(id));
  const saved = Array.isArray(profile?.discord_roles) ? profile.discord_roles.map(String) : [];
  return saved.some(id => current.has(id));
}

function buildLeaveRequestModal() {
  const militaryName = new TextInputBuilder()
    .setCustomId("military_name")
    .setLabel("اسمك العسكري داخل المدينة")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(100)
    .setPlaceholder("مثال: Alpha 17")
    .setRequired(true);
  const reason = new TextInputBuilder()
    .setCustomId("leave_reason")
    .setLabel("سبب طلبك للإجازة")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setPlaceholder("اكتب سبب الإجازة بالتفصيل...")
    .setRequired(true);
  const duration = new TextInputBuilder()
    .setCustomId("duration_days")
    .setLabel("مدة الإجازة (عدد الأيام)")
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(3)
    .setPlaceholder("مثال: 5")
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(LEAVE_MODAL_ID)
    .setTitle("طلب إجازة S.W.A.T")
    .addComponents(
      new ActionRowBuilder().addComponents(militaryName),
      new ActionRowBuilder().addComponents(reason),
      new ActionRowBuilder().addComponents(duration)
    );
}

async function ensureLeaveRequestPanel(guild) {
  const channel = await guild.channels.fetch(config.leaveRequestChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.() || !channel.messages || typeof channel.send !== "function") {
    throw new Error("leave_request_channel_unavailable");
  }
  const permissions = channel.permissionsFor(guild.members.me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages
  ];
  if (!permissions?.has(required)) throw new Error("leave_request_channel_permissions_missing");

  const recent = await channel.messages.fetch({ limit: 100 });
  const existing = recent.find(message =>
    message.author?.id === client.user.id &&
    message.components?.some(row => row.components?.some(component => component.customId === LEAVE_PANEL_BUTTON_ID))
  );
  if (existing) {
    safeLog("info", "leave_request_panel_ready", { guildId: guild.id, channelId: channel.id, messageId: existing.id });
    return existing;
  }

  const panel = await channel.send({
    content: [
      "**📋 طلب إجازة S.W.A.T**",
      "اضغط الزر الأخضر بالأسفل، واملأ البيانات الثلاثة. سيصل طلبك إلى الإدارة لمراجعته من الموقع.",
      "لن تُحتسب الإجازة إلا بعد اعتمادها من الإدارة."
    ].join("\\n"),
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(LEAVE_PANEL_BUTTON_ID)
          .setLabel("طلب إجازة")
          .setEmoji("🟢")
          .setStyle(ButtonStyle.Success)
      )
    ]
  });
  safeLog("info", "leave_request_panel_created", { guildId: guild.id, channelId: channel.id, messageId: panel.id });
  return panel;
}

async function handleLeaveRequestButton(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== config.guildId ||
      interaction.channelId !== config.leaveRequestChannelId) {
    await interaction.reply({ content: "زر طلب الإجازة متاح من روم الإجازات فقط.", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  try {
    await interaction.showModal(buildLeaveRequestModal());
  } catch (error) {
    safeLog("warn", "leave_request_modal_open_failed", { userId: interaction.user?.id || "", status: error?.status || null });
  }
}

async function handleLeaveRequestModal(interaction) {
  const deferred = await interaction.deferReply({ flags: MessageFlags.Ephemeral }).then(() => true).catch(() => false);
  if (!deferred) {
    safeLog("warn", "leave_request_modal_expired", { userId: interaction.user?.id || "" });
    return;
  }

  try {
    if (!interaction.inGuild() || interaction.guildId !== config.guildId ||
        interaction.channelId !== config.leaveRequestChannelId) {
      throw new LeaveRequestValidationError("أرسل طلب الإجازة من روم الإجازات المحددة في السيرفر.", "wrong_leave_channel");
    }

    const profile = await repository.getActiveStaffProfile(interaction.user.id);
    if (!profile) {
      throw new LeaveRequestValidationError("لا يوجد لك حساب S.W.A.T نشط في الموقع. راجع الإدارة لتفعيل حسابك.", "inactive_staff_profile");
    }
    if (!hasCurrentSwatRole(interaction, profile)) {
      throw new LeaveRequestValidationError("يجب أن تحمل رتبة S.W.A.T الحالية في Discord لتقديم طلب إجازة.", "missing_swat_role");
    }

    const values = validateLeaveRequestFields({
      militaryName: interaction.fields.getTextInputValue("military_name"),
      reason: interaction.fields.getTextInputValue("leave_reason"),
      durationDays: interaction.fields.getTextInputValue("duration_days")
    });
    const pending = await repository.findPendingLeaveRequest(interaction.user.id);
    if (pending) {
      await interaction.editReply("لديك بالفعل طلب إجازة قيد المراجعة. تابع حالته من صفحة الإجازات في الموقع.");
      return;
    }

    const record = buildDiscordLeaveRequestRecord({
      interactionId: interaction.id,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      profile,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 256 }),
      militaryName: values.militaryName,
      reason: values.reason,
      durationDays: values.durationDays
    });
    const created = await repository.createLeaveRequest(record);
    await interaction.editReply("✅ تم استلام طلب الإجازة وإرساله إلى الإدارة. يمكنك متابعة القرار من صفحة **الإجازات** في الموقع.");
    safeLog("info", "leave_request_submitted", {
      requestId: created.id,
      userId: interaction.user.id,
      durationDays: values.durationDays,
      channelId: interaction.channelId
    });
  } catch (error) {
    const message = error instanceof LeaveRequestValidationError
      ? error.message
      : "تعذر تسجيل طلب الإجازة حاليًا. حاول مرة أخرى بعد قليل أو راجع الإدارة.";
    await interaction.editReply(message).catch(() => {});
    if (!(error instanceof LeaveRequestValidationError)) {
      safeLog("error", "leave_request_submission_failed", {
        userId: interaction.user?.id || "",
        status: error?.status || null,
        operation: error?.operation || null
      });
    }
  }
}

function replyText(error) {
  if (error instanceof AttentionAlertError) return error.message;
  if (error?.status === 409 || error?.code === "already_active") return "يوجد تنبيه نشط لهذا العضو بالفعل.";
  return "تعذر بدء تنبيه الانتباه. تحقق من اتصال البوت والصلاحيات ثم حاول مجددًا.";
}

function startLeaseRenewal() {
  if (leaseRenewTimer) return;
  leaseRenewTimer = setInterval(async () => {
    if (leaseRenewBusy || stopping) return;
    leaseRenewBusy = true;
    try {
      const renewed = await repository.renewWorker(instanceId);
      if (!renewed) throw new Error("worker_lease_lost");
    } catch (error) {
      leaseHealthy = false;
      process.exitCode = 1;
      safeLog("error", "attention_alert_worker_lease_lost", { status: error?.status || null });
      await shutdown("lease_lost");
    } finally {
      leaseRenewBusy = false;
    }
  }, 3_000);
  leaseRenewTimer.unref?.();
}

client.once(Events.ClientReady, async readyClient => {
  try {
    const claimed = await repository.claimWorker(instanceId);
    if (!claimed) {
      safeLog("error", "attention_alert_worker_lease_unavailable", { guildId: config.guildId });
      client.destroy();
      process.exitCode = 1;
      return;
    }
    leaseHealthy = true;
    startLeaseRenewal();
    manager = new AttentionAlertManager({
      client,
      repository,
      config,
      leaseGuard: () => leaseHealthy
    });

    await manager.interruptStaleAlerts();
    if (!leaseHealthy || stopping) throw new Error("worker_lease_lost_during_startup");
    const guild = await readyClient.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) throw new Error("bot_not_in_configured_guild");
    if (!leaseHealthy || stopping) throw new Error("worker_lease_lost_during_startup");
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) throw new Error("bot_member_lookup_failed");
    if (!leaseHealthy || stopping) throw new Error("worker_lease_lost_during_startup");
    try {
      swatRoleIds = await loadSwatRoleIds(guild);
      await ensureLeaveRequestPanel(guild);
    } catch (leavePanelError) {
      safeLog("warn", "leave_request_panel_startup_failed", {
        guildId: guild.id,
        channelId: config.leaveRequestChannelId,
        status: leavePanelError?.status || null,
        message: leavePanelError?.message || "unknown"
      });
    }
    if (!leaseHealthy || stopping) throw new Error("worker_lease_lost_during_startup");
    await registerContextCommand(readyClient.application.id);
    if (!leaseHealthy || stopping) throw new Error("worker_lease_lost_during_startup");
    stopPollTimer = setInterval(() => { void manager.pollStopRequests(); }, config.stopPollMs);
    stopPollTimer.unref?.();
    safeLog("info", "attention_alert_worker_ready", { guildId: config.guildId, botId: readyClient.user.id });
  } catch (error) {
    safeLog("error", "attention_alert_worker_start_failed", { status: error?.status || null, message: error?.message || "unknown" });
    await shutdown("startup_failed");
    process.exitCode = 1;
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton() && interaction.customId === LEAVE_PANEL_BUTTON_ID) {
    await handleLeaveRequestButton(interaction);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === LEAVE_MODAL_ID) {
    await handleLeaveRequestModal(interaction);
    return;
  }
  if (!interaction.isUserContextMenuCommand() || interaction.commandName !== COMMAND_NAME) return;
  if (!interaction.deferred && !interaction.replied) {
    const deferred = await interaction.deferReply({ flags: MessageFlags.Ephemeral }).then(() => true).catch(() => false);
    if (!deferred) {
      safeLog("warn", "attention_alert_interaction_expired", { moderatorId: interaction.user?.id || "" });
      return;
    }
  }

  try {
    if (!leaseHealthy || !manager) throw new AttentionAlertError("عامل التنبيه غير جاهز حاليًا. حاول بعد قليل.", "worker_unavailable");
    if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
      throw new AttentionAlertError("هذا الأمر متاح في سيرفر S.W.A.T. REDLINE فقط.");
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)) {
      throw new AttentionAlertError("تحتاج إلى صلاحية Move Members لاستخدام التنبيه.");
    }
    const guild = interaction.guild;
    const target = await guild.members.fetch(interaction.targetId).catch(() => null);
    if (!target) throw new AttentionAlertError("تعذر العثور على العضو في السيرفر.");

    const started = await manager.start({
      guild,
      member: target,
      moderator: interaction.user,
      moderatorRoleIds: roleIds(interaction),
      moderatorIsAdministrator: interaction.memberPermissions.has(PermissionFlagsBits.Administrator),
      moderatorCanMoveMembers: interaction.memberPermissions.has(PermissionFlagsBits.MoveMembers)
    });
    const targetName = String(target.displayName || target.user.username || "Discord user").replace(/[\r\n]/g, " ").slice(0, 80);
    await interaction.editReply({
      content: `بدأ S.W.A.T. Attention Alert للعضو ${targetName}. أوقفه من لوحة الموقع عند الحاجة.`,
      allowedMentions: { parse: [] }
    });
    safeLog("info", "attention_alert_command_accepted", { alertId: started.id, guildId: guild.id, targetId: target.id, moderatorId: interaction.user.id });
  } catch (error) {
    await interaction.editReply({ content: replyText(error) }).catch(() => {});
    if (!(error instanceof AttentionAlertError)) {
      safeLog("error", "attention_alert_command_rejected", { guildId: interaction.guildId || "", moderatorId: interaction.user?.id || "", status: error?.status || null });
    }
  }
});

client.on(Events.Error, error => safeLog("error", "discord_gateway_error", { message: error?.message || "unknown" }));
client.on(Events.Warn, message => safeLog("warn", "discord_gateway_warning", { message }));

async function shutdown(reason = "bot_shutdown") {
  if (stopping) return;
  stopping = true;
  clearInterval(stopPollTimer);
  clearInterval(leaseRenewTimer);
  if (manager) await manager.stopAll(reason);
  if (leaseHealthy) {
    await repository.releaseWorker(instanceId).catch(error => {
      safeLog("error", "attention_alert_worker_lease_release_failed", { status: error?.status || null });
    });
  }
  leaseHealthy = false;
  client.destroy();
}

process.once("SIGINT", () => { void shutdown("bot_shutdown"); });
process.once("SIGTERM", () => { void shutdown("bot_shutdown"); });

client.login(config.token).catch(error => {
  safeLog("error", "discord_gateway_login_failed", { message: error?.message || "unknown", status: error?.status || null });
  process.exitCode = 1;
  client.destroy();
});
