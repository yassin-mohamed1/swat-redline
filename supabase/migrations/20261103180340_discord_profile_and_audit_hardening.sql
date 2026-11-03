-- Align staff profiles with Discord-only authentication and harden audit metadata.
-- Applied to the swat-redline Supabase project as migration
-- 20261103180340_discord_profile_and_audit_hardening.

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

alter table public.staff_profiles
  alter column id set default gen_random_uuid();

alter table public.staff_profiles
  drop constraint if exists staff_profiles_id_fkey;

alter table public.staff_profiles
  alter column discord_user_id set not null;

alter table public.audit_logs
  add column if not exists actor_discord_id text,
  add column if not exists actor_name text,
  add column if not exists details jsonb not null default '{}'::jsonb;

create index if not exists audit_logs_actor_id_idx
  on public.audit_logs (actor_id);
create index if not exists audit_logs_actor_discord_id_idx
  on public.audit_logs (actor_discord_id);
create index if not exists case_charges_case_id_idx
  on public.case_charges (case_id);
create index if not exists cases_created_by_idx
  on public.cases (created_by);
create index if not exists operations_created_by_idx
  on public.operations (created_by);
create index if not exists reports_created_by_idx
  on public.reports (created_by);
create index if not exists wanted_attachments_uploaded_by_idx
  on public.wanted_attachments (uploaded_by);
create index if not exists wanted_attachments_wanted_person_id_idx
  on public.wanted_attachments (wanted_person_id);
create index if not exists wanted_persons_created_by_idx
  on public.wanted_persons (created_by);

drop index if exists public.staff_profiles_discord_user_id_uidx;

notify pgrst, 'reload schema';
