-- Disciplinary warnings: durable subject state and append-only action history.

create table if not exists public.disciplinary_subjects (
  discord_user_id text primary key check (discord_user_id ~ '^[0-9]{15,22}$'),
  display_name text not null,
  username text,
  avatar_url text,
  warning_level smallint not null default 0 check (warning_level between 0 and 3),
  status text not null default 'active' check (status in ('active','dismissed')),
  last_reason text,
  last_action_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists disciplinary_subjects_status_idx
  on public.disciplinary_subjects(status, updated_at desc);

create table if not exists public.disciplinary_actions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  discord_user_id text not null references public.disciplinary_subjects(discord_user_id),
  target_name text not null,
  action_type text not null check (action_type in ('warning','dismissal')),
  warning_level smallint not null check (warning_level between 1 and 3),
  reason text not null,
  details text not null default '',
  actor_discord_id text not null,
  actor_name text not null,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  role_sync_status text not null default 'pending' check (role_sync_status in ('pending','succeeded','failed')),
  channel_status text not null default 'pending' check (channel_status in ('pending','sent','failed')),
  channel_message_id text,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists disciplinary_actions_subject_created_idx
  on public.disciplinary_actions(discord_user_id, created_at desc);
create index if not exists disciplinary_actions_created_idx
  on public.disciplinary_actions(created_at desc);

alter table public.disciplinary_subjects enable row level security;
alter table public.disciplinary_actions enable row level security;
revoke all privileges on table public.disciplinary_subjects, public.disciplinary_actions from anon, authenticated, public;
grant select, insert, update on table public.disciplinary_subjects to service_role;
grant select, insert, update on table public.disciplinary_actions to service_role;

create or replace function public.begin_disciplinary_action(
  p_request_id uuid,
  p_discord_user_id text,
  p_target_name text,
  p_username text,
  p_avatar_url text,
  p_action_type text,
  p_warning_level integer,
  p_reason text,
  p_details text,
  p_actor_discord_id text,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject public.disciplinary_subjects%rowtype;
  v_action public.disciplinary_actions%rowtype;
begin
  if p_request_id is null or p_discord_user_id !~ '^[0-9]{15,22}$'
     or p_warning_level not between 1 and 3
     or p_action_type not in ('warning','dismissal')
     or length(trim(coalesce(p_reason,''))) = 0
     or length(p_reason) > 1000 or length(coalesce(p_details,'')) > 3000 then
    raise exception 'invalid_disciplinary_request' using errcode = '22023';
  end if;

  insert into public.disciplinary_subjects(discord_user_id,display_name,username,avatar_url)
  values (p_discord_user_id, left(coalesce(nullif(trim(p_target_name),''),'Discord user'),100),
          nullif(left(coalesce(p_username,''),100),''), nullif(p_avatar_url,''))
  on conflict (discord_user_id) do nothing;

  select * into v_subject from public.disciplinary_subjects
    where discord_user_id = p_discord_user_id for update;

  select * into v_action from public.disciplinary_actions where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate', true, 'action_id', v_action.id, 'status', v_action.status,
      'warning_level', v_action.warning_level, 'action_type', v_action.action_type);
  end if;

  if v_subject.status = 'dismissed' then
    raise exception 'member_already_dismissed' using errcode = '23514';
  end if;
  if p_action_type = 'warning' and p_warning_level <> v_subject.warning_level + 1 then
    raise exception 'warning_level_out_of_sequence' using errcode = '23514';
  end if;
  if p_action_type = 'dismissal' and (p_warning_level <> 3 or v_subject.warning_level <> 2) then
    raise exception 'dismissal_requires_second_warning' using errcode = '23514';
  end if;

  insert into public.disciplinary_actions(
    request_id,discord_user_id,target_name,action_type,warning_level,reason,details,
    actor_discord_id,actor_name
  ) values (
    p_request_id,p_discord_user_id,v_subject.display_name,p_action_type,p_warning_level,
    trim(p_reason),coalesce(p_details,''),p_actor_discord_id,left(p_actor_name,100)
  ) returning * into v_action;

  return jsonb_build_object('duplicate', false, 'action_id', v_action.id, 'status', v_action.status,
    'warning_level', v_action.warning_level, 'action_type', v_action.action_type);
end;
$$;

create or replace function public.complete_disciplinary_action(
  p_action_id uuid,
  p_role_sync_status text,
  p_channel_status text,
  p_channel_message_id text,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.disciplinary_actions%rowtype;
begin
  if p_role_sync_status not in ('succeeded','failed')
     or p_channel_status not in ('sent','failed') then
    raise exception 'invalid_disciplinary_completion' using errcode = '22023';
  end if;
  select * into v_action from public.disciplinary_actions where id = p_action_id for update;
  if not found then raise exception 'disciplinary_action_not_found' using errcode = 'P0002'; end if;
  if v_action.status <> 'pending' then
    return jsonb_build_object('status',v_action.status,'duplicate',true);
  end if;

  update public.disciplinary_actions
    set status = case when p_role_sync_status = 'succeeded' then 'completed' else 'failed' end,
        role_sync_status = p_role_sync_status,
        channel_status = p_channel_status,
        channel_message_id = nullif(p_channel_message_id,''),
        error_code = nullif(left(coalesce(p_error_code,''),120),''),
        completed_at = now()
    where id = p_action_id;

  if p_role_sync_status = 'succeeded' then
    update public.disciplinary_subjects
      set warning_level = v_action.warning_level,
          status = case when v_action.action_type = 'dismissal' then 'dismissed' else 'active' end,
          last_reason = v_action.reason,
          last_action_at = now(),
          updated_at = now()
      where discord_user_id = v_action.discord_user_id;
  end if;

  return jsonb_build_object('status',case when p_role_sync_status = 'succeeded' then 'completed' else 'failed' end,
    'channel_status',p_channel_status);
end;
$$;

revoke all on function public.begin_disciplinary_action(uuid,text,text,text,text,text,integer,text,text,text,text) from public, anon, authenticated;
revoke all on function public.complete_disciplinary_action(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.begin_disciplinary_action(uuid,text,text,text,text,text,integer,text,text,text,text) to service_role;
grant execute on function public.complete_disciplinary_action(uuid,text,text,text,text) to service_role;
