import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("member avatar remains visible inside the card frame without covering its border", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pathStart = html.indexOf("function unitCardAvatarPath(ctx)");
  const coverStart = html.indexOf("function unitCardCoverImage(ctx,image,settings)");
  const paintStart = html.indexOf("async function unitCardPaint(");
  const previewStart = html.indexOf("\nasync function drawUnitCardEditorPreview", paintStart);

  assert.ok(pathStart >= 0 && coverStart > pathStart, "dedicated inner photo aperture exists");
  assert.ok(paintStart >= 0 && previewStart > paintStart, "unit-card renderer exists");

  const path = html.slice(pathStart, coverStart);
  const cover = html.slice(coverStart, html.indexOf("\nfunction unitCardDrawText", coverStart));
  const renderer = html.slice(paintStart, previewStart);

  assert.match(path, /moveTo\(1454,155\)/);
  assert.match(path, /lineTo\(1904,591\)/);
  assert.match(cover, /unitCardAvatarPath\(ctx\);ctx\.clip\(\)/);

  const templateLayer = renderer.indexOf("context.drawImage(unitCardTemplateImage,0,0,2048,768)");
  const aperturePath = renderer.indexOf("unitCardAvatarPath(context)");
  const apertureFill = renderer.indexOf("context.fill()", aperturePath);
  const avatarLayer = renderer.indexOf("unitCardCoverImage(context,avatar,unitCardDesign.avatar)");
  const nameLayer = renderer.indexOf("unitCardDrawText(context,values.name");

  assert.ok(templateLayer >= 0, "card template is painted");
  assert.ok(aperturePath > templateLayer && apertureFill > aperturePath, "only the inner photo window receives its background fill");
  assert.ok(avatarLayer > apertureFill, "avatar is drawn inside the cleared window");
  assert.ok(nameLayer > avatarLayer, "member details remain above the photo and frame");
});

test("saved avatar zoom below 100 percent is normalized to fill the photo window", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const normalizeStart = html.indexOf("function normalizeUnitCardDesign(value)");
  const normalizeEnd = html.indexOf("\nfunction unitCardEligibleMembers", normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, "saved design normalizer exists");

  const normalizer = html.slice(normalizeStart, normalizeEnd);
  assert.match(normalizer, /avatar\.zoom=Math\.max\(1,Math\.min\(2\.5,Number\(avatar\.zoom\)\|\|1\)\)/);
  assert.match(html, /id="unitCardAvatarZoom" type="range" min="100" max="250"/);
  assert.match(html, /Math\.max\(1,Math\.min\(2\.5,Number\(settings\.zoom\)\|\|1\)\)/);
});

test("photo aperture expands to the inner frame instead of leaving a thick black inset", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("function unitCardCoverImage(ctx,image,settings)");
  const end = html.indexOf("\nfunction unitCardDrawText", start);
  assert.ok(start >= 0 && end > start, "avatar cover renderer exists");
  const cover = html.slice(start, end);
  assert.match(cover, /const frame=\{x:1430,y:155,width:474,height:460\}/);
  assert.match(cover, /unitCardAvatarPath\(ctx\);ctx\.clip\(\)/);
});
