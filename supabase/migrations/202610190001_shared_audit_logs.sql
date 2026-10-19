-- S.W.A.T. REDLINE: shared audit log support
-- Run this file in Supabase SQL Editor before enabling the API endpoint.
-- Existing tables are preserved; missing columns are added safely.

create extension if not exists pgcrypto;

alter table public.staff_profiles
  add column if not exists discord_user_id text,
  add column if not exists display_name text,
  add column if not exists avatar_url text,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists staff_profiles_discord_user_id_uidx
  on public.staff_profiles (discord_user_id)
  where discord_user_id is not null;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_discord_id text not null,
  actor_name text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs
  add column if not exists actor_discord_id text,
  add column if not exists actor_name text,
  add column if not exists action text,
  add column if not exists entity_type text,
  add column if not exists entity_id text,
  add column if not exists details jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_discord_id_idx
  on public.audit_logs (actor_discord_id);

alter table public.staff_profiles enable row level security;
alter table public.audit_logs enable row level security;

-- No browser-facing policies are added. Server API routes use the service key;
-- never expose that key to client-side code.
