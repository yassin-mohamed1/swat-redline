const DISCORD_API_BASE = "https://discord.com/api/v10";

function headerValue(headers, name) {
  try { return headers?.get?.(name) ?? null; } catch { return null; }
}

function secondsFromRetryValue(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : null;
}

function retryDelaySeconds(response, payload, attempt) {
  const values = [
    secondsFromRetryValue(payload?.retry_after),
    secondsFromRetryValue(headerValue(response.headers, "retry-after")),
    secondsFromRetryValue(headerValue(response.headers, "x-ratelimit-reset-after"))
  ].filter(value => value !== null);
  return values.length ? Math.max(...values) : Math.min(8, 2 ** attempt);
}

function makeDiscordError(status, payload, retryAfterSeconds = null) {
  const error = new Error(payload?.message || "Discord API request failed.");
  error.status = status;
  error.code = String(payload?.code || status);
  if (retryAfterSeconds !== null) error.retryAfterSeconds = retryAfterSeconds;
  error.global = Boolean(payload?.global) || headerValue(payload?.headers, "x-ratelimit-global") === "true";
  return error;
}

/**
 * Discord REST helper with bounded, server-directed 429 retries.
 * Discord's per-route limits vary, so this intentionally reads Retry-After,
 * retry_after, and X-RateLimit-Reset-After instead of hard-coding a quota.
 */
export async function discordApiRequest(token, path, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 3;
  const maxRetryWaitMs = Number.isFinite(options.maxRetryWaitMs) ? Math.max(0, options.maxRetryWaitMs) : 8000;
  const headers = {
    Authorization: "Bot " + token,
    "Content-Type": "application/json",
    "User-Agent": "DiscordBot (https://swat-redline.vercel.app, 1.0.0)",
    ...(init.headers || {})
  };
  let attempt = 0;

  while (true) {
    const response = await fetchImpl(DISCORD_API_BASE + path, { ...init, headers });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch {}

    if (response.status === 429) {
      const delaySeconds = retryDelaySeconds(response, payload, attempt);
      const delayMs = Math.ceil(delaySeconds * 1000);
      const error = makeDiscordError(429, payload, delaySeconds);
      if (attempt >= maxRetries || delayMs > maxRetryWaitMs) throw error;
      await sleep(delayMs + 50);
      attempt += 1;
      continue;
    }

    if (!response.ok) throw makeDiscordError(response.status, payload);
    return payload;
  }
}
