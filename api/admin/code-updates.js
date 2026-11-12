import crypto from "node:crypto";
import { requireSameOrigin } from "../../lib/request-security.js";
import { validateProjectCodePackage } from "../../lib/project-code.js";

const REPOSITORY = "yassin-mohamed1/swat-redline";
const BRANCH = "main";
const API_BASE = "https://api.github.com";

function parseCookies(header = "") {
  const output = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    try { output[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return output;
}

function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const index = raw.lastIndexOf(".");
  const payload = raw.slice(0, index);
  const signature = raw.slice(index + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const owner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60000 || (!owner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...user, isOwner: owner };
}

function send(res, status, body) {
  return res.status(status).json(body);
}

async function githubRequest(token, path, method = "GET", body = null) {
  const response = await fetch(API_BASE + "/repos/" + REPOSITORY + "/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "SWAT-REDLINE-Code-Center",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 401 ? 503 : response.status === 403 ? 503 : response.status;
    const message = response.status === 401
      ? "The GitHub connection token is invalid or expired."
      : response.status === 403
        ? "GitHub denied the update. Check the token's repository Contents: Read and write permission and rate limit."
        : response.status === 404
          ? "The configured GitHub repository or main branch could not be found."
          : response.status === 422
            ? "GitHub rejected this commit or the main branch changed during the update."
            : "GitHub could not complete the code update.";
    throw Object.assign(new Error(message), { status, githubStatus: response.status, githubMessage: String(payload.message || "").slice(0, 180) });
  }
  return payload;
}

async function commitProjectCodeUpdate(token, update, actor) {
  const ref = await githubRequest(token, "git/ref/heads/" + BRANCH);
  const parentSha = ref?.object?.sha;
  if (!/^[a-f0-9]{40}$/i.test(String(parentSha || ""))) throw Object.assign(new Error("Could not resolve the current main branch head."), { status: 502 });

  const parent = await githubRequest(token, "git/commits/" + parentSha);
  const baseTreeSha = parent?.tree?.sha;
  if (!/^[a-f0-9]{40}$/i.test(String(baseTreeSha || ""))) throw Object.assign(new Error("Could not resolve the current Git tree."), { status: 502 });

  const originalTree = await githubRequest(token, "git/trees/" + baseTreeSha + "?recursive=1");
  if (originalTree.truncated) throw Object.assign(new Error("The repository tree is too large for a safe update. Split the package into smaller updates."), { status: 413 });
  const existingModes = new Map((originalTree.tree || []).map(entry => [entry.path, entry.mode]));
  const treeEntries = [];

  for (const file of update.files) {
    if (file.action === "delete") {
      treeEntries.push({ path: file.path, mode: existingModes.get(file.path) || "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await githubRequest(token, "git/blobs", "POST", { content: file.content, encoding: "utf-8" });
    if (!/^[a-f0-9]{40}$/i.test(String(blob.sha || ""))) throw Object.assign(new Error("GitHub did not return a valid file object for " + file.path + "."), { status: 502 });
    const mode = existingModes.get(file.path) || (file.path.endsWith(".sh") ? "100755" : "100644");
    treeEntries.push({ path: file.path, mode, type: "blob", sha: blob.sha });
  }

  const tree = await githubRequest(token, "git/trees", "POST", { base_tree: baseTreeSha, tree: treeEntries });
  if (!/^[a-f0-9]{40}$/i.test(String(tree.sha || ""))) throw Object.assign(new Error("GitHub did not create the updated project tree."), { status: 502 });

  const cleanSummary = update.summary.replace(/[\r\n]+/g, " ").slice(0, 120);
  const commit = await githubRequest(token, "git/commits", "POST", {
    message: "[SWAT Code Center] " + cleanSummary + " (by " + String(actor || "owner").slice(0, 80) + ")",
    tree: tree.sha,
    parents: [parentSha]
  });
  if (!/^[a-f0-9]{40}$/i.test(String(commit.sha || ""))) throw Object.assign(new Error("GitHub did not create the code commit."), { status: 502 });

  await githubRequest(token, "git/refs/heads/" + BRANCH, "PATCH", { sha: commit.sha, force: false });
  return {
    commitSha: commit.sha,
    commitUrl: "https://github.com/" + REPOSITORY + "/commit/" + commit.sha,
    parentSha,
    files: update.files.map(file => ({ path: file.path, action: file.action }))
  };
}

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = readSession(req);
  if (!user) return send(res, 401, { error: "Authentication required." });
  if (!user.isOwner) return send(res, 403, { error: "Only the portal owner can publish source-code changes." });

  if (req.method === "GET") {
    return send(res, 200, {
      ok: true,
      connected: Boolean(process.env.SWAT_GITHUB_TOKEN),
      repository: REPOSITORY,
      branch: BRANCH,
      mode: "direct-production",
      limits: { maxFiles: 40, maxFileBytes: 262144, maxTotalBytes: 1048576 },
      message: process.env.SWAT_GITHUB_TOKEN
        ? "GitHub publishing is configured. Approved packages commit directly to main and trigger the normal Vercel Production deployment."
        : "GitHub publishing is not configured. Add SWAT_GITHUB_TOKEN as a Vercel Production Secret to enable source-code publishing."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Method not allowed." });
  }
  if (!requireSameOrigin(req, res)) return;

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  if (!["validate", "apply"].includes(body.action)) return send(res, 400, { error: "Action must be validate or apply." });

  let update;
  try { update = validateProjectCodePackage(body.package); }
  catch (error) { return send(res, error.status || 400, { error: error.message || "Invalid code update package." }); }

  if (body.action === "validate") {
    return send(res, 200, {
      ok: true,
      summary: update.summary,
      fileCount: update.files.length,
      totalBytes: update.totalBytes,
      files: update.files.map(file => ({ path: file.path, action: file.action, bytes: file.bytes || 0 })),
      connected: Boolean(process.env.SWAT_GITHUB_TOKEN),
      publishReady: Boolean(process.env.SWAT_GITHUB_TOKEN)
    });
  }

  const token = process.env.SWAT_GITHUB_TOKEN;
  if (!token) {
    return send(res, 503, {
      error: "Code package is valid, but GitHub publishing is not connected yet. Add the protected Vercel Production Secret SWAT_GITHUB_TOKEN with repository Contents: Read and write permission, then redeploy."
    });
  }

  try {
    const result = await commitProjectCodeUpdate(token, update, user.displayName || user.username || user.id);
    console.info("SWAT Code Center commit", JSON.stringify({
      actor: user.id,
      commit: result.commitSha,
      files: result.files.map(file => ({ path: file.path, action: file.action })),
      summary: update.summary
    }));
    return send(res, 200, { ok: true, message: "Project changes committed to main. Vercel Production deployment has been triggered.", ...result });
  } catch (error) {
    console.error("SWAT Code Center publish failed", error?.githubStatus || error?.status || "unknown", error?.message || "unknown");
    return send(res, error.status || 502, { error: error.message || "Could not publish the project update." });
  }
}
