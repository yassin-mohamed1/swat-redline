-- Allow an approved dismissal when a member is at Warning 2 (before issuing Warning 3)
-- or already has Warning 3. The UI still requires an explicit dismissal choice.
CREATE OR REPLACE FUNCTION public.begin_disciplinary_action(
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
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
  if p_action_type = 'dismissal' and (p_warning_level <> 3 or v_subject.warning_level not in (2,3)) then
    raise exception 'dismissal_requires_warning_three' using errcode = '23514';
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
