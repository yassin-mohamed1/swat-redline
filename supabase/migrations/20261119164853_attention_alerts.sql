-- Durable status and stop requests for S.W.A.T. Attention Alert.
create table if not exists public.attention_alerts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null check (guild_id ~ '^\d{15,22}$'),
  discord_user_id text not null check (discord_user_id ~ '^\d{15,22}$'),
  member_name text not null check (char_length(member_name) between 1 and 120),
  original_channel_id text not null check (original_channel_id ~ '^\d{15,22}$'),
  original_channel_name text not null check (char_length(original_channel_name) between 1 and 100),
  alert_channel_id text not null check (alert_channel_id ~ '^\d{15,22}$'),
  alert_channel_name text not null check (char_length(alert_channel_name) between 1 and 100),
  started_by_discord_id text not null check (started_by_discord_id ~ '^\d{15,22}$'),
  started_by_name text not null check (char_length(started_by_name) between 1 and 120),
  started_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'stopped', 'failed', 'interrupted')),
  stop_requested_at timestamptz,
  stop_requested_by_discord_id text check (stop_requested_by_discord_id is null or stop_requested_by_discord_id ~ '^\d{15,22}$'),
  stop_requested_by_name text check (stop_requested_by_name is null or char_length(stop_requested_by_name) <= 120),
  end_reason text check (end_reason is null or char_length(end_reason) <= 80),
  ended_at timestamptz
);

create unique index if not exists attention_alerts_one_active_per_member
  on public.attention_alerts (guild_id, discord_user_id)
  where status = 'active';

create index if not exists attention_alerts_recent_per_member
  on public.attention_alerts (guild_id, discord_user_id, started_at desc);

create index if not exists attention_alerts_active_dashboard
  on public.attention_alerts (guild_id, started_at asc)
  where status = 'active';

alter table public.attention_alerts enable row level security;
revoke all on table public.attention_alerts from anon, authenticated;
grant all on table public.attention_alerts to service_role;

-- Only one Gateway worker may process alerts at a time, including during a
-- rolling deploy or an overlapping restart.
create table if not exists public.attention_alert_worker_lease (
  singleton boolean primary key default true check (singleton),
  worker_instance_id uuid,
  lease_expires_at timestamptz not null default now()
);

insert into public.attention_alert_worker_lease (singleton, worker_instance_id, lease_expires_at)
values (true, null, now())
on conflict (singleton) do nothing;

alter table public.attention_alert_worker_lease enable row level security;
revoke all on table public.attention_alert_worker_lease from anon, authenticated;
grant all on table public.attention_alert_worker_lease to service_role;

create or replace function public.claim_attention_alert_worker(p_instance_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_instance uuid;
  current_expiry timestamptz;
begin
  insert into public.attention_alert_worker_lease (singleton, worker_instance_id, lease_expires_at)
  values (true, p_instance_id, now() + interval '15 seconds')
  on conflict (singleton) do nothing;

  select worker_instance_id, lease_expires_at
    into current_instance, current_expiry
    from public.attention_alert_worker_lease
   where singleton = true
   for update;

  if current_instance is null or current_expiry <= now() or current_instance = p_instance_id then
    update public.attention_alert_worker_lease
       set worker_instance_id = p_instance_id,
           lease_expires_at = now() + interval '15 seconds'
     where singleton = true;
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.renew_attention_alert_worker(p_instance_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.attention_alert_worker_lease
     set lease_expires_at = now() + interval '15 seconds'
   where singleton = true
     and worker_instance_id = p_instance_id
     and lease_expires_at > now();
  return found;
end;
$$;

create or replace function public.release_attention_alert_worker(p_instance_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.attention_alert_worker_lease
     set worker_instance_id = null,
         lease_expires_at = now()
   where singleton = true
     and worker_instance_id = p_instance_id;
  return found;
end;
$$;

revoke all on function public.claim_attention_alert_worker(uuid) from public, anon, authenticated;
revoke all on function public.renew_attention_alert_worker(uuid) from public, anon, authenticated;
revoke all on function public.release_attention_alert_worker(uuid) from public, anon, authenticated;
grant execute on function public.claim_attention_alert_worker(uuid) to service_role;
grant execute on function public.renew_attention_alert_worker(uuid) to service_role;
grant execute on function public.release_attention_alert_worker(uuid) to service_role;
