-- Shared application state for S.W.A.T. REDLINE.
-- Run this migration in the Supabase SQL Editor.
create table if not exists public.app_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.app_state enable row level security;

-- No client policies are created. Access is through the server-side API
-- using the Supabase service-role key, which must never be exposed to browsers.
insert into public.app_state (id, data)
values ('main', '{"people":[],"audit":[],"tasks":[],"operations":[],"reports":[],"rules":[]}'::jsonb)
on conflict (id) do nothing;
