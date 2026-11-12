import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("site update center is nested inside the admin-only settings container", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const owner = html.indexOf('id="ownerSettingsPanels"');
  const panel = html.indexOf('id="siteUpdateImporterPanel"');
  const ownerEnd = html.indexOf('</div></section>', owner);
  assert.ok(owner >= 0 && panel > owner && panel < ownerEnd);
  assert.match(html, /id="siteUpdatePackageInput"/);
  assert.match(html, /previewSiteUpdatePackage\(\)/);
  assert.match(html, /applySiteUpdatePackage\(\)/);
  assert.match(html, /validateSiteUpdatePackage/);
  assert.match(html, /function renderSiteCustomMenus/);
  assert.match(html, /customMenuItems/);
  assert.match(html, /link\.target='_blank'/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /new URL\(button\.url\)/);
});

test("settings API validates the imported visual settings", async () => {
  const api = await readFile(new URL("../api/admin/settings.js", import.meta.url), "utf8");
  assert.match(api, /requireSameOrigin/);
  assert.match(api, /isWebsiteAdmin/);
  assert.match(api, /Invalid text override entry/);
  assert.match(api, /Invalid style override entry/);
  assert.match(api, /Invalid image URL/);
  assert.match(api, /gallery\.length > 40/);
  assert.match(api, /Invalid custom menu item/);
  assert.match(api, /Invalid custom menu button/);
  assert.match(api, /Custom menu buttons require a valid HTTPS URL/);
});
