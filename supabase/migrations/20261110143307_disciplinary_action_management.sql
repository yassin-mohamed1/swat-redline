-- Allow completed disciplinary actions to be explicitly voided without erasing the audit trail.
ALTER TABLE public.disciplinary_actions
  DROP CONSTRAINT IF EXISTS disciplinary_actions_status_check;

ALTER TABLE public.disciplinary_actions
  ADD CONSTRAINT disciplinary_actions_status_check
  CHECK (status IN ('pending','completed','failed','voided'));

ALTER TABLE public.disciplinary_actions
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS voided_by_discord_id text,
  ADD COLUMN IF NOT EXISTS voided_by_name text;

CREATE INDEX IF NOT EXISTS disciplinary_actions_member_completed_idx
  ON public.disciplinary_actions (discord_user_id, completed_at DESC, created_at DESC)
  WHERE status = 'completed';

CREATE OR REPLACE FUNCTION public.edit_disciplinary_action_record_v2(
  p_action_id uuid,
  p_target_name text,
  p_warning_level integer,
  p_reason text,
  p_details text,
  p_warning_expires_at timestamptz,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action public.disciplinary_actions%rowtype;
  v_subject public.disciplinary_subjects%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_is_current boolean;
BEGIN
  IF p_action_id IS NULL
     OR length(trim(coalesce(p_target_name,''))) = 0
     OR length(p_target_name) > 100
     OR p_warning_level NOT IN (1,2)
     OR length(trim(coalesce(p_reason,''))) = 0
     OR length(p_reason) > 1000
     OR length(coalesce(p_details,'')) > 3000
     OR p_actor_discord_id !~ '^[0-9]{15,22}$' THEN
    RAISE EXCEPTION 'invalid_disciplinary_edit' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_action
    FROM public.disciplinary_actions
   WHERE id = p_action_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_action_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_action.status <> 'completed' OR v_action.action_type <> 'warning' THEN
    RAISE EXCEPTION 'only_completed_warning_actions_can_be_edited' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_subject
    FROM public.disciplinary_subjects
   WHERE discord_user_id = v_action.discord_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_subject_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_is_current :=
    v_subject.status = 'active'
    AND v_subject.warning_level = v_action.warning_level
    AND v_subject.last_action_at IS NOT DISTINCT FROM v_action.completed_at
    AND v_action.expired_at IS NULL
    AND (v_action.warning_expires_at IS NULL OR v_action.warning_expires_at > now());

  IF v_is_current AND p_warning_expires_at IS NULL THEN
    RAISE EXCEPTION 'current_warning_requires_expiry' USING ERRCODE = '22023';
  END IF;

  v_before := jsonb_build_object(
    'target_name',v_action.target_name,
    'warning_level',v_action.warning_level,
    'reason',v_action.reason,
    'details',v_action.details,
    'warning_expires_at',v_action.warning_expires_at
  );

  UPDATE public.disciplinary_actions
     SET target_name = left(trim(p_target_name),100),
         warning_level = p_warning_level,
         reason = trim(p_reason),
         details = coalesce(p_details,''),
         warning_expires_at = CASE WHEN v_is_current THEN p_warning_expires_at ELSE warning_expires_at END
   WHERE id = p_action_id
   RETURNING * INTO v_action;

  UPDATE public.disciplinary_subjects
     SET display_name = left(trim(p_target_name),100),
         warning_level = CASE WHEN v_is_current THEN p_warning_level ELSE warning_level END,
         last_reason = CASE WHEN v_is_current THEN trim(p_reason) ELSE last_reason END,
         warning_expires_at = CASE WHEN v_is_current THEN p_warning_expires_at ELSE warning_expires_at END,
         expiry_claimed_at = CASE WHEN v_is_current THEN NULL ELSE expiry_claimed_at END,
         expiry_retry_at = CASE WHEN v_is_current THEN NULL ELSE expiry_retry_at END,
         expiry_error = CASE WHEN v_is_current THEN NULL ELSE expiry_error END,
         updated_at = now()
   WHERE discord_user_id = v_action.discord_user_id
   RETURNING * INTO v_subject;

  v_after := jsonb_build_object(
    'target_name',v_action.target_name,
    'warning_level',v_action.warning_level,
    'reason',v_action.reason,
    'details',v_action.details,
    'warning_expires_at',v_action.warning_expires_at,
    'subject_warning_level',v_subject.warning_level,
    'subject_status',v_subject.status
  );

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    'update',
    'disciplinary_action',
    v_action.id::text,
    jsonb_build_object(
      'type','تعديل سجل الإنذار',
      'detail','تم تعديل اسم العضو ومستوى الإنذار وبيانات الإجراء التأديبي للعضو ' || v_action.target_name,
      'target_discord_id',v_action.discord_user_id,
      'was_current',v_is_current,
      'before',v_before,
      'after',v_after
    )
  );

  RETURN jsonb_build_object(
    'ok',true,
    'was_current',v_is_current,
    'action_id',v_action.id,
    'target_name',v_action.target_name,
    'warning_level',v_action.warning_level,
    'warning_expires_at',v_action.warning_expires_at,
    'subject_warning_level',v_subject.warning_level
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.void_disciplinary_action_record(
  p_action_id uuid,
  p_reason text,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_action public.disciplinary_actions%rowtype;
  v_subject public.disciplinary_subjects%rowtype;
  v_previous public.disciplinary_actions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_was_current boolean;
  v_new_level integer := 0;
  v_new_status text := 'active';
  v_new_reason text := NULL;
  v_new_expiry timestamptz := NULL;
  v_new_last_action_at timestamptz := NULL;
BEGIN
  IF p_action_id IS NULL
     OR length(trim(coalesce(p_reason,''))) = 0
     OR length(p_reason) > 1000
     OR p_actor_discord_id !~ '^[0-9]{15,22}$' THEN
    RAISE EXCEPTION 'invalid_disciplinary_void' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_action
    FROM public.disciplinary_actions
   WHERE id = p_action_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_action_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_action.status <> 'completed' OR v_action.action_type <> 'warning' THEN
    RAISE EXCEPTION 'only_completed_warning_actions_can_be_voided' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_subject
    FROM public.disciplinary_subjects
   WHERE discord_user_id = v_action.discord_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'disciplinary_subject_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_was_current :=
    v_subject.status = 'active'
    AND v_subject.warning_level = v_action.warning_level
    AND v_subject.last_action_at IS NOT DISTINCT FROM v_action.completed_at
    AND v_action.expired_at IS NULL
    AND (v_action.warning_expires_at IS NULL OR v_action.warning_expires_at > now());

  v_before := jsonb_build_object(
    'target_name',v_action.target_name,
    'action_type',v_action.action_type,
    'warning_level',v_action.warning_level,
    'reason',v_action.reason,
    'details',v_action.details,
    'status',v_action.status,
    'warning_expires_at',v_action.warning_expires_at,
    'subject_warning_level',v_subject.warning_level,
    'subject_status',v_subject.status
  );

  UPDATE public.disciplinary_actions
     SET status = 'voided',
         voided_at = now(),
         void_reason = trim(p_reason),
         voided_by_discord_id = p_actor_discord_id,
         voided_by_name = left(coalesce(p_actor_name,'Unknown user'),100)
   WHERE id = p_action_id
   RETURNING * INTO v_action;

  IF v_was_current THEN
    SELECT * INTO v_previous
      FROM public.disciplinary_actions
     WHERE discord_user_id = v_action.discord_user_id
       AND id <> v_action.id
       AND status = 'completed'
     ORDER BY completed_at DESC NULLS LAST, created_at DESC
     LIMIT 1;

    IF FOUND THEN
      v_new_last_action_at := v_previous.completed_at;
      IF v_previous.action_type = 'dismissal' THEN
        v_new_level := 3;
        v_new_status := 'dismissed';
        v_new_reason := v_previous.reason;
      ELSIF v_previous.action_type = 'warning'
        AND v_previous.expired_at IS NULL
        AND (v_previous.warning_expires_at IS NULL OR v_previous.warning_expires_at > now()) THEN
        v_new_level := v_previous.warning_level;
        v_new_status := 'active';
        v_new_reason := v_previous.reason;
        v_new_expiry := v_previous.warning_expires_at;
      ELSE
        IF v_previous.action_type = 'warning'
           AND v_previous.expired_at IS NULL
           AND v_previous.warning_expires_at IS NOT NULL
           AND v_previous.warning_expires_at <= now() THEN
          UPDATE public.disciplinary_actions
             SET expired_at = now()
           WHERE id = v_previous.id;
        END IF;
        v_new_level := 0;
        v_new_status := 'active';
        v_new_reason := NULL;
        v_new_expiry := NULL;
      END IF;
    END IF;

    UPDATE public.disciplinary_subjects
       SET warning_level = v_new_level,
           status = v_new_status,
           last_reason = v_new_reason,
           last_action_at = v_new_last_action_at,
           warning_expires_at = v_new_expiry,
           expiry_claimed_at = NULL,
           expiry_retry_at = NULL,
           expiry_error = NULL,
           updated_at = now()
     WHERE discord_user_id = v_action.discord_user_id
     RETURNING * INTO v_subject;
  END IF;

  v_after := jsonb_build_object(
    'warning_level',v_subject.warning_level,
    'status',v_subject.status,
    'last_reason',v_subject.last_reason,
    'last_action_at',v_subject.last_action_at,
    'warning_expires_at',v_subject.warning_expires_at
  );

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    'delete',
    'disciplinary_action',
    v_action.id::text,
    jsonb_build_object(
      'type','إلغاء إجراء تحذير',
      'detail','تم إلغاء ' || CASE WHEN v_action.warning_level = 1 THEN 'الإنذار الأول' ELSE 'الإنذار الثاني' END || ' للعضو ' || v_action.target_name,
      'target_discord_id',v_action.discord_user_id,
      'void_reason',trim(p_reason),
      'was_current',v_was_current,
      'record',jsonb_build_object(
        'target_name',v_action.target_name,
        'warning_level',v_action.warning_level,
        'reason',v_action.reason,
        'details',v_action.details,
        'actor_name',v_action.actor_name,
        'created_at',v_action.created_at,
        'completed_at',v_action.completed_at,
        'channel_message_id',v_action.channel_message_id,
        'dm_message_id',v_action.dm_message_id
      ),
      'before',v_before,
      'after',v_after
    )
  );

  RETURN jsonb_build_object(
    'ok',true,
    'voided',true,
    'was_current',v_was_current,
    'discord_user_id',v_action.discord_user_id,
    'subject_state',v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.edit_disciplinary_action_record_v2(uuid,text,integer,text,text,timestamptz,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_disciplinary_action_record(uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.edit_disciplinary_action_record_v2(uuid,text,integer,text,text,timestamptz,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.void_disciplinary_action_record(uuid,text,text,text)
  TO service_role;
