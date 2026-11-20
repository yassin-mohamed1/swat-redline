import test from "node:test";
import assert from "node:assert/strict";
import { claimWorkerWithRetry, WorkerLeaseSupervisor } from "./worker-lease.mjs";

test("claimWorkerWithRetry waits for an old instance to release its lease", async () => {
  let calls = 0;
  const retries = [];
  const claimed = await claimWorkerWithRetry({
    async claimWorker() { calls++; return calls === 3; }
  }, "worker-1", {
    attempts: 4,
    intervalMs: 1,
    sleep: async () => {},
    onRetry: (_error, attempt, reason) => retries.push({ attempt, reason })
  });
  assert.equal(claimed, true);
  assert.equal(calls, 3);
  assert.deepEqual(retries, [{ attempt: 1, reason: "busy" }, { attempt: 2, reason: "busy" }]);
});

test("claimWorkerWithRetry retries transient network failures but fails fast on authorization errors", async () => {
  let calls = 0;
  const claimed = await claimWorkerWithRetry({
    async claimWorker() {
      calls++;
      if (calls === 1) throw new Error("temporary timeout");
      return true;
    }
  }, "worker-1", { attempts: 3, intervalMs: 1, sleep: async () => {} });
  assert.equal(claimed, true);
  assert.equal(calls, 2);

  await assert.rejects(
    claimWorkerWithRetry({ async claimWorker() { throw Object.assign(new Error("forbidden"), { status: 403 }); } }, "worker-1", { sleep: async () => {} }),
    /forbidden/
  );
});

test("temporary renewal timeouts are retried without dropping the worker", async () => {
  let now = 1_000;
  let calls = 0;
  const retries = [];
  const lost = [];
  const supervisor = new WorkerLeaseSupervisor({
    repository: { async renewWorker() { calls++; if (calls === 1) throw new Error("timeout"); return true; } },
    instanceId: "worker-1",
    now: () => now,
    onRetry: (error, elapsedMs) => retries.push({ message: error.message, elapsedMs }),
    onLost: error => lost.push(error.message)
  });

  assert.deepEqual(await supervisor.tick(), { status: "retrying", elapsedMs: 0 });
  now += 5_000;
  assert.deepEqual(await supervisor.tick(), { status: "renewed" });
  assert.equal(supervisor.lastConfirmedAt, 6_000);
  assert.deepEqual(retries, [{ message: "timeout", elapsedMs: 0 }]);
  assert.deepEqual(lost, []);
});

test("worker stops before its lease expires when database renewal remains unavailable", async () => {
  let now = 10_000;
  const lost = [];
  const supervisor = new WorkerLeaseSupervisor({
    repository: { async renewWorker() { throw new Error("database timeout"); } },
    instanceId: "worker-1",
    now: () => now,
    retryGraceMs: 45_000,
    onLost: (error, meta) => lost.push({ message: error.message, meta })
  });

  now += 44_999;
  assert.equal((await supervisor.tick()).status, "retrying");
  now += 1;
  assert.equal((await supervisor.tick()).status, "lost");
  assert.equal(supervisor.active, false);
  assert.deepEqual(lost, [{ message: "database timeout", meta: { reason: "renewal_timeout", elapsedMs: 45_000 } }]);
});

test("a rejected lease renewal immediately shuts down the worker", async () => {
  const lost = [];
  const supervisor = new WorkerLeaseSupervisor({
    repository: { async renewWorker() { return false; } },
    instanceId: "worker-1",
    onLost: (error, meta) => lost.push({ message: error.message, meta })
  });

  assert.equal((await supervisor.tick()).status, "lost");
  assert.deepEqual(lost, [{ message: "worker_lease_lost", meta: { reason: "lease_rejected" } }]);
});

test("overlapping renewal ticks are skipped", async () => {
  let release;
  let calls = 0;
  const supervisor = new WorkerLeaseSupervisor({
    repository: { async renewWorker() { calls++; await new Promise(resolve => { release = resolve; }); return true; } },
    instanceId: "worker-1",
    onLost: () => assert.fail("lease should remain healthy")
  });
  const first = supervisor.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await supervisor.tick(), { status: "skipped" });
  release();
  assert.equal((await first).status, "renewed");
  assert.equal(calls, 1);
});
