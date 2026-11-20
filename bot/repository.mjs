function responseError(response, operation) {
  return Object.assign(new Error(`${operation} failed with status ${response.status}.`), {
    status: response.status,
    operation
  });
}

export class AttentionAlertRepository {
  constructor({ baseUrl, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.serviceRoleKey = String(serviceRoleKey || "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}, operation = "Attention alert database request") {
    const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/${path}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(this.timeoutMs),
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw responseError(response, operation);
    return response.status === 204 ? [] : response.json();
  }

  async createActive(alert) {
    const rows = await this.request("attention_alerts?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(alert)
    }, "Create attention alert");
    if (!Array.isArray(rows) || !rows[0]) throw new Error("Create attention alert returned no row.");
    return rows[0];
  }

  async getLatestForUser(guildId, userId) {
    const query = new URLSearchParams({
      guild_id: `eq.${guildId}`,
      discord_user_id: `eq.${userId}`,
      select: "id,status,started_at",
      order: "started_at.desc",
      limit: "1"
    });
    const rows = await this.request(`attention_alerts?${query}`, {}, "Read recent attention alert");
    return rows[0] || null;
  }

  async listActive(guildId) {
    const query = new URLSearchParams({
      guild_id: `eq.${guildId}`,
      status: "eq.active",
      select: "id,discord_user_id,alert_channel_id,original_channel_id",
      limit: "500"
    });
    return this.request(`attention_alerts?${query}`, {}, "List active attention alerts");
  }

  async listStopRequests(guildId) {
    const query = new URLSearchParams({
      guild_id: `eq.${guildId}`,
      status: "eq.active",
      stop_requested_at: "not.is.null",
      select: "id,stop_requested_by_discord_id,stop_requested_by_name",
      limit: "500"
    });
    return this.request(`attention_alerts?${query}`, {}, "List attention alert stop requests");
  }

  async finish(id, values) {
    const query = new URLSearchParams({ id: `eq.${id}`, status: "eq.active" });
    const rows = await this.request(`attention_alerts?${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(values)
    }, "Finish attention alert");
    return rows[0] || null;
  }

  async interruptAll(guildId, endedAt) {
    const query = new URLSearchParams({ guild_id: `eq.${guildId}`, status: "eq.active" });
    return this.request(`attention_alerts?${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "interrupted", end_reason: "bot_restarted", ended_at: endedAt })
    }, "Mark stale attention alerts interrupted");
  }

  async getActiveStaffProfile(userId) {
    if (!/^\d{15,22}$/.test(String(userId || ""))) return null;
    const query = new URLSearchParams({
      discord_user_id: "eq." + String(userId),
      is_active: "eq.true",
      is_banned: "eq.false",
      select: "discord_user_id,display_name,username,avatar_url,discord_roles",
      limit: "1"
    });
    const rows = await this.request("staff_profiles?" + query, {}, "Read active staff profile for leave request");
    return rows[0] || null;
  }

  async findPendingLeaveRequest(userId) {
    const query = new URLSearchParams({
      discord_user_id: "eq." + String(userId),
      status: "eq.pending",
      select: "id,created_at",
      order: "created_at.desc",
      limit: "1"
    });
    const rows = await this.request("attendance_leave_requests?" + query, {}, "Check pending leave request");
    return rows[0] || null;
  }

  async findLeaveRequestByInteraction(interactionId) {
    const query = new URLSearchParams({
      discord_interaction_id: "eq." + String(interactionId),
      select: "id,status",
      limit: "1"
    });
    const rows = await this.request("attendance_leave_requests?" + query, {}, "Check duplicate leave modal submission");
    return rows[0] || null;
  }

  async createLeaveRequest(record) {
    const rows = await this.request("attendance_leave_requests?select=id,status,discord_user_id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(record)
    }, "Create Discord leave request");
    if (!Array.isArray(rows) || !rows[0]) throw new Error("Create leave request returned no row.");
    return rows[0];
  }

  async recordAttendanceVoiceJoinEvent(userId, channelId, joinedAt = new Date()) {
    const stamp = joinedAt instanceof Date ? joinedAt : new Date(joinedAt);
    if (!/^\d{15,22}$/.test(String(userId || "")) ||
        !/^\d{15,22}$/.test(String(channelId || "")) ||
        !Number.isFinite(stamp.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(stamp);
    const get = type => parts.find(part => part.type === type)?.value || "";
    const attendanceDate = get("year") + "-" + get("month") + "-" + get("day");
    const eventKey = String(userId) + ":" + String(channelId) + ":" + stamp.getTime();
    const rows = await this.request("rpc/record_swat_attendance_voice_join", {
      method: "POST",
      body: JSON.stringify({
        p_event_key: eventKey,
        p_discord_user_id: String(userId),
        p_attendance_date: attendanceDate,
        p_voice_channel_id: String(channelId),
        p_joined_at: stamp.toISOString()
      })
    }, "Record post-stamp voice join event");
    return rows && typeof rows === "object" ? rows : null;
  }


  async leaseRpc(name, instanceId) {
    return this.request(`rpc/${name}`, {
      method: "POST",
      body: JSON.stringify({ p_instance_id: instanceId })
    }, name);
  }

  async claimWorker(instanceId) {
    return Boolean(await this.leaseRpc("claim_attention_alert_worker", instanceId));
  }

  async renewWorker(instanceId) {
    return Boolean(await this.leaseRpc("renew_attention_alert_worker", instanceId));
  }

  async releaseWorker(instanceId) {
    return Boolean(await this.leaseRpc("release_attention_alert_worker", instanceId));
  }
}
