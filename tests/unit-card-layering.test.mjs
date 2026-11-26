import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("member photo stays visible through the exact card-frame aperture", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const pathStart = html.indexOf("function unitCardPhotoPath(ctx)");
  const overlayStart = html.indexOf("function unitCardFrameOverlay()");
  const coverStart = html.indexOf("function unitCardCoverImage(ctx,image,settings)");
  const paintStart = html.indexOf("async function unitCardPaint(");
  const previewStart = html.indexOf("\nasync function drawUnitCardEditorPreview", paintStart);

  assert.ok(pathStart >= 0 && overlayStart > pathStart && coverStart > overlayStart);
  assert.ok(paintStart > coverStart && previewStart > paintStart);
  assert.ok(html.includes("const UNIT_CARD_PHOTO_FRAME=Object.freeze({x:1401,y:127,width:570,height:516})"));

  const path = html.slice(pathStart, overlayStart);
  const overlay = html.slice(overlayStart, coverStart);
  const cover = html.slice(coverStart, html.indexOf("\nfunction unitCardDrawText", coverStart));
  const renderer = html.slice(paintStart, previewStart);

  assert.ok(path.includes("moveTo(1401,191)"));
  assert.ok(path.includes("lineTo(1970,590)"));
  assert.ok(overlay.includes("globalCompositeOperation='destination-out'"));
  assert.ok(overlay.includes("unitCardPhotoPath(overlayContext);overlayContext.fill()"));
  assert.ok(cover.includes("const frame=UNIT_CARD_PHOTO_FRAME"));
  assert.ok(cover.includes("unitCardPhotoPath(ctx);ctx.clip()"));

  const avatarLayer = renderer.indexOf("unitCardCoverImage(context,avatar,unitCardDesign.avatar)");
  const frameLayer = renderer.indexOf("context.drawImage(unitCardFrameOverlay(),0,0,2048,768)");
  const nameLayer = renderer.indexOf("unitCardDrawText(context,values.name");
  assert.ok(avatarLayer >= 0 && frameLayer > avatarLayer, "photo must be drawn before the frame overlay");
  assert.ok(nameLayer > frameLayer, "member name remains above the frame");
});

test("saved avatar zoom below 120 percent is normalized to preserve room for panning", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const normalizeStart = html.indexOf("function normalizeUnitCardDesign(value)");
  const normalizeEnd = html.indexOf("\nfunction unitCardEligibleMembers", normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
  const normalizer = html.slice(normalizeStart, normalizeEnd);
  assert.ok(normalizer.includes("avatar.zoom=Math.max(1.2,Math.min(2.5,Number(avatar.zoom)||1.2))"));
  assert.ok(html.includes('id="unitCardAvatarZoom" type="range" min="120" max="250"'));
  assert.ok(html.includes("Math.max(1.2,Math.min(2.5,Number(settings.zoom)||1.2))"));
});

test("avatar drag uses the same full photo viewport as rendering", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes("const unitCardImageDimensions=new Map()"));
  assert.ok(html.includes("unitCardImageDimensions.set(url,{width:image.naturalWidth||image.width,height:image.naturalHeight||image.height})"));
  assert.ok(html.includes("frame=UNIT_CARD_PHOTO_FRAME"));
  assert.ok(html.includes(")-dx*200/overflowX"));
  assert.ok(html.includes(")-dy*200/overflowY"));
  assert.ok(!html.includes("frame={width:490,height:485}"));
  assert.ok(!html.includes(")-dx/3"));
  assert.ok(!html.includes(")-dy/3"));
});
