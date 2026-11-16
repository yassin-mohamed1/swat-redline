export default async function handler(req, res) {
  try {
    const poller = await import("../lib/attendance-poller.mjs");
    return await poller.handleAttendancePoller(req, res);
  } catch (error) {
    console.error("Attendance poller module failed to load:", error?.message || "unknown");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ error: "Attendance poller could not be loaded." });
  }
}
