-- Limit direct public API access and grant the server API append-only access to audit_logs.
-- The web portal uses authenticated Vercel API routes with the Supabase service role;
-- browser roles do not require direct table or sequence privileges.

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- The audit endpoint only reads and appends events. It cannot edit or delete history.
grant select, insert on public.audit_logs to service_role;
