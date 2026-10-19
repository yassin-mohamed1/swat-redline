-- S.W.A.T. REDLINE owner controls and site-wide customization.
-- Safe to run on an existing installation or on a fresh Supabase project.

create table if not exists public.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text unique not null,
  display_name text,
  avatar_url text,
  is_active boolean not null default true,
  is_banned boolean not null default false,
  last_seen timestamptz,
  last_login timestamptz,
  login_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.staff_profiles
  add column if not exists discord_user_id text,
  add column if not exists display_name text,
  add column if not exists avatar_url text,
  add column if not exists is_active boolean not null default true,
  add column if not exists is_banned boolean not null default false,
  add column if not exists last_seen timestamptz,
  add column if not exists last_login timestamptz,
  add column if not exists login_count integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists staff_profiles_discord_user_id_uidx
  on public.staff_profiles (discord_user_id);

create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.site_settings enable row level security;

-- Browser clients get no direct policies. Server APIs use SUPABASE_SERVICE_ROLE_KEY.
