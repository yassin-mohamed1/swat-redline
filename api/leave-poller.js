import { handleLeaveRequestPoller } from "../lib/leave-poller.js";

export default async function handler(req, res) {
  return handleLeaveRequestPoller(req, res);
}
