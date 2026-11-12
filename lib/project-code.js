const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".html", ".css", ".json", ".md", ".sql",
  ".svg", ".yml", ".yaml", ".txt", ".xml", ".toml", ".sh",
  ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".gitignore", ".gitattributes"
]);
const ALLOWED_EXTENSIONLESS = new Set(["README", "Makefile", "Dockerfile", ".gitignore", ".gitattributes"]);
const CODE_CENTER_FILES = new Set([
  "api/admin/code-updates.js",
  "lib/project-code.js",
  "tests/project-code.test.mjs"
]);

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function validateProjectPath(rawPath, action) {
  if (typeof rawPath !== "string" || !rawPath || rawPath.length > 240) fail("Each file needs a valid repository path (max 240 characters).");
  const path = rawPath.trim();
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("%")) {
    fail("Absolute paths, backslashes, null bytes, and encoded paths are not allowed.");
  }
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith("~"))) fail("Path traversal is not allowed.");
  const lower = path.toLowerCase();
  if (/(^|\/)\.env(?:$|\.)/i.test(path) || /(^|\/)(?:secrets?|credentials?)(?:\/|$)/i.test(path) ||
      /\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore)$/i.test(path)) {
    fail("Secret files, environment files, and private keys cannot be edited through the Code Center.");
  }
  if (/(^|\/)(?:\.git|\.vercel|node_modules)(?:\/|$)/i.test(path)) fail("Internal tool and dependency folders are protected.");
  if (lower.startsWith(".github/workflows/") || lower === ".github/workflows") {
    fail("GitHub Actions workflow files are protected from browser-based updates.");
  }
  if (CODE_CENTER_FILES.has(path)) fail("The Code Center engine files are protected from self-modification.");
  if (action === "delete" && ["index.html", "vercel.json"].includes(path)) {
    fail("Critical deployment entry files cannot be deleted. They may be updated instead.");
  }
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(extension) && !ALLOWED_EXTENSIONLESS.has(name)) {
    fail("Unsupported file type for " + path + ". Only text/source files are accepted; binary assets must use the media upload flow.");
  }
  return path;
}

function containsLikelySecret(value) {
  return /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(value) ||
    /(?:SUPABASE_SERVICE_ROLE_KEY|DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|SESSION_SECRET|SWAT_GITHUB_TOKEN)\s*[:=]\s*["'`][^"'`\n]{12,}["'`]/i.test(value);
}

export function validateProjectCodePackage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("The project update package must be a JSON object.");
  const allowedKeys = new Set(["format", "version", "summary", "files"]);
  if (Object.keys(input).some(key => !allowedKeys.has(key))) fail("Unknown package field. Allowed fields are format, version, summary, and files.");
  if (input.format !== "swat-project-code" || input.version !== 1) fail("Unsupported package format. Expected swat-project-code version 1.");
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary || summary.length > 140) fail("Add a short summary (1–140 characters) for the code update.");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    fail("A package must contain between 1 and " + MAX_FILES + " file changes.");
  }

  const seen = new Set();
  let totalBytes = 0;
  const files = input.files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("File change #" + (index + 1) + " is invalid.");
    if (Object.keys(entry).some(key => !["path", "action", "content"].includes(key))) fail("File change #" + (index + 1) + " has unsupported fields.");
    const action = entry.action;
    if (!["upsert", "delete"].includes(action)) fail("File change #" + (index + 1) + " must use action upsert or delete.");
    const path = validateProjectPath(entry.path, action);
    const key = path.toLowerCase();
    if (seen.has(key)) fail("The package contains the same path more than once: " + path);
    seen.add(key);

    if (action === "delete") {
      if ("content" in entry) fail("Delete actions must not include file content: " + path);
      return { path, action };
    }
    if (typeof entry.content !== "string") fail("Upsert actions require text content: " + path);
    const bytes = Buffer.byteLength(entry.content, "utf8");
    if (bytes > MAX_FILE_BYTES) fail("File exceeds 256 KB: " + path);
    if (containsLikelySecret(entry.content)) fail("A likely credential or private key was detected in " + path + ". Keep secrets in protected environment variables.");
    totalBytes += bytes;
    return { path, action, content: entry.content, bytes };
  });
  if (totalBytes > MAX_TOTAL_BYTES) fail("The combined source content exceeds 1 MB.");
  return { format: "swat-project-code", version: 1, summary, files, totalBytes };
}

export const PROJECT_CODE_LIMITS = Object.freeze({
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES
});


const GITHUB_REPOSITORY = "yassinymb2009/swat-redline";
const GITHUB_API_BASE = "https://api.github.com";

async function githubRequest(token, path, method = "GET", body = null) {
  const response = await fetch(GITHUB_API_BASE + "/repos/" + GITHUB_REPOSITORY + "/" + path, {
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

export async function publishProjectCodePackage(token, update, actor) {
  if (typeof token !== "string" || token.length < 20) throw Object.assign(new Error("GitHub publishing is not configured."), { status: 503 });
  const branch = "main";
  const ref = await githubRequest(token, "git/ref/heads/" + branch);
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
  const cleanActor = String(actor || "owner").replace(/[\r\n]+/g, " ").slice(0, 80);
  const commit = await githubRequest(token, "git/commits", "POST", {
    message: "[SWAT Code Center] " + cleanSummary + " (by " + cleanActor + ")",
    tree: tree.sha,
    parents: [parentSha]
  });
  if (!/^[a-f0-9]{40}$/i.test(String(commit.sha || ""))) throw Object.assign(new Error("GitHub did not create the code commit."), { status: 502 });

  await githubRequest(token, "git/refs/heads/" + branch, "PATCH", { sha: commit.sha, force: false });
  return {
    commitSha: commit.sha,
    commitUrl: "https://github.com/" + GITHUB_REPOSITORY + "/commit/" + commit.sha,
    parentSha,
    files: update.files.map(file => ({ path: file.path, action: file.action }))
  };
}
