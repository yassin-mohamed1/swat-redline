CREATE OR REPLACE FUNCTION public.save_staff_assignment(
  p_discord_user_id text,
  p_display_name text,
  p_username text,
  p_avatar_url text,
  p_rank_role_id text,
  p_rank_role_name text,
  p_callsign text,
  p_status text,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_row public.staff_assignments%rowtype;
  v_action text;
BEGIN
  IF p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_status NOT IN ('assigned','unassigned')
     OR length(trim(coalesce(p_display_name,''))) = 0
     OR length(p_display_name) > 100
     OR (p_status = 'assigned' AND (
       coalesce(p_rank_role_id,'') !~ '^[0-9]{15,22}$'
       OR length(trim(coalesce(p_rank_role_name,''))) = 0
       OR length(p_rank_role_name) > 100
       OR (p_callsign IS NOT NULL AND p_callsign !~ '^Alpha (0|[1-9][0-9]{0,39})$')
     ))
     OR (p_status = 'unassigned' AND (
       p_rank_role_id IS NOT NULL OR p_rank_role_name IS NOT NULL OR p_callsign IS NOT NULL
     )) THEN
    RAISE EXCEPTION 'invalid_staff_assignment' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.staff_assignments
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;

  IF FOUND THEN
    v_before := jsonb_build_object(
      'discord_user_id', v_row.discord_user_id,
      'display_name', v_row.display_name,
      'rank_role_id', v_row.rank_role_id,
      'rank_role_name', v_row.rank_role_name,
      'callsign', v_row.callsign,
      'status', v_row.status
    );
  ELSE
    v_before := NULL;
  END IF;

  INSERT INTO public.staff_assignments(
    discord_user_id, display_name, username, avatar_url,
    rank_role_id, rank_role_name, callsign, status,
    assigned_by_discord_id, assigned_by_name, created_at, updated_at
  ) VALUES (
    p_discord_user_id,
    left(trim(p_display_name),100),
    nullif(left(coalesce(p_username,''),100),''),
    nullif(p_avatar_url,''),
    p_rank_role_id,
    p_rank_role_name,
    p_callsign,
    p_status,
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    now(),
    now()
  )
  ON CONFLICT (discord_user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    username = EXCLUDED.username,
    avatar_url = coalesce(EXCLUDED.avatar_url, public.staff_assignments.avatar_url),
    rank_role_id = EXCLUDED.rank_role_id,
    rank_role_name = EXCLUDED.rank_role_name,
    callsign = EXCLUDED.callsign,
    status = EXCLUDED.status,
    assigned_by_discord_id = EXCLUDED.assigned_by_discord_id,
    assigned_by_name = EXCLUDED.assigned_by_name,
    updated_at = now()
  RETURNING * INTO v_row;

  v_after := jsonb_build_object(
    'discord_user_id', v_row.discord_user_id,
    'display_name', v_row.display_name,
    'rank_role_id', v_row.rank_role_id,
    'rank_role_name', v_row.rank_role_name,
    'callsign', v_row.callsign,
    'status', v_row.status
  );

  v_action := CASE
    WHEN p_status = 'unassigned' THEN 'delete'
    WHEN v_before IS NULL THEN 'create'
    ELSE 'update'
  END;

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    v_action,
    'staff_assignment',
    p_discord_user_id,
    jsonb_build_object(
      'type', CASE WHEN p_status = 'unassigned' THEN 'إنهاء تعيين فرد'
                   WHEN v_before IS NULL THEN 'تعيين فرد'
                   ELSE 'تعديل التعيين' END,
      'detail', CASE WHEN p_status = 'unassigned'
                     THEN 'تم إنهاء تعيين ' || v_row.display_name
                     ELSE 'تم تعيين ' || v_row.display_name || ' برتبة ' || v_row.rank_role_name ||
                          coalesce(' • ' || v_row.callsign,'') END,
      'target_discord_id', p_discord_user_id,
      'before', v_before,
      'after', v_after
    )
  );

  RETURN jsonb_build_object('ok',true,'before',v_before,'after',v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.save_staff_assignment(text,text,text,text,text,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_staff_assignment(text,text,text,text,text,text,text,text,text,text)
  TO service_role;
