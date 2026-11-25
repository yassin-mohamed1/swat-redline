import { mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "swat-redline-logo.svg", "bot-command-center.html", "bot-command-center-app.js", "bot-command-center-launcher.js", "redline-operator-template.png"]) {
  await copyFile(new URL(`../${file}`, import.meta.url), new URL(file, output));
}
await copyFile(new URL("../bot/welcome-nameplate.jpg", import.meta.url), new URL("welcome-nameplate.jpg", output));

const welcomeApp = await readFile(new URL("../bot-command-center-app.js", import.meta.url));
const welcomeHtml = await readFile(new URL("../bot-command-center.html", import.meta.url));
await writeFile(
  new URL("../cloudflare/welcome-app-source.js", import.meta.url),
  `export const welcomeAppGzipBase64 = ${JSON.stringify(gzipSync(welcomeApp, { level: 9 }).toString("base64"))};\n` +
    `export const welcomeHtmlGzipBase64 = ${JSON.stringify(gzipSync(welcomeHtml, { level: 9 }).toString("base64"))};\n`,
);

console.log("Cloudflare static assets prepared: portal, logo, and bot command center assets.");
