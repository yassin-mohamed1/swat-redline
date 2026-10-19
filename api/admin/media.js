import crypto from "node:crypto";

function cookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
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
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  if (!user.isOwner) return res.status(403).json({ error: "Owner permission required" });
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const base = process.env.SUPABASE_URL?.replace(/\/+$/, ""), key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: "Database is not configured" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const mimeToExt = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
    const mime = String(body.contentType || "").toLowerCase();
    if (!mimeToExt[mime]) return res.status(400).json({ error: "اختر صورة بصيغة JPG أو PNG أو WEBP أو GIF." });
    if (typeof body.base64 !== "string" || !body.base64 || body.base64.length > 2_900_000) return res.status(413).json({ error: "حجم الصورة كبير. الحد الأقصى 2MB." });
    const bytes = Buffer.from(body.base64, "base64");
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return res.status(413).json({ error: "حجم الصورة يجب ألا يتجاوز 2MB." });
    const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
    const bucketUrl = base + "/storage/v1/bucket/site-media";
    let bucket = await fetch(bucketUrl, { headers });
    if (bucket.status === 404) {
      bucket = await fetch(base + "/storage/v1/bucket", { method: "POST", headers, body: JSON.stringify({ id: "site-media", name: "site-media", public: true, file_size_limit: 2097152, allowed_mime_types: Object.keys(mimeToExt) }) });
      if (!bucket.ok && bucket.status !== 409) {
        console.error("Site media bucket creation failed:", bucket.status, (await bucket.text()).slice(0, 400));
        return res.status(502).json({ error: "تعذر تجهيز مساحة الصور في التخزين. تأكد من إعدادات Supabase Storage." });
      }
    } else if (!bucket.ok) {
      console.error("Site media bucket lookup failed:", bucket.status, (await bucket.text()).slice(0, 300));
      return res.status(502).json({ error: "تعذر التحقق من مساحة تخزين الصور." });
    }
    const objectPath = "site/" + Date.now() + "-" + crypto.randomUUID() + "." + mimeToExt[mime];
    const upload = await fetch(base + "/storage/v1/object/site-media/" + objectPath, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": mime, "x-upsert": "true", "Cache-Control": "31536000" },
      body: bytes
    });
    if (!upload.ok) {
      console.error("Site media upload failed:", upload.status, (await upload.text()).slice(0, 500));
      return res.status(502).json({ error: "فشل رفع الصورة إلى التخزين. حاول مرة أخرى." });
    }
    return res.status(200).json({ ok: true, url: base + "/storage/v1/object/public/site-media/" + objectPath });
  } catch (e) {
    console.error("Site media API failed:", e?.message || "unknown");
    return res.status(400).json({ error: "تعذر قراءة الصورة المرسلة." });
  }
}
