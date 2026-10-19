-- S.W.A.T. REDLINE owner controls and site-wide customization
alter table public.staff_profiles
  add column if not exists is_banned boolean not null default false,
  add column if not exists last_seen timestamptz,
  add column if not exists last_login timestamptz,
  add column if not exists login_count integer not null default 0;
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;
-- Browser clients get no direct policies. The server API uses the service role key.
