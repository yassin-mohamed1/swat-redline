const ALLOWED_CHANNEL_TYPES = new Set([2]); // Discord GuildVoice channel type.
const REQUIRED_BOT_PERMISSIONS = ["ViewChannel", "Connect", "MoveMembers"];

export class AttentionAlertError extends Error {
  constructor(message, code = "attention_alert_rejected") {
    super(message);
    this.name = "AttentionAlertError";
    this.code = code;
  }
}

function channelPermissionSet(channel, botMember) {
  try {
    const permissions = channel?.permissionsFor?.(botMember);
    return Boolean(permissions?.has?.(REQUIRED_BOT_PERMISSIONS));
  } catch {
    return false;
  }
}

export function validateStartConditions({
  expectedGuildId,
  guildId,
  target,
  moderatorRoleIds,
  managerRoleId,
  moderatorIsAdministrator = false,
  moderatorCanMoveMembers,
  originalChannel,
  alertChannel,
  botMember
}) {
  if (!guildId || guildId !== expectedGuildId) return "هذا الأمر متاح في سيرفر S.W.A.T. REDLINE فقط.";
  if (!target || target.user?.bot) return "لا يمكن بدء تنبيه لهذا الحساب.";
  if (String(target.guild?.id || guildId) !== expectedGuildId) return "العضو ليس في السيرفر المحدد.";
  if (!target.voice?.channelId) return "العضو ليس في روم صوتي حاليًا.";
  if (target.voice.selfDeaf !== true) return "يجب أن يكون العضو قد فعّل Self Deafen قبل بدء التنبيه.";
  if (!moderatorCanMoveMembers) return "تحتاج إلى صلاحية Move Members لاستخدام التنبيه.";
  if (!moderatorIsAdministrator && (!managerRoleId || !moderatorRoleIds.includes(managerRoleId))) return "هذه الخاصية متاحة لمديري التحذيرات أو مسؤولي السيرفر فقط.";
  if (!alertChannel) return "روم التنبيه غير موجود. تحقق من DISCORD_ATTENTION_ALERT_CHANNEL_ID.";
  if (!originalChannel || !ALLOWED_CHANNEL_TYPES.has(originalChannel.type) || !ALLOWED_CHANNEL_TYPES.has(alertChannel.type)) {
    return "يجب أن يكون الروم الأصلي وروم التنبيه رومين صوتيين صالحين.";
  }
  if (String(originalChannel.guildId) !== expectedGuildId || String(alertChannel.guildId) !== expectedGuildId) {
    return "روم التنبيه يجب أن يكون ضمن سيرفر S.W.A.T. REDLINE.";
  }
  if (originalChannel.id === alertChannel.id) return "روم التنبيه يجب أن يختلف عن الروم الأصلي.";
  if (!botMember || !channelPermissionSet(originalChannel, botMember) || !channelPermissionSet(alertChannel, botMember)) {
    return "يفتقد البوت إحدى صلاحيات View Channel أو Connect أو Move Members في الرومين.";
  }
  return null;
}

