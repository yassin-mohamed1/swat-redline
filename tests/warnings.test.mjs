import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warnings API uses manager role checks and server-only secrets", async () => {
  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(source, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /DISCORD_BOT_TOKEN/);
  assert.match(source, /The protected owner cannot be disciplined/);
});

test("warnings workflow supports warning progression and dismissal", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261108075846_disciplinary_warnings.sql", import.meta.url), "utf8");
  assert.match(migration, /warning_level = v_subject\.warning_level \+ 1/);
  assert.match(migration, /dismissal_requires_second_warning/);
  const followup = await readFile(new URL("../supabase/migrations/20261108075958_allow_dismissal_after_warning3.sql", import.meta.url), "utf8");
  assert.match(followup, /warning_level not in \(2,3\)/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on function private\.begin_disciplinary_action/i);
});
