-- Avoid reintroducing browser-role table/sequence grants on portal-owned objects.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
