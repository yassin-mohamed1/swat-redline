import test from "node:test";
import assert from "node:assert/strict";
import { validateProjectCodePackage, PROJECT_CODE_LIMITS } from "../lib/project-code.js";
import { readFile } from "node:fs/promises";

const packageOf = files => ({
  format: "swat-project-code",
  version: 1,
  summary: "Add a test feature",
  files
});

test("project code packages support multi-file frontend, API, test, and SQL changes", () => {
  const result = validateProjectCodePackage(packageOf([
    { path: "index.html", action: "upsert", content: "<main>Portal</main>" },
    { path: "api/example.js", action: "upsert", content: "export default function handler() {}" },
    { path: "tests/example.test.mjs", action: "upsert", content: "import test from 'node:test';" },
    { path: "supabase/migrations/20261113000000_example.sql", action: "upsert", content: "select 1;" },
    { path: "lib/old-helper.js", action: "delete" }
  ]));
  assert.equal(result.files.length, 5);
  assert.equal(result.files[4].action, "delete");
  assert.ok(result.totalBytes > 0);
});

test("project code packages reject traversal, secrets, workflows, and unsupported binary files", () => {
  for (const path of ["../index.html", "/index.html", "api\\escape.js", ".env", ".env.production", ".github/workflows/deploy.yml", "images/logo.png"]) {
    assert.throws(() => validateProjectCodePackage(packageOf([{ path, action: "upsert", content: "text" }])));
  }
  assert.throws(() => validateProjectCodePackage(packageOf([
    { path: "api/example.js", action: "upsert", content: 'const token = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";' }
  ])));
});

test("project code packages enforce unique paths and bounded size", () => {
  assert.throws(() => validateProjectCodePackage(packageOf([
    { path: "api/a.js", action: "upsert", content: "one" },
    { path: "API/a.js", action: "upsert", content: "two" }
  ])));
  assert.throws(() => validateProjectCodePackage(packageOf([
    { path: "api/large.js", action: "upsert", content: "x".repeat(PROJECT_CODE_LIMITS.maxFileBytes + 1) }
  ])));
  assert.throws(() => validateProjectCodePackage({ format: "wrong", version: 1, summary: "x", files: [] }));
});

test("Code Center publishing is owner-only, same-origin protected, and writes only to main", async () => {
  const api = await readFile(new URL("../api/admin/settings.js", import.meta.url), "utf8");
  const publisher = await readFile(new URL("../lib/project-code.js", import.meta.url), "utf8");
  assert.match(api, /if \(!user\.isOwner\)/);
  assert.match(api, /requireSameOrigin/);
  assert.match(api, /SWAT_GITHUB_TOKEN/);
  assert.match(api, /const codeCenterUrl/);
  assert.match(api, /publishProjectCodePackage/);
  assert.match(publisher, /force: false/);
  assert.doesNotMatch(api, /eval\s*\(|new Function\s*\(/);
});
