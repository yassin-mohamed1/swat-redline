import { mkdir, copyFile, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "swat-redline-logo.svg"]) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(file, output));
}

console.log("Cloudflare static assets prepared: index.html and swat-redline-logo.svg");
