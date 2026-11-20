import test from "node:test";
import assert from "node:assert/strict";
import { AttentionAlertRepository } from "./repository.mjs";

test("uses the service role only for server-side attention alert data and worker lease RPCs", async () => {
  const calls = [];
  const repository = new AttentionAlertRepository({
    baseUrl: "https://database.test",
    serviceRoleKey: "test-only-service-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });

  assert.equal(await repository.claimWorker("a0ab6600-3bea-4b7a-8a51-11b416f32ef9"), true);
  assert.match(calls[0].url, /rpc\/claim_attention_alert_worker$/);
  assert.equal(calls[0].init.headers.apikey, "test-only-service-key");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-only-service-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_instance_id: "a0ab6600-3bea-4b7a-8a51-11b416f32ef9" });
});

test("reads an active staff profile and creates a durable Discord leave request", async () => {
  const calls = [];
  const repository = new AttentionAlertRepository({
    baseUrl: "https://database.test",
    serviceRoleKey: "test-only-service-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("staff_profiles?")) {
        return new Response(JSON.stringify([{ discord_user_id: "22345678901234567", is_active: true }]), { status: 200 });
      }
      if (String(url).includes("attendance_leave_requests?") && init.method === "POST") {
        return new Response(JSON.stringify([{ id: "leave-1", status: "pending" }]), { status: 201 });
      }
      return new Response("[]", { status: 200 });
    }
  });

  const profile = await repository.getActiveStaffProfile("22345678901234567");
  assert.equal(profile.is_active, true);
  assert.match(calls[0].url, /is_active=eq\.true/);
  assert.match(calls[0].url, /is_banned=eq\.false/);

  const record = {
    discord_user_id: "22345678901234567",
    military_name: "Alpha 17",
    reason: "ظروف عائلية",
    requested_duration_days: 7,
    status: "pending",
    source: "discord",
    discord_interaction_id: "12345678901234567"
  };
  const created = await repository.createLeaveRequest(record);
  assert.equal(created.id, "leave-1");
  assert.equal(calls[1].init.headers.apikey, "test-only-service-key");
  assert.equal(calls[1].init.headers.Authorization, "Bearer test-only-service-key");
  assert.deepEqual(JSON.parse(calls[1].init.body), record);
});

test("finds one existing pending leave request before allowing another submission", async () => {
  const repository = new AttentionAlertRepository({
    baseUrl: "https://database.test",
    serviceRoleKey: "test-only-service-key",
    fetchImpl: async () => new Response(JSON.stringify([{ id: "leave-pending" }]), { status: 200 })
  });
  const pending = await repository.findPendingLeaveRequest("22345678901234567");
  assert.equal(pending.id, "leave-pending");
});

test("claims admin notifications idempotently and completes delivery", async () => {
  const calls = [];
  const repository = new AttentionAlertRepository({
    baseUrl: "https://database.test",
    serviceRoleKey: "test-only-service-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ claimed: true, status: "processing" }), { status: 200 });
    }
  });
  const result = await repository.claimAdminAlert("leave-request:request-1", "leave_request", "22345678901234567", { request_id: "request-1" });
  assert.equal(result.claimed, true);
  assert.match(calls[0].url, /rpc\/claim_swat_admin_alert$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_event_key: "leave-request:request-1",
    p_alert_type: "leave_request",
    p_discord_user_id: "22345678901234567",
    p_payload: { request_id: "request-1" }
  });
  await repository.completeAdminAlert("leave-request:request-1", true);
  assert.match(calls[1].url, /rpc\/complete_swat_admin_alert$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    p_event_key: "leave-request:request-1",
    p_success: true,
    p_error_code: null
  });
});

test("confirms a voice join only for the current Riyadh day after the attendance stamp", async () => {
  const calls = [];
  const repository = new AttentionAlertRepository({
    baseUrl: "https://database.test",
    serviceRoleKey: "test-only-service-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify([{ attendance_date: "2026-11-20", voice_check_status: "confirmed" }]), { status: 200 });
    }
  });
  const rows = await repository.markAttendanceVoiceJoined("22345678901234567", new Date("2026-11-20T18:00:00.000Z"));
  assert.equal(rows[0].voice_check_status, "confirmed");
  assert.ok(calls[0].url.includes("attendance_records?"));
  assert.match(calls[0].url, /voice_check_status=eq.pending/);
  assert.match(calls[0].url, /voice_check_deadline_at=gt/);
  assert.match(calls[0].url, /first_seen_at=lte/);
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    voice_check_status: "confirmed",
    voice_joined_at: "2026-11-20T18:00:00.000Z"
  });
});

test("persists one-time administrator channel cleanup state", async () => {
  const calls = [];
  const repository = new AttentionAlertRepository({
    baseUrl: "https://database.test",
    serviceRoleKey: "test-only-service-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify([{ channel_id: "62345678901234567", history_cleared_at: "2026-11-20T00:00:00.000Z" }]), { status: 200 });
    }
  });
  const row = await repository.saveAdminChannelSetup("62345678901234567", {
    history_cleared_at: "2026-11-20T00:00:00.000Z",
    deleted_message_count: 12
  });
  assert.equal(row.channel_id, "62345678901234567");
  assert.ok(calls[0].url.includes("discord_admin_channel_setup?on_conflict=channel_id"));
  assert.match(calls[0].init.headers.Prefer, /resolution=merge-duplicates/);
});
