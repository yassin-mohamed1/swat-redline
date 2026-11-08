import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { forwardAuditToDiscord } from "../../lib/audit-log.js";

function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const i = part.indexOf("=");
    return i < 0 ? ["", ""] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([k]) => k));
  const raw = cookies.swat_session;
  if (!raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), signature = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000) return null;
    return user;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireSameOrigin(req, res)) return;
  const user = readSession(req);
  if (user && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const response = await fetch(base + "/rest/v1/staff_login_events", {
        method: "POST",
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          discord_user_id: user.id,
          display_name: user.displayName || user.username || "Discord user",
          event_type: "logout",
          session_issued_at: user.issuedAt,
          occurred_at: new Date().toISOString()
        })
      });
      if (!response.ok) console.error("Staff logout event failed:", response.status, (await response.text()).slice(0, 250));
      const auditKey="logout:"+user.id+":"+user.issuedAt;
      const auditResponse=await fetch(base+"/rest/v1/audit_logs?on_conflict=event_key",{
        method:"POST",
        headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json",Prefer:"resolution=ignore-duplicates,return=representation"},
        body:JSON.stringify({event_key:auditKey,actor_discord_id:user.id,actor_name:user.displayName||user.username||"Discord user",action:"logout",
          entity_type:"authentication",entity_id:user.id,
          details:{type:"تسجيل خروج",detail:"سجل "+(user.displayName||user.username||"Discord user")+" الخروج من بوابة S.W.A.T. REDLINE."}})
      });
      if(!auditResponse.ok)console.error("Logout audit event failed:",auditResponse.status,(await auditResponse.text()).slice(0,250));
      else {
        const inserted=await auditResponse.json().catch(()=>[]);
        if(inserted.length)await forwardAuditToDiscord(user,{action:"logout",entity_type:"authentication",entity_id:user.id,
          details:{type:"تسجيل خروج",detail:"سجل "+(user.displayName||user.username||"المستخدم")+" الخروج من بوابة S.W.A.T. REDLINE."}});
      }
    } catch (error) {
      console.error("Staff logout event failed:", error instanceof Error ? error.message : "unknown");
    }
  }

  res.setHeader("Set-Cookie", [
    "swat_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "discord_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ]);
  return res.status(200).json({ ok: true, redirect: "/" });
}
