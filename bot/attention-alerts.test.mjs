import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AttentionAlertError, AttentionAlertManager, validateStartConditions } from "./attention-alerts.mjs";

const GUILD_ID = "12345678901234567";
const USER_ID = "22345678901234567";
const MODERATOR_ID = "32345678901234567";
const ROLE_ID = "42345678901234567";
const ORIGIN_ID = "52345678901234567";
const ALERT_ID = "62345678901234567";

const quietLogger = { info() {}, error() {}, warn() {} };
const config = {
  guildId: GUILD_ID,
  managerRoleId: ROLE_ID,
  alertChannelId: ALERT_ID,
  cycleMs: 30,
  dwellMs: 0,
  maxDurationMs: 5_000,
  cooldownMs: 0,
  moveTimeoutMs: 200
};

function makeSetup({ selfDeaf = true, channelPermissions = true, moveDelayMs = 0, cycleMs = config.cycleMs, maxDurationMs = config.maxDurationMs } = {}) {
  const client = new EventEmitter();
  const channels = new Map();
  const permissionState = { allowed: channelPermissions };
  const makeChannel = (id, name) => ({
    id,
    name,
    guildId: GUILD_ID,
    type: 2,
    permissionsFor() {
      return { has: required => permissionState.allowed && required.includes("ViewChannel") && required.includes("Connect") && required.includes("MoveMembers") };
    }
  });
  channels.set(ORIGIN_ID, makeChannel(ORIGIN_ID, "Operations"));
  channels.set(ALERT_ID, makeChannel(ALERT_ID, "Attention"));
  const guild = {
    id: GUILD_ID,
    channels: { fetch: async id => channels.get(String(id)) || null },
    members: { me: { id: "bot" }, fetchMe: async () => ({ id: "bot" }) }
  };
  let channelId = ORIGIN_ID;
  let currentSelfDeaf = selfDeaf;
  const calls = [];
  let activeMoves = 0;
  let maxConcurrentMoves = 0;
  const member = {
    id: USER_ID,
    guild,
    user: { id: USER_ID, username: "Target", bot: false },
    displayName: "Target",
    voice: {
      get channelId() { return channelId; },
      get selfDeaf() { return currentSelfDeaf; },
      set selfDeaf(value) { currentSelfDeaf = value; },
      async setChannel(destination) {
        calls.push(String(destination));
        activeMoves++;
        maxConcurrentMoves = Math.max(maxConcurrentMoves, activeMoves);
        try {
          if (moveDelayMs) await new Promise(resolve => setTimeout(resolve, moveDelayMs));
          const oldState = { id: USER_ID, channelId, selfDeaf: currentSelfDeaf };
          channelId = String(destination);
          const newState = { id: USER_ID, channelId, selfDeaf: currentSelfDeaf };
          client.emit("voiceStateUpdate", oldState, newState);
        } finally {
          activeMoves--;
        }
      }
    }
  };
  const rows = [];
  let nextId = 1;
  const repository = {
    async getLatestForUser(guildId, userId) {
      return rows.filter(row => row.guild_id === guildId && row.discord_user_id === userId).at(-1) || null;
    },
    async createActive(row) {
      if (rows.some(existing => existing.guild_id === row.guild_id && existing.discord_user_id === row.discord_user_id && existing.status === "active")) {
        throw Object.assign(new Error("unique active alert"), { status: 409 });
      }
      const saved = { id: `alert-${nextId++}`, ...row };
      rows.push(saved);
      return saved;
    },
    async listStopRequests(guildId) {
      return rows.filter(row => row.guild_id === guildId && row.status === "active" && row.stop_requested_at);
    },
    async finish(id, values) {
      const row = rows.find(item => item.id === id);
      if (!row || row.status !== "active") return null;
      Object.assign(row, values);
      return row;
    },
    async interruptAll(guildId, endedAt) {
      const active = rows.filter(row => row.guild_id === guildId && row.status === "active");
      for (const row of active) Object.assign(row, { status: "interrupted", end_reason: "bot_restarted", ended_at: endedAt });
      return active;
    }
  };
  const manager = new AttentionAlertManager({ client, repository, config: { ...config, cycleMs, maxDurationMs }, logger: quietLogger });
  const start = (target = member, roleIds = [ROLE_ID]) => manager.start({
    guild,
    member: target,
    moderator: { id: MODERATOR_ID, username: "Supervisor" },
    moderatorRoleIds: roleIds,
    moderatorCanMoveMembers: true
  });
  return { client, guild, member, manager, repository, rows, calls, start, permissionState, get maxConcurrentMoves() { return maxConcurrentMoves; }, get channelId() { return channelId; } };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("Timed out waiting for the expected state.");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("starts only for a self-deafened guild member and returns them to their exact original channel", async () => {
  const setup = makeSetup();
  const started = await setup.start();
  assert.deepEqual(setup.calls, [ALERT_ID, ORIGIN_ID]);
  assert.equal(setup.channelId, ORIGIN_ID);
  assert.equal(setup.rows[0].original_channel_id, ORIGIN_ID);
  assert.equal(setup.rows[0].status, "active");
  const entry = setup.manager.activeById.get(started.id);
  setup.manager.requestStop(entry, "manual_stop");
  await started.completion;
  assert.equal(setup.rows[0].end_reason, "manual_stop");
  assert.equal(setup.rows[0].status, "stopped");
});

test("repeats cycles without overlapping moves for the same member", async () => {
  const setup = makeSetup({ moveDelayMs: 3 });
  const started = await setup.start();
  await waitFor(() => setup.calls.length >= 6);
  const entry = setup.manager.activeById.get(started.id);
  setup.manager.requestStop(entry, "manual_stop");
  await started.completion;
  assert.equal(setup.maxConcurrentMoves, 1);
  assert.equal(setup.calls.length % 2, 0);
  for (let i = 0; i < setup.calls.length; i += 2) assert.deepEqual(setup.calls.slice(i, i + 2), [ALERT_ID, ORIGIN_ID]);
  assert.equal(setup.channelId, ORIGIN_ID);
});

test("stops after Self Deafen becomes false but does not use Server Deafen as a substitute", async () => {
  const setup = makeSetup();
  const started = await setup.start();
  setup.client.emit("voiceStateUpdate",
    { id: USER_ID, channelId: ORIGIN_ID, selfDeaf: true, serverDeaf: false },
    { id: USER_ID, channelId: ORIGIN_ID, selfDeaf: true, serverDeaf: true }
  );
  assert.equal(setup.manager.activeById.has(started.id), true);
  setup.member.voice.selfDeaf = false;
  setup.client.emit("voiceStateUpdate",
    { id: USER_ID, channelId: ORIGIN_ID, selfDeaf: true, serverDeaf: true },
    { id: USER_ID, channelId: ORIGIN_ID, selfDeaf: false, serverDeaf: true }
  );
  await started.completion;
  const movesAtStop = setup.calls.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(setup.calls.length, movesAtStop);
  assert.equal(setup.rows[0].end_reason, "self_undeafened");
  assert.equal(setup.channelId, ORIGIN_ID);
});

test("stops safely at the configured maximum duration and returns to the original channel", async () => {
  const setup = makeSetup({ cycleMs: 15, maxDurationMs: 40 });
  const started = await setup.start();
  await started.completion;
  assert.equal(setup.rows[0].end_reason, "max_duration");
  assert.equal(setup.rows[0].status, "stopped");
  assert.equal(setup.channelId, ORIGIN_ID);
  assert.equal(setup.calls.length % 2, 0);
});

test("Stop Alert cancels the current cycle, waits for an in-flight move, then restores safely", async () => {
  let releaseMove;
  const setup = makeSetup({ moveDelayMs: 0 });
  const setChannel = setup.member.voice.setChannel;
  setup.member.voice.setChannel = async destination => {
    if (setup.calls.length === 0) await new Promise(resolve => { releaseMove = resolve; });
    return setChannel(destination);
  };
  const starting = setup.start();
  await waitFor(() => Boolean(releaseMove));
  const entry = [...setup.manager.activeById.values()][0];
  setup.manager.requestStop(entry, "manual_stop");
  assert.deepEqual(setup.calls, []);
  releaseMove();
  await assert.rejects(starting, AttentionAlertError);
  await entry.completion;
  assert.deepEqual(setup.calls, [ALERT_ID, ORIGIN_ID]);
  assert.equal(setup.rows[0].end_reason, "manual_stop");
});

test("stops when the member leaves voice or moves to another channel and never pulls them back", async () => {
  const left = makeSetup();
  const leftStarted = await left.start();
  left.client.emit("voiceStateUpdate", { id: USER_ID, channelId: ORIGIN_ID, selfDeaf: true }, { id: USER_ID, channelId: null, selfDeaf: true });
  await leftStarted.completion;
  assert.equal(left.rows[0].end_reason, "left_voice");
  assert.equal(left.calls.length, 2);

  const moved = makeSetup();
  const movedStarted = await moved.start();
  const otherChannel = "72345678901234567";
  moved.client.emit("voiceStateUpdate", { id: USER_ID, channelId: ORIGIN_ID, selfDeaf: true }, { id: USER_ID, channelId: otherChannel, selfDeaf: true });
  await movedStarted.completion;
  assert.equal(moved.rows[0].end_reason, "moved_elsewhere");
  assert.equal(moved.calls.length, 2);
});

test("rejects a second alert for one member while allowing a second member concurrently", async () => {
  const setup = makeSetup();
  const sameMemberAttempts = await Promise.allSettled([setup.start(), setup.start()]);
  const started = sameMemberAttempts.find(result => result.status === "fulfilled").value;
  assert.equal(sameMemberAttempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(sameMemberAttempts.filter(result => result.status === "rejected" && result.reason.code === "already_active").length, 1);

  const secondId = "82345678901234567";
  let secondChannelId = ORIGIN_ID;
  const secondMember = {
    ...setup.member,
    id: secondId,
    user: { id: secondId, username: "Second", bot: false },
    displayName: "Second",
    voice: { ...setup.member.voice }
  };
  Object.defineProperty(secondMember.voice, "channelId", { get: () => secondChannelId });
  Object.defineProperty(secondMember.voice, "selfDeaf", { get: () => true });
  secondMember.voice.setChannel = async destination => {
    setup.calls.push(`${secondId}:${destination}`);
    const oldState = { id: secondId, channelId: secondChannelId, selfDeaf: true };
    secondChannelId = String(destination);
    const newState = { id: secondId, channelId: String(destination), selfDeaf: true };
    setup.client.emit("voiceStateUpdate", oldState, newState);
  };
  const secondStarted = await setup.start(secondMember);
  assert.equal(setup.manager.activeById.size, 2);
  setup.manager.requestStop(setup.manager.activeById.get(started.id), "manual_stop");
  setup.manager.requestStop(setup.manager.activeById.get(secondStarted.id), "manual_stop");
  await Promise.all([started.completion, secondStarted.completion]);
  assert.equal(setup.rows.every(row => row.status === "stopped"), true);
});

test("rejects missing channels, missing permissions, wrong roles, non-voice targets, and non-deaf targets", async () => {
  const base = {
    expectedGuildId: GUILD_ID,
    guildId: GUILD_ID,
    target: { guild: { id: GUILD_ID }, voice: { channelId: ORIGIN_ID, selfDeaf: true } },
    moderatorRoleIds: [ROLE_ID],
    managerRoleId: ROLE_ID,
    moderatorCanMoveMembers: true,
    originalChannel: { id: ORIGIN_ID, guildId: GUILD_ID, type: 2, permissionsFor: () => ({ has: () => true }) },
    alertChannel: { id: ALERT_ID, guildId: GUILD_ID, type: 2, permissionsFor: () => ({ has: () => true }) },
    botMember: { id: "bot" }
  };
  assert.equal(validateStartConditions(base), null);
  assert.equal(validateStartConditions({ ...base, moderatorRoleIds: [], moderatorIsAdministrator: true }), null);
  assert.match(validateStartConditions({ ...base, alertChannel: null }), /روم التنبيه غير موجود/);
  assert.match(validateStartConditions({ ...base, moderatorRoleIds: [] }), /مديري التحذيرات/);
  assert.match(validateStartConditions({ ...base, moderatorCanMoveMembers: false }), /Move Members/);
  assert.match(validateStartConditions({ ...base, target: { ...base.target, voice: { channelId: null, selfDeaf: true } } }), /ليس في روم صوتي/);
  assert.match(validateStartConditions({ ...base, target: { ...base.target, voice: { channelId: ORIGIN_ID, selfDeaf: false } } }), /Self Deafen/);
  assert.match(validateStartConditions({ ...base, alertChannel: { ...base.alertChannel, type: 0 } }), /رومين صوتيين/);
  assert.match(validateStartConditions({ ...base, alertChannel: { ...base.alertChannel, permissionsFor: () => ({ has: () => false }) } }), /صلاحيات/);
});

test("stops safely when bot channel permissions disappear", async () => {
  const setup = makeSetup();
  const started = await setup.start();
  setup.permissionState.allowed = false;
  await waitFor(() => setup.rows[0].status !== "active");
  await started.completion;
  assert.equal(setup.rows[0].status, "failed");
  assert.equal(setup.rows[0].end_reason, "permission_lost");
  assert.equal(setup.channelId, ORIGIN_ID);
});

test("stop requests are idempotent and stale rows are marked interrupted after restart", async () => {
  const setup = makeSetup();
  const started = await setup.start();
  const row = setup.rows[0];
  row.stop_requested_at = new Date().toISOString();
  await setup.manager.pollStopRequests();
  await setup.manager.pollStopRequests();
  await started.completion;
  assert.equal(row.end_reason, "manual_stop");

  const stale = await setup.repository.createActive({ guild_id: GUILD_ID, discord_user_id: "92345678901234567", started_at: new Date().toISOString(), status: "active" });
  await setup.manager.interruptStaleAlerts();
  assert.equal(stale.status, "interrupted");
  assert.equal(stale.end_reason, "bot_restarted");
});
