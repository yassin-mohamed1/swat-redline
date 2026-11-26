import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("member avatar is painted below the unit-card frame overlay", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("async function unitCardPaint(");
  const end = html.indexOf("\nasync function drawUnitCardEditorPreview", start);
  assert.ok(start >= 0 && end > start, "unit-card renderer exists");

  const renderer = html.slice(start, end);
  const avatarLayer = renderer.indexOf("unitCardCoverImage(context,avatar,unitCardDesign.avatar)");
  const frameLayer = renderer.indexOf("context.drawImage(unitCardTemplateImage,0,0,2048,768)");
  const nameLayer = renderer.indexOf("unitCardDrawText(context,values.name");

  assert.ok(avatarLayer >= 0, "member photo layer exists");
  assert.ok(frameLayer > avatarLayer, "frame must be composited after the member photo");
  assert.ok(nameLayer > frameLayer, "member details must remain above the frame");
});
