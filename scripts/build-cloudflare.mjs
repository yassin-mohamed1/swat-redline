import { mkdir, copyFile, rm } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "swat-redline-logo.svg", "bot-command-center.html", "bot-command-center-app.js", "bot-command-center-launcher.js", "redline-operator-template.png"]) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(file, output));
}
await copyFile(new URL("../bot/welcome-nameplate.jpg", import.meta.url), new URL("welcome-nameplate.jpg", output));

console.log("Cloudflare static assets prepared: portal, logo, and bot command center assets.");
