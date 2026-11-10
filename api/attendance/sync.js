import { handleAttendancePoller } from "../../lib/attendance-poller.js";

export default async function handler(req, res) {
  return handleAttendancePoller(req, res);
}
