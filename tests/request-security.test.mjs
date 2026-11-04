import test from "node:test";
import assert from "node:assert/strict";
import { isSameOriginRequest, requireSameOrigin } from "../lib/request-security.js";

const host = "swat-redline.vercel.app";
const secureHeaders = origin => ({
  host,
  "x-forwarded-proto": "https",
  ...(origin ? { origin } : {})
});

test("safe GET requests do not require origin metadata", () => {
  assert.equal(isSameOriginRequest({ method: "GET", headers: {} }), true);
});

test("same-origin POST is accepted", () => {
  assert.equal(isSameOriginRequest({
    method: "POST",
    headers: secureHeaders("https://" + host)
  }), true);
});

test("cross-origin POST is rejected", () => {
  assert.equal(isSameOriginRequest({
    method: "POST",
    headers: secureHeaders("https://attacker.example")
  }), false);
});

test("an unsafe request without origin metadata is rejected", () => {
  assert.equal(isSameOriginRequest({
    method: "POST",
    headers: { host }
  }), false);
});

test("same-origin Referer is accepted as a fallback", () => {
  assert.equal(isSameOriginRequest({
    method: "PATCH",
    headers: {
      host,
      "x-forwarded-proto": "https",
      referer: "https://" + host + "/settings"
    }
  }), true);
});

test("Fetch Metadata can confirm same-origin requests", () => {
  assert.equal(isSameOriginRequest({
    method: "PUT",
    headers: { host, "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" }
  }), true);
});

test("Fetch Metadata rejects cross-site requests", () => {
  assert.equal(isSameOriginRequest({
    method: "PUT",
    headers: { host, "x-forwarded-proto": "https", "sec-fetch-site": "cross-site" }
  }), false);
});

test("local HTTP development uses the request protocol", () => {
  assert.equal(isSameOriginRequest({
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    socket: { encrypted: false }
  }), true);
});

test("Origin takes precedence over a same-origin Referer", () => {
  assert.equal(isSameOriginRequest({
    method: "POST",
    headers: {
      host,
      "x-forwarded-proto": "https",
      origin: "https://attacker.example",
      referer: "https://" + host + "/"
    }
  }), false);
});

test("requireSameOrigin returns HTTP 403 for a cross-origin mutation", () => {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  const allowed = requireSameOrigin({
    method: "POST",
    headers: secureHeaders("https://attacker.example")
  }, response);

  assert.equal(allowed, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /Cross-origin/);
});
