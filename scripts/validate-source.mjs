import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const root = process.cwd();

async function walk(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function checkModule(path, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("JavaScript syntax error in " + path + ":\n" + (result.stderr || result.stdout));
  }
}

const sourceFiles = [
  ...(await walk("api")).filter(path => path.endsWith(".js")),
  ...(await walk("lib")).filter(path => path.endsWith(".js"))
];

for (const path of sourceFiles) checkModule(path, await readFile(join(root, path), "utf8"));

const htmlPath = "index.html";
const html = await readFile(join(root, htmlPath), "utf8");
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1]) && match[2].trim());

if (!inlineScripts.length) throw new Error("No inline application script found in index.html.");
for (let i = 0; i < inlineScripts.length; i++) {
  checkModule(htmlPath + " inline script #" + (i + 1), inlineScripts[i][2]);
}

JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));

const migrationFiles = (await walk("supabase/migrations")).filter(path => path.endsWith(".sql"));
const versions = migrationFiles.map(path => path.split("/").pop().split("_")[0]);
if (new Set(versions).size !== versions.length) {
  throw new Error("Duplicate Supabase migration version found.");
}

console.log("Source validation passed.");
console.log("API/library modules checked: " + sourceFiles.length);
console.log("Inline portal scripts checked: " + inlineScripts.length);
console.log("Supabase migration files checked: " + migrationFiles.length);
