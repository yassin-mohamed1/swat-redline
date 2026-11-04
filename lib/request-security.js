const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reject cross-origin browser requests before they can use the portal session
 * cookie to change server-side data. Same-origin GET/HEAD/OPTIONS are unaffected.
 */
export function isSameOriginRequest(req) {
  const method = String(req.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return true;

  const hostHeader = req.headers.host || req.headers["x-forwarded-host"];
  const requestHost = String(hostHeader || "").split(",")[0].trim().toLowerCase();
  if (!requestHost) return false;

  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto = typeof forwardedProtoHeader === "string"
    ? forwardedProtoHeader.split(",")[0].trim().toLowerCase()
    : "";
  const expectedProtocol = forwardedProto
    ? (forwardedProto === "http" ? "http:" : "https:")
    : (req.socket?.encrypted ? "https:" : "http:");

  const originHeader = req.headers.origin;
  if (typeof originHeader === "string" && originHeader && originHeader !== "null") {
    try {
      const origin = new URL(originHeader);
      return origin.host.toLowerCase() === requestHost && origin.protocol === expectedProtocol;
    } catch {
      return false;
    }
  }

  const refererHeader = req.headers.referer;
  if (typeof refererHeader === "string" && refererHeader) {
    try {
      const referer = new URL(refererHeader);
      return referer.host.toLowerCase() === requestHost && referer.protocol === expectedProtocol;
    } catch {
      return false;
    }
  }

  return String(req.headers["sec-fetch-site"] || "").toLowerCase() === "same-origin";
}

export function requireSameOrigin(req, res) {
  if (isSameOriginRequest(req)) return true;
  res.status(403).json({ error: "Cross-origin request blocked. Reload the portal and try again." });
  return false;
}
