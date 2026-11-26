import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("member avatar is drawn inside the expanded card photo opening", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pathStart = html.indexOf("function unitCardAvatarPath(ctx)");
  const coverStart = html.indexOf("function unitCardCoverImage(ctx,image,settings)");
  const paintStart = html.indexOf("async function unitCardPaint(");
  const previewStart = html.indexOf("\\nasync function drawUnitCardEditorPreview", paintStart);

  assert.ok(pathStart >= 0 && coverStart > pathStart);
  assert.ok(paintStart >= 0 && previewStart > paintStart);
  const path = html.slice(pathStart, coverStart);
  const cover = html.slice(coverStart, html.indexOf("\\nfunction unitCardDrawText", coverStart));
  const renderer = html.slice(paintStart, previewStart);

  assert.ok(path.includes("moveTo(1440,130)"));
  assert.ok(path.includes("lineTo(1920,615)"));
  assert.ok(cover.includes("const frame={x:1415,y:130,width:505,height:510}"));
  assert.ok(cover.includes("unitCardAvatarPath(ctx);ctx.clip()"));

  const templateLayer = renderer.indexOf("context.drawImage(unitCardTemplateImage,0,0,2048,768)");
  const aperturePath = renderer.indexOf("unitCardAvatarPath(context)");
  const apertureFill = renderer.indexOf("context.fill()", aperturePath);
  const avatarLayer = renderer.indexOf("unitCardCoverImage(context,avatar,unitCardDesign.avatar)");
  const nameLayer = renderer.indexOf("unitCardDrawText(context,values.name");
  assert.ok(templateLayer >= 0);
  assert.ok(aperturePath > templateLayer && apertureFill > aperturePath);
  assert.ok(avatarLayer > apertureFill && nameLayer > avatarLayer);
});

test("saved avatar zoom below 120 percent is normalized to preserve room for panning", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const normalizeStart = html.indexOf("function normalizeUnitCardDesign(value)");
  const normalizeEnd = html.indexOf("\\nfunction unitCardEligibleMembers", normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  const normalizer = html.slice(normalizeStart, normalizeEnd);
  assert.ok(normalizer.includes("avatar.zoom=Math.max(1.2,Math.min(2.5,Number(avatar.zoom)||1.2))"));
  assert.ok(html.includes('id="unitCardAvatarZoom" type="range" min="120" max="250"'));
  assert.ok(html.includes("Math.max(1.2,Math.min(2.5,Number(settings.zoom)||1.2))"));
});

test("avatar drag maps pointer movement to the actual image overflow", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes("const unitCardImageDimensions=new Map()"));
  assert.ok(html.includes("unitCardImageDimensions.set(url,{width:image.naturalWidth||image.width,height:image.naturalHeight||image.height})"));
  assert.ok(html.includes(")-dx*200/overflowX"));
  assert.ok(html.includes(")-dy*200/overflowY"));
  assert.ok(!html.includes(")-dx/3"));
  assert.ok(!html.includes(")-dy/3"));
});
