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
