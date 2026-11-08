-- Pin the completion RPC search path to trusted schemas.
CREATE OR REPLACE FUNCTION public.complete_disciplinary_action(
  p_action_id uuid,
  p_role_sync_status text,
  p_channel_status text,
  p_channel_message_id text,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
