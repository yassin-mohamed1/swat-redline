import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("warnings API uses manager role checks and server-only secrets", async () => {
  const source = await readFile(new URL("../api/warnings.js", import.meta.url), "utf8");
  assert.match(source, /DISCORD_WARNING_MANAGER_ROLE_ID/);
  assert.match(source, /DISCORD_BOT_ROLE_ID/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /DISCORD_BOT_TOKEN/);
  assert.match(source, /Your Discord account does not have the Warnings management role/);
  assert.match(source, /params.get\("diagnostics"\) === "1"/);
});

test("warnings workflow supports warning progression and dismissal", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261108075846_disciplinary_warnings.sql", import.meta.url), "utf8");
  assert.match(migration, /p_warning_level <> v_subject\.warning_level \+ 1/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on function public\.begin_disciplinary_action/i);
  const followup = await readFile(new URL("../supabase/migrations/20261108075958_allow_dismissal_after_warning3.sql", import.meta.url), "utf8");
  assert.match(followup, /warning_level not in \(2,3\)/);
  const hardening = await readFile(new URL("../supabase/migrations/20261108080126_harden_disciplinary_completion_search_path.sql", import.meta.url), "utf8");
  assert.match(hardening, /SET search_path = pg_catalog, public/);
});
