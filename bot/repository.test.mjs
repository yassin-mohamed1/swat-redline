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
