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

  assert.match(path, /moveTo\(1474,190\)/);
  assert.match(path, /lineTo\(1883,571\)/);
  assert.match(cover, /unitCardAvatarPath\(ctx\);ctx\.clip\(\)/);

  const templateLayer = renderer.indexOf("context.drawImage(unitCardTemplateImage,0,0,2048,768)");
  const apertureFill = renderer.indexOf("unitCardAvatarPath(context);context.fill()");
  const avatarLayer = renderer.indexOf("unitCardCoverImage(context,avatar,unitCardDesign.avatar)");
  const nameLayer = renderer.indexOf("unitCardDrawText(context,values.name");

  assert.ok(templateLayer >= 0, "card template is painted");
  assert.ok(apertureFill > templateLayer, "only the inner photo window is cleared for the image");
  assert.ok(avatarLayer > apertureFill, "avatar is drawn inside the cleared window");
  assert.ok(nameLayer > avatarLayer, "member details remain above the photo and frame");
});