function sleep(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function actorName(actor) {
  return String(actor?.displayName || actor?.globalName || actor?.username || actor?.user?.username || "Discord user").slice(0, 120);
}

function isSnowflake(value) {
  return /^\d{15,22}$/.test(String(value || ""));
}

export class AttentionAlertManager {
  constructor({ client, repository, config, logger = console, now = () => Date.now(), leaseGuard = () => true }) {
    this.client = client;
    this.repository = repository;
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.leaseGuard = leaseGuard;
    this.activeByUser = new Map();
    this.activeById = new Map();
    this.pollingStops = false;
    this.lastStopPollFailureAt = 0;
    this.client.on("voiceStateUpdate", (oldState, newState) => this.onVoiceStateUpdate(oldState, newState));
  }

  async getChannels(guild, member) {
    const currentId = member.voice?.channelId;
    const original = currentId ? await guild.channels.fetch(currentId).catch(() => null) : null;
    const alert = await guild.channels.fetch(this.config.alertChannelId).catch(() => null);
    return { original, alert };
  }

  async validate({ guild, member, moderator, moderatorRoleIds, moderatorIsAdministrator, moderatorCanMoveMembers }) {
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const { original, alert } = await this.getChannels(guild, member);
    const error = validateStartConditions({
      expectedGuildId: this.config.guildId,
      guildId: guild.id,
      target: member,
      moderatorRoleIds,
      managerRoleId: this.config.managerRoleId,
      moderatorIsAdministrator,
      moderatorCanMoveMembers,
      originalChannel: original,
      alertChannel: alert,
      botMember
    });
    if (error) throw new AttentionAlertError(error);
    return { botMember, original, alert };
  }

  async start({ guild, member, moderator, moderatorRoleIds, moderatorIsAdministrator, moderatorCanMoveMembers }) {
    if (!this.leaseGuard()) throw new AttentionAlertError("عامل التنبيه غير جاهز أو لا يملك قفل التشغيل.", "worker_unavailable");
    const userId = String(member?.id || member?.user?.id || "");
    if (!isSnowflake(userId)) throw new AttentionAlertError("تعذر تحديد معرّف العضو.");
    if (this.activeByUser.has(userId)) throw new AttentionAlertError("يوجد تنبيه نشط لهذا العضو بالفعل.", "already_active");
    const channels = await this.validate({ guild, member, moderator, moderatorRoleIds, moderatorIsAdministrator, moderatorCanMoveMembers });
    const previous = await this.repository.getLatestForUser(guild.id, userId);
    if (previous?.status === "active") throw new AttentionAlertError("يوجد تنبيه نشط لهذا العضو بالفعل.", "already_active");
    if (previous?.started_at && this.config.cooldownMs > 0) {
      const remaining = this.config.cooldownMs - (this.now() - Date.parse(previous.started_at));
      if (remaining > 0) {
        const seconds = Math.ceil(remaining / 1000);
        throw new AttentionAlertError(`انتظر ${seconds} ثانية قبل بدء تنبيه جديد لهذا العضو.`, "cooldown");
      }
    }

    const startedAt = new Date(this.now()).toISOString();
    let row;
    try {
      row = await this.repository.createActive({
        guild_id: guild.id,
        discord_user_id: userId,
        member_name: actorName(member),
        original_channel_id: channels.original.id,
        original_channel_name: String(channels.original.name || "Voice Channel").slice(0, 100),
        alert_channel_id: channels.alert.id,
        alert_channel_name: String(channels.alert.name || "Attention Alert").slice(0, 100),
        started_by_discord_id: String(moderator?.id || moderator?.user?.id || ""),
        started_by_name: actorName(moderator),
        started_at: startedAt,
        status: "active"
      });
    } catch (error) {
      if (error?.status === 409) throw new AttentionAlertError("يوجد تنبيه نشط لهذا العضو بالفعل.", "already_active");
      throw new AttentionAlertError("تعذر حفظ التنبيه في قاعدة البيانات؛ لم يبدأ النقل.", "storage_error");
    }

    const entry = {
      id: row.id,
      guild,
      member,
      moderator,
      originalChannelId: channels.original.id,
      alertChannelId: channels.alert.id,
      originalChannelName: channels.original.name,
      alertChannelName: channels.alert.name,
      currentChannelId: member.voice.channelId,
      expectedChannelId: null,
      pendingMove: null,
      movedToAlertByBot: false,
      safeToRestore: true,
      stopReason: null,
      controller: new AbortController(),
      startedAtMs: this.now(),
      finishing: false,
      completion: null,
      readySettled: false
    };
    entry.ready = new Promise((resolve, reject) => { entry.resolveReady = resolve; entry.rejectReady = reject; });
    entry.ready.catch(() => {});
    this.activeByUser.set(userId, entry);
    this.activeById.set(String(row.id), entry);
    entry.completion = this.run(entry);
    this.logger.info?.("attention_alert_started", { alertId: row.id, userId, guildId: guild.id, moderatorId: entry.moderator?.id || entry.moderator?.user?.id || "" });
    try {
      await entry.ready;
    } catch (error) {
      await entry.completion;
      throw error instanceof AttentionAlertError ? error : new AttentionAlertError("تعذر بدء دورة النقل الأولى بأمان.", "start_failed");
    }
    return { id: row.id, completion: entry.completion };
  }

  requestStop(entry, reason, { safeToRestore = true } = {}) {
    if (!entry || entry.finishing) return;
    if (!entry.stopReason) entry.stopReason = reason;
    if (reason === "lease_lost") safeToRestore = false;
    if (!safeToRestore) entry.safeToRestore = false;
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);
  }

  onVoiceStateUpdate(oldState, newState) {
    const userId = String(newState?.id || newState?.member?.id || "");
    const entry = this.activeByUser.get(userId);
    if (!entry) return;
    const oldChannelId = oldState?.channelId || null;
    const newChannelId = newState?.channelId || null;

    if (oldState?.selfDeaf === true && newState?.selfDeaf === false) {
      this.requestStop(entry, "self_undeafened");
    }

    if (oldChannelId !== newChannelId) {
      entry.currentChannelId = newChannelId;
      if (entry.pendingMove && newChannelId === entry.pendingMove.channelId) {
        if (newChannelId === entry.alertChannelId) entry.movedToAlertByBot = true;
        if (newChannelId === entry.originalChannelId) entry.movedToAlertByBot = false;
        entry.pendingMove.resolve();
      } else {
        if (entry.pendingMove) {
          entry.pendingMove.reject(new AttentionAlertError("تغير روم العضو أثناء النقل.", "unexpected_voice_move"));
          entry.pendingMove = null;
        }
        if (newChannelId === null) {
          this.requestStop(entry, "left_voice", { safeToRestore: false });
        } else if (newChannelId !== entry.originalChannelId && newChannelId !== entry.alertChannelId) {
          this.requestStop(entry, "moved_elsewhere", { safeToRestore: false });
        } else {
          // A move between the two configured channels that did not match our
          // pending REST request is external, so do not pull the member back.
          this.requestStop(entry, "unexpected_voice_move", { safeToRestore: false });
        }
      }
    }
  }

  async verifyChannelPermissions(entry) {
    const original = await entry.guild.channels.fetch(entry.originalChannelId).catch(() => null);
    const alert = await entry.guild.channels.fetch(entry.alertChannelId).catch(() => null);
    if (!original || !alert) throw new AttentionAlertError("روم التنبيه أو الروم الأصلي لم يعد موجودًا.", "channel_missing");
    const botMember = entry.guild.members.me || await entry.guild.members.fetchMe().catch(() => null);
    if (!botMember || !channelPermissionSet(original, botMember) || !channelPermissionSet(alert, botMember)) {
      throw new AttentionAlertError("فقد البوت صلاحية View Channel أو Connect أو Move Members.", "permission_lost");
    }
    return { original, alert };
  }

  async move(entry, channelId) {
    if (!this.leaseGuard()) {
      this.requestStop(entry, "lease_lost", { safeToRestore: false });
      throw new AttentionAlertError("تعذر تأكيد ملكية عامل التنبيه؛ أُوقف النقل.", "lease_lost");
    }
    const expectedFrom = channelId === entry.alertChannelId ? entry.originalChannelId : entry.alertChannelId;
    if (entry.currentChannelId !== expectedFrom || entry.member.voice?.channelId !== expectedFrom) {
      throw new AttentionAlertError("تغير روم العضو؛ أوقف التنبيه لحماية مكانه الحالي.", "voice_channel_changed");
    }
    if (channelId === entry.alertChannelId && entry.member.voice?.selfDeaf !== true) {
      this.requestStop(entry, "self_undeafened");
      throw new AttentionAlertError("أوقف العضو Self Deafen؛ انتهى التنبيه.", "self_undeafened");
    }
    await this.verifyChannelPermissions(entry);

    let resolveMove, rejectMove;
    const observed = new Promise((resolve, reject) => { resolveMove = resolve; rejectMove = reject; });
    observed.catch(() => {});
    entry.pendingMove = { channelId, resolve: resolveMove, reject: rejectMove };
    entry.expectedChannelId = channelId;
    try {
      await entry.member.voice.setChannel(channelId, "S.W.A.T. Attention Alert");
      if (entry.currentChannelId !== channelId) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new AttentionAlertError("لم يصل تأكيد Discord لعملية النقل.", "move_timeout")), this.config.moveTimeoutMs);
          observed.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
        });
      }
      if (entry.currentChannelId !== channelId || entry.member.voice?.channelId !== channelId) {
        throw new AttentionAlertError("لم يتأكد انتقال العضو إلى الروم المطلوب.", "move_not_confirmed");
      }
      if (channelId === entry.alertChannelId) entry.movedToAlertByBot = true;
      else entry.movedToAlertByBot = false;
    } finally {
      if (entry.pendingMove?.channelId === channelId) entry.pendingMove = null;
      entry.expectedChannelId = null;
    }
  }

  async runCycle(entry) {
    try {
      await this.move(entry, entry.alertChannelId);
      if (!entry.controller.signal.aborted && this.config.dwellMs > 0) {
        await sleep(this.config.dwellMs, entry.controller.signal);
      }
    } finally {
      if (entry.movedToAlertByBot && entry.safeToRestore && entry.currentChannelId === entry.alertChannelId && entry.member.voice?.channelId === entry.alertChannelId) {
        await this.move(entry, entry.originalChannelId);
      }
    }
  }

  async run(entry) {
    let failure = null;
    try {
      await this.runCycle(entry);
      if (entry.controller.signal.aborted) {
        const reason = entry.stopReason;
        const message = reason === "self_undeafened"
          ? "أوقف العضو Self Deafen قبل اكتمال بدء التنبيه."
          : "توقف التنبيه قبل اكتمال أول دورة نقل.";
        entry.readySettled = true;
        entry.rejectReady(new AttentionAlertError(message, reason || "start_cancelled"));
      } else {
        entry.readySettled = true;
        entry.resolveReady();
      }
      while (!entry.controller.signal.aborted) {
        if (this.now() - entry.startedAtMs >= this.config.maxDurationMs) {
          this.requestStop(entry, "max_duration");
          break;
        }
        if (!await sleep(this.config.cycleMs, entry.controller.signal)) break;
        if (entry.controller.signal.aborted) break;
        if (entry.member.voice?.channelId !== entry.originalChannelId || entry.currentChannelId !== entry.originalChannelId) {
          this.requestStop(entry, "voice_channel_changed", { safeToRestore: false });
          break;
        }
        if (entry.member.voice?.selfDeaf !== true) {
          this.requestStop(entry, "self_undeafened");
          break;
        }
        await this.runCycle(entry);
      }
    } catch (error) {
      failure = error;
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(error);
      }
      if (!entry.stopReason) entry.stopReason = error?.code || "bot_error";
      this.requestStop(entry, entry.stopReason);
      this.logger.error?.("attention_alert_failed", { alertId: entry.id, userId: entry.member.id, reason: entry.stopReason, status: error?.status || null });
    } finally {
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(new AttentionAlertError("توقف التنبيه قبل اكتمال بدء التشغيل.", entry.stopReason || "start_cancelled"));
      }
      await this.finish(entry, failure);
    }
  }

  async finish(entry, failure) {
    if (entry.finishing) return;
    entry.finishing = true;
    if (entry.movedToAlertByBot && entry.safeToRestore && entry.currentChannelId === entry.alertChannelId && entry.member.voice?.channelId === entry.alertChannelId) {
      try {
        await this.move(entry, entry.originalChannelId);
      } catch (error) {
        failure ||= error;
        this.logger.error?.("attention_alert_restore_failed", { alertId: entry.id, userId: entry.member.id, status: error?.status || null });
      }
    }

    const reason = entry.stopReason || (failure ? "bot_error" : "stopped");
    const status = failure && !["self_undeafened", "left_voice", "moved_elsewhere", "voice_channel_changed", "max_duration", "manual_stop"].includes(reason)
      ? "failed"
      : "stopped";
    const endedAt = new Date(this.now()).toISOString();
    try {
      await this.repository.finish(entry.id, { status, end_reason: reason, ended_at: endedAt });
    } catch (error) {
      this.logger.error?.("attention_alert_status_write_failed", { alertId: entry.id, status: error?.status || null });
    }
    this.activeByUser.delete(String(entry.member.id));
    this.activeById.delete(String(entry.id));
    this.logger.info?.("attention_alert_ended", { alertId: entry.id, userId: entry.member.id, reason, status });
  }

  async pollStopRequests() {
    if (this.pollingStops) return;
    this.pollingStops = true;
    try {
      const requests = await this.repository.listStopRequests(this.config.guildId);
      for (const request of requests) {
        const entry = this.activeById.get(String(request.id));
        if (entry) this.requestStop(entry, "manual_stop");
      }
    } catch (error) {
      if (this.now() - this.lastStopPollFailureAt >= 30_000) {
        this.lastStopPollFailureAt = this.now();
        this.logger.error?.("attention_alert_stop_poll_failed", { status: error?.status || null });
      }
    } finally {
      this.pollingStops = false;
    }
  }

  async interruptStaleAlerts() {
    return this.repository.interruptAll(this.config.guildId, new Date(this.now()).toISOString());
  }

  async stopAll(reason = "bot_shutdown") {
    const entries = [...this.activeById.values()];
    for (const entry of entries) this.requestStop(entry, reason, { safeToRestore: reason !== "lease_lost" });
    await Promise.allSettled(entries.map(entry => entry.completion));
  }
}
