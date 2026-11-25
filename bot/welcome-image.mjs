import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 675;
const MAX_REMOTE_IMAGE_BYTES = 6 * 1024 * 1024;
const DEFAULT_TEMPLATE_PATH = new URL("./welcome-template.png", import.meta.url);
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"
]);

const FONT_FAMILIES = Object.freeze({
  condensed: '"Roboto Condensed", "Noto Sans Condensed", "Arial Narrow", "Noto Sans Arabic", Arial, sans-serif',
  discord: 'Inter, "Noto Sans Arabic", Arial, sans-serif',
  inter: 'Inter, "Noto Sans Arabic", Arial, sans-serif',
  arabic: '"Noto Sans Arabic", "Noto Sans", Arial, sans-serif',
  serif: 'Georgia, "Noto Naskh Arabic", serif'
});

let defaultTemplateBuffer = null;

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 0 && address.split(".")[2] === "2") ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && address.split(".")[2] === "113");
  }
  if (version === 6) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
      value.startsWith("fe80:") || value.startsWith("ff") || value.startsWith("2001:db8:") ||
      value.startsWith("::ffff:");
  }
  return true;
}

async function validateRemoteImageUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname) ||
      !url.hostname.includes(".") || /(^|\.)(localhost|local|internal|test)$/i.test(url.hostname)) {
    throw new Error("welcome_image_url_not_public_https");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error("welcome_image_host_not_public");
  }
  return url;
}

