import adminMedia from "../api/admin/media.js";
import adminMembers from "../api/admin/members.js";
import adminSettings from "../api/admin/settings.js";
import botCommandCenter from "../api/bot/command-center.js";
import auditLog from "../api/audit/log.js";
import discordAuth from "../api/auth/discord.js";
import logout from "../api/auth/logout.js";
import authSession from "../api/auth/session.js";
import sendNotifications from "../api/notifications/send.js";
import siteImages from "../api/site-images.js";
import sharedState from "../api/state.js";
import userNotifications from "../api/user/notifications.js";
import warnings from "../api/warnings.js";
import welcomeAppSource from "./welcome-app-source.js";

const API_ROUTES = new Map([
  ["/api/admin/media", adminMedia],
  ["/api/admin/members", adminMembers],
  ["/api/admin/settings", adminSettings],
  ["/api/bot/command-center", botCommandCenter],
  ["/api/audit/log", auditLog],
  ["/api/auth/discord", discordAuth],
  ["/api/auth/logout", logout],
  ["/api/auth/session", authSession],
  ["/api/notifications/send", sendNotifications],
  ["/api/site-images", siteImages],
  ["/api/state", sharedState],
  ["/api/user/notifications", userNotifications],
  ["/api/warnings", warnings],
]);

function toNodeHeaders(headers, url) {
  const output = {};
  for (const [name, value] of headers.entries()) {
    output[name.toLowerCase()] = value;
  }
  output.host ||= url.host;
  output["x-forwarded-host"] ||= url.host;
  output["x-forwarded-proto"] ||= url.protocol.slice(0, -1);
  return output;
}

function toNodeQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }
  return query;
}

async function readBody(request) {
  if (["GET", "HEAD"].includes(request.method.toUpperCase())) return undefined;
  const text = await request.text();
  if (!text) return undefined;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function createNodeResponse() {
  let statusCode = 200;
  let body;
  let completed = false;
  const headers = new Headers();

  const response = {
    setHeader(name, value) {
      const key = String(name);
      if (Array.isArray(value)) {
        headers.delete(key);
        for (const item of value) headers.append(key, String(item));
      } else {
        headers.set(key, String(value));
      }
      return this;
    },
    status(code) {
      statusCode = Number(code) || 200;
      return this;
    },
    json(value) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      body = JSON.stringify(value);
      completed = true;
      return this;
    },
    send(value) {
      if (value === undefined || value === null) {
        body = null;
      } else if (typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        body = value;
      } else {
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json; charset=utf-8");
        }
        body = JSON.stringify(value);
      }
      completed = true;
      return this;
    },
    redirect(statusOrUrl, maybeUrl) {
      const destination = maybeUrl === undefined ? statusOrUrl : maybeUrl;
      statusCode = maybeUrl === undefined ? 302 : Number(statusOrUrl) || 302;
      headers.set("location", String(destination));
      body = null;
      completed = true;
      return this;
    },
    end(value) {
      body = value === undefined ? null : value;
      completed = true;
      return this;
    },
  };

  return {
    response,
    toResponse() {
      if (!completed) {
        return new Response("The API route did not produce a response.", {
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (statusCode === 204 || statusCode === 304) body = null;
      return new Response(body, { status: statusCode, headers });
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const handler = API_ROUTES.get(url.pathname);

    if (url.pathname === "/bot-command-center-app.js" && ["GET", "HEAD"].includes(request.method)) {
      return new Response(request.method === "HEAD" ? null : welcomeAppSource, {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (!handler) {
      return Response.json({ error: "API route not found" }, { status: 404 });
    }

    try {
      const req = {
        method: request.method.toUpperCase(),
        url: url.pathname + url.search,
        headers: toNodeHeaders(request.headers, url),
        query: toNodeQuery(url.searchParams),
        body: await readBody(request),
        // API handlers expect Vercel's body parser to have consumed the stream.
        readableEnded: true,
        destroyed: true,
        socket: { encrypted: url.protocol === "https:" },
      };

      const nodeResponse = createNodeResponse();
      await handler(req, nodeResponse.response);
      return nodeResponse.toResponse();
    } catch (error) {
      console.error(JSON.stringify({
        event: "api_route_error",
        path: url.pathname,
        message: error?.message || "Unhandled API error",
      }));
      return Response.json(
        { error: "An internal server error occurred." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  },
};
