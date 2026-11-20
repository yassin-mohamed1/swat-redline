const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function claimWorkerWithRetry(repository, instanceId, options = {}) {
  const attempts = Math.max(1, Math.min(60, Number(options.attempts) || 24));
  const intervalMs = Math.max(0, Math.min(30_000, Number(options.intervalMs) || 2_500));
  const sleep = options.sleep || defaultSleep;
  const onRetry = typeof options.onRetry === "function" ? options.onRetry : () => {};
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (await repository.claimWorker(instanceId)) return true;
      lastError = null;
      if (attempt < attempts) onRetry(null, attempt, "busy");
    } catch (error) {
      // Do not retry permanent configuration/authorization errors.
      const status = Number(error?.status || 0);
      if (status && status < 500 && status !== 429) throw error;
      lastError = error;
      if (attempt < attempts) onRetry(error, attempt, "error");
    }

    if (attempt < attempts && intervalMs) await sleep(intervalMs);
  }

  if (lastError) throw lastError;
  return false;
}

export class WorkerLeaseSupervisor {
  constructor({
    repository,
    instanceId,
    onLost,
    onRetry,
    now = () => Date.now(),
    intervalMs = 5_000,
    retryGraceMs = 45_000
  }) {
    if (!repository || typeof repository.renewWorker !== "function") {
      throw new TypeError("WorkerLeaseSupervisor requires repository.renewWorker().");
    }
    if (!instanceId) throw new TypeError("WorkerLeaseSupervisor requires an instanceId.");
    if (typeof onLost !== "function") throw new TypeError("WorkerLeaseSupervisor requires onLost().");
    this.repository = repository;
    this.instanceId = instanceId;
    this.onLost = onLost;
    this.onRetry = typeof onRetry === "function" ? onRetry : () => {};
    this.now = now;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || 5_000);
    this.retryGraceMs = Math.max(this.intervalMs, Number(retryGraceMs) || 45_000);
    this.lastConfirmedAt = this.now();
    this.timer = null;
    this.busy = false;
    this.active = true;
  }

  start() {
    if (!this.active || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.active || this.busy) return { status: "skipped" };
    this.busy = true;
    try {
      const renewed = await this.repository.renewWorker(this.instanceId);
      if (renewed) {
        this.lastConfirmedAt = this.now();
        return { status: "renewed" };
      }

      const lostError = Object.assign(new Error("worker_lease_lost"), { code: "worker_lease_lost" });
      this.stop();
      await this.onLost(lostError, { reason: "lease_rejected" });
      return { status: "lost" };
    } catch (error) {
      const elapsedMs = Math.max(0, this.now() - this.lastConfirmedAt);
      if (elapsedMs < this.retryGraceMs) {
        this.onRetry(error, elapsedMs);
        return { status: "retrying", elapsedMs };
      }

      this.stop();
      await this.onLost(error, { reason: "renewal_timeout", elapsedMs });
      return { status: "lost", elapsedMs };
    } finally {
      this.busy = false;
    }
  }
}
