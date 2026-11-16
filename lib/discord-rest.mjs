const DISCORD_API_BASE = "https://discord.com/api/v10";
const RED_CIRCLE_MARKER_RE = /\u{1F534}\uFE0F?/gu;

/**
 * Remove the specific red-circle marker from every text field sent to Discord.
 * Other emojis, message content, embeds, buttons and formatting are preserved.
 */
export function removeRedCircleMarkers(value) {
  if (typeof value === "string") return value.replace(RED_CIRCLE_MARKER_RE, "");
  if (Array.isArray(value)) return value.map(removeRedCircleMarkers);
  if (value && typeof value === "object" && !(typeof Blob !== "undefined" && value instanceof Blob)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, removeRedCircleMarkers(item)]));
  }
  return value;
}

function sanitizeJsonBody(body) {
  if (typeof body !== "string") return body;
  try {
    return JSON.stringify(removeRedCircleMarkers(JSON.parse(body)));
  } catch {
    return removeRedCircleMarkers(body);
  }
}

async function sanitizeDiscordRequestBody(body) {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const cleanForm = new FormData();
    for (const [key, value] of body.entries()) {
      if (key === "payload_json" && typeof value === "string") {
        cleanForm.append(key, sanitizeJsonBody(value));
        continue;
      }
      const isTextAttachment = typeof Blob !== "undefined" && value instanceof Blob &&
        (String(value.type || "").toLowerCase().startsWith("text/") ||
         /\.txt$/i.test(String(value.name || "")));
      if (isTextAttachment) {
        const cleanText = removeRedCircleMarkers(await value.text());
        const cleanBlob = new Blob([cleanText], { type: value.type || "text/plain;charset=utf-8" });
        if (typeof value.name === "string" && value.name) cleanForm.append(key, cleanBlob, value.name);
        else cleanForm.append(key, cleanBlob);
        continue;
      }
      cleanForm.append(key, value);
    }
    return cleanForm;
  }
  return sanitizeJsonBody(body);
}


// Vercel may reuse a function instance between requests. Serialize bot REST
// calls in that instance so independent portal routes do not burst one bucket.
let requestQueue = Promise.resolve();
let globalCooldownUntil = 0;
const routeCooldownUntil = new Map();

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

function routeKey(method, path) {
  const route = String(path || "").split("?")[0]
    .replace(/\/\d{15,22}(?=\/|$)/g, "/:id");
  return String(method || "GET").toUpperCase() + " " + route;
}

function makeDiscordError(status, payload, retryAfterSeconds = null, response = null, path = "") {
  const error = new Error(payload?.message || "Discord API request failed.");
  error.status = status;
  error.code = String(payload?.code || status);
  error.path = path;
  if (retryAfterSeconds !== null) error.retryAfterSeconds = retryAfterSeconds;
  error.global = Boolean(payload?.global) ||
    headerValue(response?.headers, "x-ratelimit-global") === "true" ||
    headerValue(response?.headers, "x-ratelimit-scope") === "global";
  return error;
}

function delay(ms, sleep) {
  return ms > 0 ? sleep(ms) : Promise.resolve();
}

/**
 * Discord REST helper with bounded, server-directed retries and per-instance
 * request serialization. It respects Retry-After, retry_after and reset headers.
 * Multipart requests keep the browser/runtime-generated Content-Type boundary.
 */
export async function discordApiRequest(token, path, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 3;
  const maxRetryWaitMs = Number.isFinite(options.maxRetryWaitMs) ? Math.max(0, options.maxRetryWaitMs) : 8000;
  const method = String(init.method || "GET").toUpperCase();
  const key = routeKey(method, path);
  const requestBody = init.body === undefined ? undefined : await sanitizeDiscordRequestBody(init.body);
  const isMultipart = typeof FormData !== "undefined" && requestBody instanceof FormData;
  const headers = {
    Authorization: "Bot " + token,
    ...(isMultipart ? {} : { "Content-Type": "application/json" }),
    "User-Agent": "DiscordBot (https://swat-redline.vercel.app, 1.0.0)",
    ...(init.headers || {})
  };

  const previous = requestQueue.catch(() => {});
  let release;
  requestQueue = new Promise(resolve => { release = resolve; });
  await previous;

  try {
    let attempt = 0;
    while (true) {
      const now = Date.now();
      const cooldownUntil = Math.max(globalCooldownUntil, routeCooldownUntil.get(key) || 0);
      const cooldownMs = Math.max(0, cooldownUntil - now);
      if (cooldownMs > maxRetryWaitMs) {
        throw makeDiscordError(429, { message: "Discord rate limit is cooling down." }, cooldownMs / 1000, null, path);
      }
      await delay(cooldownMs + (cooldownMs ? 50 : 0), sleep);

      const response = await fetchImpl(DISCORD_API_BASE + path, { ...init, ...(requestBody === undefined ? {} : { body: requestBody }), method, headers });
      const raw = await response.text();
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch {}

      if (response.status === 429) {
        const delaySeconds = retryDelaySeconds(response, payload, attempt);
        const delayMs = Math.ceil(delaySeconds * 1000);
        const error = makeDiscordError(429, payload, delaySeconds, response, path);
        const retryAt = Date.now() + delayMs + 50;
        if (error.global) globalCooldownUntil = Math.max(globalCooldownUntil, retryAt);
        else routeCooldownUntil.set(key, Math.max(routeCooldownUntil.get(key) || 0, retryAt));
        if (attempt >= maxRetries || delayMs > maxRetryWaitMs) throw error;
        await delay(delayMs + 50, sleep);
        attempt += 1;
        continue;
      }

      const remaining = headerValue(response.headers, "x-ratelimit-remaining");
      const resetAfter = secondsFromRetryValue(headerValue(response.headers, "x-ratelimit-reset-after"));
      if (remaining === "0" && resetAfter !== null) {
        routeCooldownUntil.set(key, Date.now() + Math.ceil(resetAfter * 1000) + 50);
      }

      if (!response.ok) throw makeDiscordError(response.status, payload, null, response, path);
      return payload;
    }
  } finally {
    release?.();
  }
}
