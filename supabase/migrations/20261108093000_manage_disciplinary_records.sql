CREATE OR REPLACE FUNCTION public.set_disciplinary_subject_state(
  p_discord_user_id text,
  p_display_name text,
  p_username text,
  p_avatar_url text,
  p_warning_level integer,
  p_status text,
  p_reason text,
  p_warning_expires_at timestamptz,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_subject public.disciplinary_subjects%rowtype;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_warning_level NOT IN (0,1,2,3)
     OR p_status NOT IN ('active','dismissed')
     OR (p_status = 'dismissed' AND p_warning_level <> 3)
     OR (p_status = 'active' AND p_warning_level = 3)
     OR length(trim(coalesce(p_reason,''))) = 0
     OR length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'invalid_disciplinary_state' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.disciplinary_subjects(discord_user_id, display_name, username, avatar_url)
  VALUES (
    p_discord_user_id,
    left(coalesce(nullif(trim(p_display_name),''),'Discord user'),100),
    nullif(left(coalesce(p_username,''),100),''),
    nullif(p_avatar_url,'')
  )
  ON CONFLICT (discord_user_id) DO NOTHING;

  SELECT * INTO v_subject
    FROM public.disciplinary_subjects
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;

  IF p_status = 'dismissed' AND v_subject.warning_level <> 2 THEN
    RAISE EXCEPTION 'dismissal_requires_warning_two' USING ERRCODE = '23514';
  END IF;

  v_before := jsonb_build_object(
    'warning_level', v_subject.warning_level,
    'status', v_subject.status,
    'warning_expires_at', v_subject.warning_expires_at,
    'last_reason', v_subject.last_reason
  );

  UPDATE public.disciplinary_subjects
     SET display_name = left(coalesce(nullif(trim(p_display_name),''),display_name),100),
         username = nullif(left(coalesce(p_username,username,''),100),''),
         avatar_url = coalesce(nullif(p_avatar_url,''),avatar_url),
         warning_level = p_warning_level,
         status = p_status,
         last_reason = trim(p_reason),
         last_action_at = now(),
         warning_expires_at = CASE WHEN p_status = 'active' AND p_warning_level IN (1,2)
                                   THEN p_warning_expires_at ELSE NULL END,
         expiry_claimed_at = NULL,
         expiry_retry_at = NULL,
         expiry_error = NULL,
         updated_at = now()
   WHERE discord_user_id = p_discord_user_id
   RETURNING * INTO v_subject;

  v_after := jsonb_build_object(
    'warning_level', v_subject.warning_level,
    'status', v_subject.status,
    'warning_expires_at', v_subject.warning_expires_at,
    'last_reason', v_subject.last_reason
  );

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    'update',
    'disciplinary_subject',
    p_discord_user_id,
    jsonb_build_object(
      'type', 'تعديل الحالة التأديبية',
      'detail', 'تم تعديل الحالة التأديبية للعضو ' || v_subject.display_name,
      'target_discord_id', p_discord_user_id,
      'reason', trim(p_reason),
      'before', v_before,
      'after', v_after
    )
  );

  RETURN jsonb_build_object('ok', true, 'before', v_before, 'after', v_after);
END;
$$;

CREATE OR REPLACE FUNCTION public.edit_disciplinary_action_record(
  p_action_id uuid,
  p_reason text,
  p_details text,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action public.disciplinary_actions%rowtype;
  v_before jsonb;
BEGIN
  IF p_action_id IS NULL
     OR length(trim(coalesce(p_reason,''))) = 0
     OR length(p_reason) > 1000
     OR length(coalesce(p_details,'')) > 3000 THEN
    RAISE EXCEPTION 'invalid_disciplinary_edit' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_action
    FROM public.disciplinary_actions
   WHERE id = p_action_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_action_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_action.status <> 'completed' THEN
    RAISE EXCEPTION 'only_completed_disciplinary_actions_can_be_edited' USING ERRCODE = '23514';
  END IF;

  v_before := jsonb_build_object('reason',v_action.reason,'details',v_action.details);

  UPDATE public.disciplinary_actions
     SET reason = trim(p_reason),
         details = coalesce(p_details,'')
   WHERE id = p_action_id
   RETURNING * INTO v_action;

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    'update',
    'disciplinary_action',
    v_action.id::text,
    jsonb_build_object(
      'type', 'تعديل سجل/رسالة تأديبية',
      'detail', 'تم تعديل رسالة ' || CASE WHEN v_action.action_type = 'dismissal' THEN 'الفصل' ELSE 'الإنذار ' || v_action.warning_level END || ' للعضو ' || v_action.target_name,
      'target_discord_id', v_action.discord_user_id,
      'before', v_before,
      'after', jsonb_build_object('reason',v_action.reason,'details',v_action.details)
    )
  );

  RETURN jsonb_build_object('ok',true,'reason',v_action.reason,'details',v_action.details);
END;
$$;

REVOKE ALL ON FUNCTION public.set_disciplinary_subject_state(text,text,text,text,integer,text,text,timestamptz,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.edit_disciplinary_action_record(uuid,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_disciplinary_subject_state(text,text,text,text,integer,text,text,timestamptz,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_disciplinary_action_record(uuid,text,text,text,text)
  TO service_role;
