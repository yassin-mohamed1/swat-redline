-- Archive a disciplinary subject from the current-state list without deleting its history.
ALTER TABLE public.disciplinary_subjects
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_discord_id text,
  ADD COLUMN IF NOT EXISTS archived_by_name text,
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS disciplinary_subjects_visible_updated_idx
  ON public.disciplinary_subjects (updated_at DESC)
  WHERE is_archived = false;

CREATE OR REPLACE FUNCTION public.set_disciplinary_subject_archive(
  p_discord_user_id text,
  p_is_archived boolean,
  p_reason text,
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
     OR p_is_archived IS NULL
     OR length(trim(coalesce(p_reason,''))) = 0
     OR length(p_reason) > 1000
     OR length(trim(coalesce(p_actor_name,''))) = 0
     OR length(p_actor_name) > 100 THEN
    RAISE EXCEPTION 'invalid_disciplinary_archive_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subject
    FROM public.disciplinary_subjects
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_subject_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_before := jsonb_build_object(
    'is_archived',v_subject.is_archived,
    'warning_level',v_subject.warning_level,
    'status',v_subject.status,
    'last_reason',v_subject.last_reason
  );

  UPDATE public.disciplinary_subjects
     SET is_archived = p_is_archived,
         archived_at = CASE WHEN p_is_archived THEN now() ELSE NULL END,
         archived_by_discord_id = CASE WHEN p_is_archived THEN p_actor_discord_id ELSE NULL END,
         archived_by_name = CASE WHEN p_is_archived THEN left(trim(p_actor_name),100) ELSE NULL END,
         archive_reason = CASE WHEN p_is_archived THEN trim(p_reason) ELSE NULL END,
         updated_at = now()
   WHERE discord_user_id = p_discord_user_id
   RETURNING * INTO v_subject;

  v_after := jsonb_build_object(
    'is_archived',v_subject.is_archived,
    'warning_level',v_subject.warning_level,
    'status',v_subject.status,
    'last_reason',v_subject.last_reason,
    'archived_at',v_subject.archived_at,
    'archived_by_name',v_subject.archived_by_name,
    'archive_reason',v_subject.archive_reason
  );

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(trim(p_actor_name),100),
    'update',
    'disciplinary_subject',
    p_discord_user_id,
    jsonb_build_object(
      'type',CASE WHEN p_is_archived THEN 'إزالة عضو من قائمة الحالات' ELSE 'استعادة عضو إلى قائمة الحالات' END,
      'detail',CASE WHEN p_is_archived
        THEN 'تمت إزالة العضو ' || v_subject.display_name || ' من قائمة الحالات الحالية مع الاحتفاظ بتاريخ إجراءاته.'
        ELSE 'تمت استعادة العضو ' || v_subject.display_name || ' إلى قائمة الحالات الحالية.' END,
      'target_discord_id',p_discord_user_id,
      'reason',trim(p_reason),
      'before',v_before,
      'after',v_after
    )
  );

  RETURN jsonb_build_object(
    'ok',true,
    'discord_user_id',p_discord_user_id,
    'is_archived',v_subject.is_archived,
    'before',v_before,
    'after',v_after
  );
END;
$$;

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
    'last_reason', v_subject.last_reason,
    'is_archived',v_subject.is_archived
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
         is_archived = false,
         archived_at = NULL,
         archived_by_discord_id = NULL,
         archived_by_name = NULL,
         archive_reason = NULL,
         updated_at = now()
   WHERE discord_user_id = p_discord_user_id
   RETURNING * INTO v_subject;

  v_after := jsonb_build_object(
    'warning_level', v_subject.warning_level,
    'status', v_subject.status,
    'warning_expires_at', v_subject.warning_expires_at,
    'last_reason', v_subject.last_reason,
    'is_archived',v_subject.is_archived
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

CREATE OR REPLACE FUNCTION public.complete_disciplinary_action_v2(
  p_action_id uuid,
  p_role_sync_status text,
  p_dm_status text,
  p_dm_channel_id text,
  p_dm_message_id text,
  p_channel_status text,
  p_channel_message_id text,
  p_warning_expires_at timestamptz,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action public.disciplinary_actions%rowtype;
  v_completed boolean;
BEGIN
  IF p_role_sync_status NOT IN ('succeeded','failed')
     OR p_dm_status NOT IN ('sent','failed','skipped')
     OR p_channel_status NOT IN ('sent','failed') THEN
    RAISE EXCEPTION 'invalid_disciplinary_completion' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_action
    FROM public.disciplinary_actions
   WHERE id = p_action_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_action_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_action.status <> 'pending' THEN
    RETURN jsonb_build_object('status', v_action.status, 'duplicate', true);
  END IF;

  v_completed := p_role_sync_status = 'succeeded'
                 AND p_dm_status IN ('sent','skipped')
                 AND p_channel_status = 'sent';

  UPDATE public.disciplinary_actions
     SET status = CASE WHEN v_completed THEN 'completed' ELSE 'failed' END,
         role_sync_status = p_role_sync_status,
         dm_status = p_dm_status,
         dm_channel_id = NULLIF(p_dm_channel_id,''),
         dm_message_id = NULLIF(p_dm_message_id,''),
         dm_error_code = CASE WHEN p_dm_status = 'failed' THEN NULLIF(LEFT(COALESCE(p_error_code,''),120),'') ELSE NULL END,
         channel_status = p_channel_status,
         channel_message_id = NULLIF(p_channel_message_id,''),
         warning_expires_at = CASE WHEN v_completed AND v_action.action_type = 'warning' THEN p_warning_expires_at ELSE NULL END,
         error_code = NULLIF(LEFT(COALESCE(p_error_code,''),120),''),
         completed_at = now()
   WHERE id = p_action_id;

  IF v_completed THEN
    UPDATE public.disciplinary_subjects
       SET warning_level = v_action.warning_level,
           status = CASE WHEN v_action.action_type = 'dismissal' THEN 'dismissed' ELSE 'active' END,
           last_reason = v_action.reason,
           last_action_at = now(),
           warning_expires_at = CASE WHEN v_action.action_type = 'warning' THEN p_warning_expires_at ELSE NULL END,
           expiry_claimed_at = NULL,
           expiry_retry_at = NULL,
           expiry_error = NULL,
           is_archived = false,
           archived_at = NULL,
           archived_by_discord_id = NULL,
           archived_by_name = NULL,
           archive_reason = NULL,
           updated_at = now()
     WHERE discord_user_id = v_action.discord_user_id;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_completed THEN 'completed' ELSE 'failed' END,
    'dm_status', p_dm_status,
    'channel_status', p_channel_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_disciplinary_subject_archive(text,boolean,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_disciplinary_subject_archive(text,boolean,text,text,text)
  TO service_role;
