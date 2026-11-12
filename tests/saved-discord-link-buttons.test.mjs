import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDiscordLinkButtons,
  buildDiscordLinkComponents
} from "../lib/saved-discord-messages.js";

test("valid HTTPS links are normalized and retained as labeled buttons", () => {
  const buttons = normalizeDiscordLinkButtons([
    { label: "YouTube", url: "https://www.youtube.com/" },
    { label: "S.W.A.T. Website", url: "https://swat-redline.vercel.app" }
  ]);
  assert.deepEqual(buttons, [
    { label: "YouTube", url: "https://www.youtube.com/" },
    { label: "S.W.A.T. Website", url: "https://swat-redline.vercel.app/" }
  ]);
});

test("Discord link buttons are emitted as style 5 buttons in action rows of five", () => {
  const buttons = Array.from({ length: 7 }, (_, index) => ({
    label: "Link " + (index + 1),
    url: "https://example.com/" + index
  }));
  const rows = buildDiscordLinkComponents(buttons);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.type), [1, 1]);
  assert.deepEqual(rows.map(row => row.components.length), [5, 2]);
  assert.ok(rows.flatMap(row => row.components).every(button =>
    button.type === 2 && button.style === 5 && !("custom_id" in button)
  ));
});

test("25 link buttons fit exactly in five Discord action rows", () => {
  const buttons = Array.from({ length: 25 }, (_, index) => ({
    label: "Link " + (index + 1),
    url: "https://example.com/" + index
  }));
  const rows = buildDiscordLinkComponents(buttons);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.components.length === 5));
});

test("invalid, insecure, credentialed, overlong, or excessive link buttons are rejected", () => {
  assert.throws(() => normalizeDiscordLinkButtons([{ label: "", url: "https://example.com" }]));
  assert.throws(() => normalizeDiscordLinkButtons([{ label: "x".repeat(81), url: "https://example.com" }]));
  assert.throws(() => normalizeDiscordLinkButtons([{ label: "Bad", url: "javascript:alert(1)" }]));
  assert.throws(() => normalizeDiscordLinkButtons([{ label: "Bad", url: "http://example.com" }]));
  assert.throws(() => normalizeDiscordLinkButtons([{ label: "Bad", url: "https://user:pass@example.com" }]));
  assert.throws(() => normalizeDiscordLinkButtons([{ label: "Bad", url: "https://example.com/" + "x".repeat(520) }]));
  assert.throws(() => normalizeDiscordLinkButtons(
    Array.from({ length: 26 }, (_, index) => ({ label: "Link " + index, url: "https://example.com/" + index }))
  ));
});
