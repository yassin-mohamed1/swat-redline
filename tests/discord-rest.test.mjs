import test from "node:test";
import assert from "node:assert/strict";
import { discordApiRequest } from "../lib/discord-rest.js";

function fakeResponse(status, body = "", headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return normalized.get(String(name).toLowerCase()) ?? null; } },
    async text() { return body; }
  };
}

test("retries Discord 429 using the JSON retry_after value", async () => {
  let calls = 0;
  const waits = [];
  const result = await discordApiRequest("test-token", "/guilds/123/roles", {}, {
    fetchImpl: async () => (++calls === 1
      ? fakeResponse(429, JSON.stringify({ message: "rate limited", retry_after: 0.25, global: false }))
      : fakeResponse(200, JSON.stringify([{ id: "role-1" }]))),
    sleep: async ms => waits.push(ms),
    maxRetries: 2,
    maxRetryWaitMs: 1000
  });
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 300);
  assert.deepEqual(result, [{ id: "role-1" }]);
});

test("uses the Retry-After header and does not retry before it expires", async () => {
  let calls = 0;
  const waits = [];
  const result = await discordApiRequest("test-token", "/users/@me", {}, {
    fetchImpl: async () => (++calls === 1
      ? fakeResponse(429, JSON.stringify({ retry_after: 0.1 }), { "Retry-After": "0.4" })
      : fakeResponse(200, JSON.stringify({ id: "bot-id" }))),
    sleep: async ms => waits.push(ms),
    maxRetries: 1,
    maxRetryWaitMs: 1000
  });
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 450);
  assert.deepEqual(result, { id: "bot-id" });
});

test("does not retry non-rate-limit Discord errors", async () => {
  let calls = 0;
  await assert.rejects(
    discordApiRequest("test-token", "/guilds/123/members/456", {}, {
      fetchImpl: async () => {
        calls += 1;
        return fakeResponse(403, JSON.stringify({ code: 50001, message: "Missing Access" }));
      },
      sleep: async () => assert.fail("403 must not sleep or retry")
    }),
    error => error.status === 403 && error.code === "50001"
  );
  assert.equal(calls, 1);
});

test("returns a 429 without waiting when Discord asks for a wait beyond the configured budget", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    discordApiRequest("test-token", "/guilds/123/roles", {}, {
      fetchImpl: async () => {
        calls += 1;
        return fakeResponse(429, JSON.stringify({ retry_after: 30, global: true }));
      },
      sleep: async ms => waits.push(ms),
      maxRetries: 3,
      maxRetryWaitMs: 1000
    }),
    error => error.status === 429 && error.retryAfterSeconds === 30
  );
  assert.equal(calls, 1);
  assert.equal(waits.length, 0);
});

test("serializes concurrent requests to the same Discord client instance", async () => {
  const order = [];
  let active = 0;
  let peak = 0;
  const fakeFetch = async (_url, init) => {
    active += 1;
    peak = Math.max(peak, active);
    order.push("start:" + init.method);
    await new Promise(resolve => setTimeout(resolve, 5));
    order.push("end:" + init.method);
    active -= 1;
    return fakeResponse(200, JSON.stringify({ ok: true }), { "X-RateLimit-Remaining": "4" });
  };
  await Promise.all([
    discordApiRequest("test-token", "/guilds/123/roles", { method: "GET" }, { fetchImpl: fakeFetch }),
    discordApiRequest("test-token", "/guilds/123/members/456", { method: "GET" }, { fetchImpl: fakeFetch })
  ]);
  assert.equal(peak, 1);
  assert.deepEqual(order.filter(value=>value.startsWith("start:")).length, 2);
});

test("does not set a JSON content type on multipart requests", async () => {
  let sentHeaders;
  const body = new FormData();
  body.append("payload_json", JSON.stringify({ content: "test" }));
  await discordApiRequest("test-token", "/channels/123/messages", { method: "POST", body }, {
    fetchImpl: async (_url, init) => {
      sentHeaders = init.headers;
      return fakeResponse(200, JSON.stringify({ id: "message-1" }));
    }
  });
  assert.equal(Object.hasOwn(sentHeaders, "Content-Type"), false);
});
