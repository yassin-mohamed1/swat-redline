export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const base = process.env.SUPABASE_URL?.replace(/\\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: "Site image settings are unavailable" });
  try {
    const response = await fetch(base + "/rest/v1/site_settings?key=eq.siteImages&select=value&limit=1", {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!response.ok) {
      console.error("Public site image settings read failed:", response.status, (await response.text()).slice(0, 300));
      return res.status(502).json({ error: "Could not load site images" });
    }
    const rows = await response.json();
    const value = rows[0]?.value && typeof rows[0].value === "object" ? rows[0].value : {};
    const legacy = typeof value.logo === "string" ? value.logo : "";
    return res.status(200).json({
      siteImages: {
        logoSidebar: typeof value.logoSidebar === "string" ? value.logoSidebar : legacy,
        logoLoading: typeof value.logoLoading === "string" ? value.logoLoading : legacy,
        logoLogin: typeof value.logoLogin === "string" ? value.logoLogin : legacy
      }
    });
  } catch (error) {
    console.error("Public site image settings failed:", error?.message || "unknown");
    return res.status(500).json({ error: "Could not load site images" });
  }
}
