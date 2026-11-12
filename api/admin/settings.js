import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { forwardAuditEventsToDiscord } from "../../lib/audit-log.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../../lib/portal-admin.js";
import { validateProjectCodePackage, publishProjectCodePackage } from "../../lib/project-code.js";

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };
function cookies(header = "") {
  const out = {};
  for (const part of header.split(";")) { const i = part.indexOf("="); if (i < 0) continue; try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  return out;
}
function session(req) {
  const secret = process.env.SESSION_SECRET, raw = cookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), sig = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest(), received = Buffer.from(sig, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let u; try { u = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const owner = Boolean(process.env.DISCORD_OWNER_ID && u.id === process.env.DISCORD_OWNER_ID);
  if (!u.id || !u.issuedAt || Date.now() - u.issuedAt > 8 * 60 * 60 * 1000 || u.issuedAt > Date.now() + 60000 || (!owner && u.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...u, isOwner: owner };
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req); if (!user) return res.status(401).json({ error: "Authentication required" });
  if (req.method !== "GET") {
    let websiteAdmin = false;
    try {
      websiteAdmin = await isWebsiteAdmin(user);
      if (websiteAdmin && !user.isOwner) await requireActivePortalStaff(user);
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.message || "Could not verify Website Admin access." });
    }
    if (!user.isOwner && !websiteAdmin) return res.status(403).json({ error: "Website Admin permission required" });
  }
  if (req.method === "PUT" && !requireSameOrigin(req, res)) return;
  if (!["GET", "PUT", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, PUT, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if ((req.method === "PUT" || req.method === "POST") && !requireSameOrigin(req, res)) return;

  const codeCenterUrl = new URL(req.url, "https://swat-redline.vercel.app");
  if (req.method === "GET" && codeCenterUrl.searchParams.get("code_center") === "1") {
    if (!user.isOwner) return res.status(403).json({ error: "Only the portal owner can access source-code publishing." });
    const connected = Boolean(process.env.SWAT_GITHUB_TOKEN);
    return res.status(200).json({
      ok: true,
      connected,
      repository: "yassin-mohamed1/swat-redline",
      branch: "main",
      mode: "direct-production",
      limits: { maxFiles: 40, maxFileBytes: 262144, maxTotalBytes: 1048576 },
      message: connected
        ? "GitHub publishing is configured. Approved packages commit directly to main and trigger the normal Vercel Production deployment."
        : "GitHub publishing is not configured. Add SWAT_GITHUB_TOKEN as a Vercel Production Secret to enable source-code publishing."
    });
  }

  if (req.method === "POST") {
    if (!user.isOwner) return res.status(403).json({ error: "Only the portal owner can publish source-code changes." });
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    if (!["validate", "apply"].includes(body.action)) return res.status(400).json({ error: "Action must be validate or apply." });
    let update;
    try { update = validateProjectCodePackage(body.package); }
    catch (error) { return res.status(error.status || 400).json({ error: error.message || "Invalid code update package." }); }

    if (body.action === "validate") {
      const connected = Boolean(process.env.SWAT_GITHUB_TOKEN);
      return res.status(200).json({
        ok: true,
        summary: update.summary,
        fileCount: update.files.length,
        totalBytes: update.totalBytes,
        files: update.files.map(file => ({ path: file.path, action: file.action, bytes: file.bytes || 0 })),
        connected,
        publishReady: connected
      });
    }

    const githubToken = process.env.SWAT_GITHUB_TOKEN;
    if (!githubToken) {
      return res.status(503).json({
        error: "Code package is valid, but GitHub publishing is not connected yet. Add the protected Vercel Production Secret SWAT_GITHUB_TOKEN with repository Contents: Read and write permission, then redeploy."
      });
    }
    try {
      const result = await publishProjectCodePackage(githubToken, update, user.displayName || user.username || user.id);
      console.info("SWAT Code Center commit", JSON.stringify({
        actor: user.id,
        commit: result.commitSha,
        files: result.files,
        summary: update.summary
      }));
      return res.status(200).json({ ok: true, message: "Project changes committed to main. Vercel Production deployment has been triggered.", ...result });
    } catch (error) {
      console.error("SWAT Code Center publish failed", error?.githubStatus || error?.status || "unknown", error?.message || "unknown");
      return res.status(error.status || 502).json({ error: error.message || "Could not publish the project update." });
    }
  }
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: "Database is not configured" });
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  try {
    if (req.method === "GET") {
      const r = await fetch(base + "/rest/v1/site_settings?select=key,value", { headers });
      if (!r.ok) { console.error("Settings read failed:", r.status, (await r.text()).slice(0, 400)); return res.status(502).json({ error: "Could not load settings. Apply the admin migration first." }); }
      const rows = await r.json(), settings = {};
      let canReadAdminSettings = Boolean(user.isOwner);
      if (!canReadAdminSettings) {
        try {
          canReadAdminSettings = await isWebsiteAdmin(user);
          if (canReadAdminSettings) await requireActivePortalStaff(user);
        } catch {
          canReadAdminSettings = false;
        }
      }
      const adminOnlySettingKeys = new Set([
        "notificationRoleMentionDisabled",
        "notificationChannelEnabled",
        "notificationMemberDmEnabled",
        "disciplinaryTargetMentionEnabled"
      ]);
      for (const row of rows) {
        if (!canReadAdminSettings && adminOnlySettingKeys.has(row.key)) continue;
        settings[row.key] = row.value;
      }
      return res.status(200).json({ settings });
    }
    if (req.method !== "PUT") { res.setHeader("Allow", "GET, PUT"); return res.status(405).json({ error: "Method not allowed" }); }
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) return res.status(400).json({ error: "Settings object required" });
    const allowed = new Set(["accentColor", "backgroundColor", "textOverrides", "styleOverrides", "siteImages", "notificationRoleMentionDisabled", "notificationChannelEnabled", "notificationMemberDmEnabled", "disciplinaryTargetMentionEnabled", "customMenuItems"]);
    const rows = [];
    for (const [k, value] of Object.entries(body.settings)) {
      if (!allowed.has(k)) continue;
      const raw = JSON.stringify(value);
      if (raw.length > 120000) return res.status(413).json({ error: "A setting is too large" });
      if (k.endsWith("Color") && (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))) return res.status(400).json({ error: "Invalid color value" });
      if (["notificationRoleMentionDisabled", "notificationChannelEnabled", "notificationMemberDmEnabled", "disciplinaryTargetMentionEnabled"].includes(k) && typeof value !== "boolean") return res.status(400).json({ error: k + " must be a boolean" });
      const plainObject = (input) => Boolean(input) && typeof input === "object" && !Array.isArray(input) && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
      if (k === "textOverrides") {
        if (!plainObject(value) || Object.keys(value).length > 500) return res.status(400).json({ error: "Invalid text overrides" });
        for (const [selector, text] of Object.entries(value)) if (selector.length > 500 || !/^.{1,480}\|text\|\d+$/.test(selector) || typeof text !== "string" || text.length > 2000) return res.status(400).json({ error: "Invalid text override entry" });
      }
      if (k === "styleOverrides") {
        if (!plainObject(value) || Object.keys(value).length > 500) return res.status(400).json({ error: "Invalid style overrides" });
        for (const [selector, styles] of Object.entries(value)) {
          if (!selector.trim() || selector.length > 300 || !plainObject(styles) || Object.keys(styles).some(key => !["color", "backgroundColor"].includes(key)) || Object.values(styles).some(color => typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))) return res.status(400).json({ error: "Invalid style override entry" });
        }
      }
      if (k === "customMenuItems") {
        if (!Array.isArray(value) || value.length > 12) return res.status(400).json({ error: "Invalid custom menu list" });
        const ids = new Set();
        for (const item of value) {
          const itemKeys = plainObject(item) ? Object.keys(item) : [];
          if (!plainObject(item) || itemKeys.some(key => !["id", "label", "icon", "description", "content", "buttons"].includes(key)) ||
              typeof item.id !== "string" || !/^[a-z0-9-]{2,40}$/.test(item.id) || ids.has(item.id) ||
              typeof item.label !== "string" || !item.label.trim() || item.label.length > 40 ||
              (item.icon !== undefined && (typeof item.icon !== "string" || item.icon.length > 8)) ||
              (item.description !== undefined && (typeof item.description !== "string" || item.description.length > 160)) ||
              (item.content !== undefined && (typeof item.content !== "string" || item.content.length > 6000)) ||
              (item.buttons !== undefined && (!Array.isArray(item.buttons) || item.buttons.length > 8))) {
            return res.status(400).json({ error: "Invalid custom menu item" });
          }
          if (Array.isArray(item.buttons)) {
            for (const button of item.buttons) {
              if (!plainObject(button) || Object.keys(button).some(key => !["label", "url"].includes(key)) ||
                  typeof button.label !== "string" || !button.label.trim() || button.label.length > 40 ||
                  typeof button.url !== "string" || button.url.length > 2048) {
                return res.status(400).json({ error: "Invalid custom menu button" });
              }
              try {
                const target = new URL(button.url);
                if (target.protocol !== "https:" || target.username || target.password) throw new Error("Unsafe URL");
              } catch {
                return res.status(400).json({ error: "Custom menu buttons require a valid HTTPS URL" });
              }
            }
          }
          ids.add(item.id);
        }
      }
      if (k === "siteImages") {
        const allowedImageKeys = new Set(["logo", "logoSidebar", "logoLoading", "logoLogin", "banner", "background", "gallery"]);
        const safeImageUrl = (url) => typeof url === "string" && url.length <= 2048 && (url === "" || url.startsWith("/") || /^https:\/\//i.test(url));
        if (!plainObject(value) || Object.keys(value).some(key => !allowedImageKeys.has(key))) return res.status(400).json({ error: "Invalid site images" });
        for (const key of ["logo", "logoSidebar", "logoLoading", "logoLogin", "banner", "background"]) if (key in value && !safeImageUrl(value[key])) return res.status(400).json({ error: "Invalid image URL" });
        if ("gallery" in value) {
          if (!Array.isArray(value.gallery) || value.gallery.length > 40) return res.status(400).json({ error: "Invalid site image gallery" });
          for (const image of value.gallery) if (!plainObject(image) || typeof image.title !== "string" || image.title.length > 100 || !safeImageUrl(image.url) || !image.url) return res.status(400).json({ error: "Invalid gallery image" });
        }
      }
      rows.push({ key: k, value, updated_by: user.id, updated_at: new Date().toISOString() });
    }
    if (!rows.length) return res.status(400).json({ error: "No supported settings supplied" });
    const previousResponse=await fetch(base+"/rest/v1/site_settings?select=key,value",{headers});
    const previousSettings=previousResponse.ok?await previousResponse.json():[];
    const previousByKey=new Map(previousSettings.map(row=>[row.key,row.value]));
    const changedRows=rows.filter(row=>JSON.stringify(previousByKey.get(row.key))!==JSON.stringify(row.value));
    const summarizeSetting=(key,value)=>{
      if(key==="siteImages")return {keys:Object.keys(value||{}),gallery_count:Array.isArray(value?.gallery)?value.gallery.length:0};
      if(key==="textOverrides"||key==="styleOverrides")return {entries:Object.keys(value||{}).length};
      if(typeof value==="string"||typeof value==="boolean"||typeof value==="number")return value;
      return {type:Array.isArray(value)?"array":typeof value};
    };
    const r = await fetch(base + "/rest/v1/site_settings?on_conflict=key", { method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
    if (!r.ok) { console.error("Settings write failed:", r.status, (await r.text()).slice(0, 500)); return res.status(502).json({ error: "Could not save settings" }); }
    const auditRows=changedRows.map(row=>({
      actor_discord_id:user.id,actor_name:user.displayName||user.username,action:"update",
      entity_type:"site_setting",entity_id:row.key,
      details:{type:"تعديل إعدادات الموقع",detail:"تم تحديث إعداد الموقع: "+row.key,setting_key:row.key,
        before_summary:previousByKey.has(row.key)?summarizeSetting(row.key,previousByKey.get(row.key)):null,
        after_summary:summarizeSetting(row.key,row.value)}
    }));
    let auditLogOk=true;
    if(auditRows.length){
      const auditResponse=await fetch(base+"/rest/v1/audit_logs",{method:"POST",headers:{...headers,Prefer:"return=minimal"},body:JSON.stringify(auditRows)});
      if(!auditResponse.ok){auditLogOk=false;console.error("Settings audit write failed:",auditResponse.status,(await auditResponse.text()).slice(0,300));}
      else await forwardAuditEventsToDiscord(auditRows);
    }
    return res.status(200).json({ ok: true,audit_logged_count:auditRows.length,audit_log_ok:auditLogOk });
  } catch (e) { console.error("Settings API failed:", e?.message || "unknown"); return res.status(500).json({ error: "Settings service failed" }); }
}