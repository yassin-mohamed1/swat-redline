import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import handler from "../api/warnings.js";

const ORIGINAL_ENV = { ...process.env };
const OWNER_ID = "12345678901234567";
const STAFF_ID = "22345678901234567";
const ROLE_ID = "32345678901234567";
const GUILD_ID = "42345678901234567";
const ALERT_UUID = "a0ab6600-3bea-4b7a-8a51-11b416f32ef9";

function setEnv(values) {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) process.env[key] = value;
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function cookieFor(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    username: user.username || "Supervisor",
    displayName: user.displayName || "Supervisor",
    roleId: user.roleId || ROLE_ID,
    issuedAt: Date.now()
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
  return `swat_session=${payload}.${signature}`;
}

function mockResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function invoke({ method = "GET", user = { id: OWNER_ID }, origin = "https://portal.test", body, fetchImpl }) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl || (async () => mockResponse([]));
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  const req = {
    method,
    url: "/api/warnings?attention_alerts=1",
    headers: {
      host: "portal.test",
      origin,
      "x-forwarded-proto": "https",
      cookie: user ? cookieFor(user) : ""
    },
    body
  };
  try {
    await handler(req, res);
    return res;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("lists only active records for the configured guild behind the owner session", async () => {
  setEnv({
    SESSION_SECRET: "test-session-secret",
    DISCORD_OWNER_ID: OWNER_ID,
    DISCORD_GUILD_ID: GUILD_ID,
    SUPABASE_URL: "https://database.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
  });
  let calledUrl = "";
  const result = await invoke({ fetchImpl: async url => {
    calledUrl = String(url);
    return mockResponse([{ id: ALERT_UUID, discord_user_id: STAFF_ID, status: "active" }]);
  }});
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.alerts.length, 1);
  assert.match(calledUrl, /attention_alerts\?/);
  assert.match(calledUrl, /status=eq\.active/);
  assert.match(calledUrl, new RegExp(`guild_id=eq\\.${GUILD_ID}`));
  assert.equal(result.headers["Cache-Control"], "no-store");
});

test("Stop Alert records the authenticated Website Admin and is same-origin protected", async () => {
  const websiteAdminRoleId = "52345678901234567";
  setEnv({
    SESSION_SECRET: "test-session-secret",
    DISCORD_OWNER_ID: OWNER_ID,
    DISCORD_ROLE_ID: ROLE_ID,
    DISCORD_WEBSITE_ADMIN_ROLE_ID: websiteAdminRoleId,
    DISCORD_BOT_TOKEN: "test-bot-token",
    DISCORD_GUILD_ID: GUILD_ID,
    SUPABASE_URL: "https://database.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
  });
  let patchRequest = null;
  const result = await invoke({ method: "POST", user: { id: STAFF_ID }, body: { action: "stop", alert_id: ALERT_UUID }, fetchImpl: async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/rest/v1/staff_profiles?")) return mockResponse([{ is_active: true, is_banned: false }]);
    if (value.includes(`/guilds/${GUILD_ID}/members/${STAFF_ID}`)) return mockResponse({ roles: [websiteAdminRoleId] });
    patchRequest = { url: value, init };
    return mockResponse([{ id: ALERT_UUID, discord_user_id: STAFF_ID, stop_requested_at: "2026-11-19T10:00:00Z" }]);
  }});
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.stop_requested, true);
  assert.equal(patchRequest.init.method, "PATCH");
  assert.match(patchRequest.url, /stop_requested_at=is\.null/);
  const update = JSON.parse(patchRequest.init.body);
  assert.equal(update.stop_requested_by_discord_id, STAFF_ID);
  assert.ok(update.stop_requested_at);

  let called = false;
  const blocked = await invoke({ method: "POST", body: { action: "stop", alert_id: ALERT_UUID }, origin: "https://attacker.test", fetchImpl: async () => { called = true; return mockResponse([]); } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(called, false);
});

test("rejects unauthenticated and ordinary staff sessions", async () => {
  const ordinaryStaffId = "92345678901234567";
  setEnv({
    SESSION_SECRET: "test-session-secret",
    DISCORD_OWNER_ID: OWNER_ID,
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_ROLE_ID: ROLE_ID,
    DISCORD_WEBSITE_ADMIN_ROLE_ID: "52345678901234567",
    DISCORD_BOT_TOKEN: "test-bot-token",
    SUPABASE_URL: "https://database.test",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
  });
  const unauthenticated = await invoke({ user: null });
  assert.equal(unauthenticated.statusCode, 401);

  const ordinaryStaff = await invoke({ user: { id: ordinaryStaffId, roleId: ROLE_ID }, fetchImpl: async url => {
    const value = String(url);
    if (value.includes("staff_profiles?")) return mockResponse([{ is_active: true, is_banned: false }]);
    if (value.includes(`/guilds/${GUILD_ID}/members/${ordinaryStaffId}`)) return mockResponse({ roles: [] });
    return mockResponse([]);
  }});
  assert.equal(ordinaryStaff.statusCode, 403);
  assert.match(ordinaryStaff.body.error, /Website Admin/);
});
