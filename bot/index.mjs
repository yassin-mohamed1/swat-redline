import { randomUUID } from "node:crypto";
import {
  ApplicationCommandType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes
} from "discord.js";
import { AttentionAlertError, AttentionAlertManager } from "./attention-alerts.mjs";
import { readConfig } from "./config.mjs";
import { AttentionAlertRepository } from "./repository.mjs";

const COMMAND_NAME = "S.W.A.T. Attention Alert";
const config = readConfig();
const repository = new AttentionAlertRepository({
  baseUrl: config.supabaseUrl,
  serviceRoleKey: config.supabaseServiceRoleKey
});
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let leaseHealthy = false;
let manager;
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