async function readBoundedBody(response) {
  const announcedLength = Number(response.headers.get("content-length") || 0);
  if (announcedLength > MAX_REMOTE_IMAGE_BYTES) throw new Error("welcome_image_too_large");
  if (!response.body) throw new Error("welcome_image_empty");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REMOTE_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("welcome_image_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error("welcome_image_empty");
  return Buffer.concat(chunks, total);
}

async function fetchImage(value) {
  const url = await validateRemoteImageUrl(value);
  const response = await fetch(url, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error("welcome_image_fetch_failed_" + response.status);
  const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error("welcome_image_type_not_allowed");
  return readBoundedBody(response);
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function substitute(text, member, userValue = member.displayName || member.username || "New member") {
  const values = {
    user: String(userValue),
    username: String(member.displayName || member.username || "New member"),
    server: String(member.serverName || "S.W.A.T. REDLINE"),
    membercount: String(member.memberCount ?? "")
  };
  return String(text || "").replace(/\{\{(user|username|server|memberCount)\}\}/gi, (token, key) => {
    return values[key.toLowerCase()] || "";
  });
}

function shortText(value, max = 42) {
  const text = Array.from(String(value || "").replace(/[\r\n]+/g, " ").trim());
  return text.length > max ? text.slice(0, max - 1).join("") + "…" : text.join("");
}

function colorOverlay(image) {
  const opacity = Math.max(0, Math.min(70, Number(image.overlayOpacity) || 0)) / 100;
  const color = /^#[0-9a-f]{6}$/i.test(image.overlayColor || "") ? image.overlayColor : "#05070b";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect width="100%" height="100%" fill="${color}" fill-opacity="${opacity}"/>
  </svg>`);
}

function contentSvg(image, member) {
  const coordinate = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : fallback;
  };
  const bounded = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const avatarX = WIDTH * coordinate(image.avatarX, 82.8) / 100;
  const avatarY = HEIGHT * coordinate(image.avatarY, 40.9) / 100;
  const avatarSize = WIDTH * bounded(image.avatarSize, 17.2, 8, 35) / 100;
  const nameX = WIDTH * coordinate(image.nameX, 51.1) / 100;
  const nameY = HEIGHT * coordinate(image.nameY, 58) / 100;
  const configuredNameWidth = WIDTH * bounded(image.nameWidth, 23.5, 10, 65) / 100;
  const nameWidth = image.template === "redline-operator"
    ? Math.min(configuredNameWidth, WIDTH * 0.235)
    : configuredNameWidth;
  const requestedNameSize = WIDTH * bounded(image.nameSize, 4.8, 2, 10) / 100;
  const fontFamily = FONT_FAMILIES[image.font] || FONT_FAMILIES.condensed;
  const name = shortText(String(member.displayName || member.username || "New member").toLocaleUpperCase(), 48);
  const nameLength = Math.max(1, Array.from(name).length);
  const nameFont = Math.max(18, requestedNameSize);
  const plateWidth = 420;
  const plateHeight = 102;
  const nameTextLength = Math.max(36, Math.min(nameWidth, plateWidth - 145, nameFont * nameLength * 0.48));
  const naturalNameWidth = nameFont * nameLength * 0.57 + nameLength * 1.1;
  const nameScale = Math.min(1, nameTextLength / Math.max(1, naturalNameWidth));
  const color = /^#[0-9a-f]{6}$/i.test(image.nameColor || "") ? image.nameColor : "#f1f3f4";
  const avatarClip = `<clipPath id="memberAvatar"><circle cx="${avatarX}" cy="${avatarY}" r="${avatarSize / 2}"/></clipPath>`;
  const shadow = `<filter id="nameShadow" x="-30%" y="-70%" width="160%" height="240%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity=".92"/></filter>`;
  const plateLeft = nameX - WIDTH * 0.051 - plateWidth / 2;
  const plateTop = nameY - plateHeight / 2;
  const plate = image.template === "redline-operator" ? `<g transform="translate(${plateLeft} ${plateTop})">
    <defs>
      <linearGradient id="plateMetal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#181b1f"/><stop offset=".48" stop-color="#080a0d"/><stop offset="1" stop-color="#14171a"/></linearGradient>
      <pattern id="plateWeave" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)"><path d="M0 1H8M0 5H8" stroke="#d8dce0" stroke-opacity=".065" stroke-width=".7"/><path d="M0 3H8M0 7H8" stroke="#000" stroke-opacity=".34" stroke-width=".7"/></pattern>
    </defs>
    <path d="M5 12L416 20L405 91L0 82Z" fill="#050608" stroke="#353a3e" stroke-width="7"/>
    <path d="M9 15L411 23L401 87L5 78Z" fill="url(#plateMetal)" stroke="#a41e2a" stroke-width="1.4"/>
    <path d="M9 15L411 23L401 87L5 78Z" fill="url(#plateWeave)" opacity=".8"/>
    <path d="M12 18L407 26M8 76L398 84" fill="none" stroke="#e62b3a" stroke-width="2.1" stroke-dasharray="5 3"/>
    <path d="M111 18L105 81" stroke="#9d1b27" stroke-width="1.7"/>
    <g transform="translate(56 51)" fill="none" stroke="#d7dade" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
      <circle r="29" stroke="#899098" stroke-width="1.25" opacity=".9"/>
      <path d="M0-22L4-11L2 12L0 24L-2 12L-4-11Z" fill="#d6dade" stroke="#f2f3f4" stroke-width="1.1"/>
      <path d="M-13-7H13L8-2H-8Z" fill="#b9bec3"/>
      <path d="M-2-12L0-20L2-12M-3 18H3M-1 22H1"/>
      <path d="M-8-6C-18-15-27-14-34-20C-30-11-23-7-17-4C-25-5-32-2-37 3C-27 3-19 1-10-1M8-6C18-15 27-14 34-20C30-11 23-7 17-4C25-5 32-2 37 3C27 3 19 1 10-1"/>
      <path d="M-19-5L-25-10M-24 0L-32-1M19-5L25-10M24 0L32-1" stroke-width="1.3"/>
    </g>
  </g>` : "";
  const nameMetal = `<linearGradient id="nameMetal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff"/><stop offset=".28" stop-color="${color}"/><stop offset=".52" stop-color="#fff" stop-opacity=".9"/><stop offset=".63" stop-color="${color}"/><stop offset="1" stop-color="${color}"/></linearGradient>`;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>${avatarClip}${shadow}${nameMetal}</defs>
    ${plate}
    <image href="data:image/png;base64,${member.avatarBase64}" x="${avatarX - avatarSize / 2}" y="${avatarY - avatarSize / 2}" width="${avatarSize}" height="${avatarSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#memberAvatar)"/>
    <g transform="translate(${nameX} 0) scale(${nameScale} 1) translate(${-nameX} 0)"><text x="${nameX}" y="${nameY}" fill="url(#nameMetal)" stroke="#16191d" stroke-width="1.2" paint-order="stroke fill" font-family="${escapeXml(fontFamily)}" font-size="${nameFont}" font-weight="900" letter-spacing="1.1" text-anchor="middle" dominant-baseline="central" filter="url(#nameShadow)">${escapeXml(name)}</text></g>
  </svg>`);
}

export function renderWelcomeText(template, member) {
  const mention = `<@${String(member.id || "")}>`;
  return substitute(template, member, mention).trim().slice(0, 1800);
}

export async function renderWelcomeImage(imageSettings = {}, member = {}) {
  const image = imageSettings && typeof imageSettings === "object" ? imageSettings : {};
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(image.backgroundColor || "") ? image.backgroundColor : "#11151d";
  let background = await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 4, background: backgroundColor }
  }).png().toBuffer();

  if (image.template === "redline-operator") {
    try {
      defaultTemplateBuffer ||= await readFile(DEFAULT_TEMPLATE_PATH);
      background = await sharp(defaultTemplateBuffer, { limitInputPixels: 40_000_000 })
        .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();
    } catch (error) {
      console.warn("Welcome banner template could not be loaded:", error?.message || "unknown");
    }
  } else if (image.backgroundImageUrl) {
    try {
      const remote = await fetchImage(image.backgroundImageUrl);
      background = await sharp(remote, { limitInputPixels: 40_000_000 })
        .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();
    } catch (error) {
      console.warn("Welcome background image could not be loaded:", error?.message || "unknown");
    }
  }

  let avatarBuffer;
  try {
    avatarBuffer = await fetchImage(member.avatarUrl);
  } catch {
    avatarBuffer = await fetchImage("https://cdn.discordapp.com/embed/avatars/0.png");
  }
  const resizedAvatar = await sharp(avatarBuffer, { limitInputPixels: 40_000_000 })
    .resize(192, 192, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  const renderMember = {
    ...member,
    avatarBase64: resizedAvatar.toString("base64")
  };
  const output = await sharp(background, { limitInputPixels: 40_000_000 })
    .composite([
      { input: colorOverlay(image) },
      { input: contentSvg(image, renderMember) }
    ])
    .png({ compressionLevel: 8 })
    .toBuffer();
  return output;
}
