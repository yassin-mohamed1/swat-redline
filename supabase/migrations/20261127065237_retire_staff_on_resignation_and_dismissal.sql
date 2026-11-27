-- Retire resigned/dismissed personnel from the active portal without deleting their history.
CREATE OR REPLACE FUNCTION public.retire_staff_member(
  p_discord_user_id text,
  p_reason text,
  p_actor_discord_id text,
  p_actor_name text,
  p_remaining_role_ids text[] DEFAULT ARRAY[]::text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.staff_profiles%rowtype;
  v_assignment public.staff_assignments%rowtype;
  v_assignment_count integer := 0;
  v_subject_count integer := 0;
  v_roles text[] := coalesce(p_remaining_role_ids, ARRAY[]::text[]);
BEGIN
  IF p_discord_user_id !~ '^[0-9]{15,22}$'
     OR length(trim(coalesce(p_reason, ''))) < 3
     OR length(p_reason) > 1000
     OR length(trim(coalesce(p_actor_name, ''))) < 1
     OR length(p_actor_name) > 100
     OR (p_actor_discord_id IS NOT NULL AND p_actor_discord_id !~ '^[0-9]{15,22}$')
     OR EXISTS (
       SELECT 1 FROM unnest(v_roles) AS role_id
       WHERE role_id NOT IN ('1561666360717606993', '1569390325364162650')
     ) THEN
    RAISE EXCEPTION 'invalid_staff_retirement_request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_profile
    FROM public.staff_profiles
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_profile_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_assignment
    FROM public.staff_assignments
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;

  UPDATE public.staff_profiles
     SET is_active = false,
         is_banned = false,
         discord_roles = v_roles,
         discord_roles_synced_at = now(),
         updated_at = now()
   WHERE discord_user_id = p_discord_user_id;

  UPDATE public.staff_assignments
     SET status = 'unassigned',
         rank_role_id = NULL,
         rank_role_name = NULL,
         rank_role_ids = ARRAY[]::text[],
         rank_role_names = ARRAY[]::text[],
         callsign = NULL,
         updated_at = now()
   WHERE discord_user_id = p_discord_user_id;
  GET DIAGNOSTICS v_assignment_count = ROW_COUNT;

  UPDATE public.disciplinary_subjects
     SET is_archived = true,
         archived_at = now(),
         archived_by_discord_id = p_actor_discord_id,
         archived_by_name = left(trim(p_actor_name), 100),
         archive_reason = trim(p_reason),
         updated_at = now()
   WHERE discord_user_id = p_discord_user_id
     AND is_archived = false;
  GET DIAGNOSTICS v_subject_count = ROW_COUNT;

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(trim(p_actor_name), 100),
    'update',
    'staff_profile',
    p_discord_user_id,
    jsonb_build_object(
      'type', 'إخراج عضو من قائمة الأفراد النشطين',
      'detail', 'تم إيقاف حساب العضو من بوابة S.W.A.T. REDLINE مع الاحتفاظ بسجل الاستقالة/الفصل والتحذيرات والتدقيق لإمكانية إعادته إداريًا.',
      'target_discord_id', p_discord_user_id,
      'reason', trim(p_reason),
      'remaining_discord_role_ids', to_jsonb(v_roles),
      'previous_active', v_profile.is_active,
      'previous_assignment', CASE WHEN v_assignment.discord_user_id IS NULL THEN NULL ELSE jsonb_build_object(
        'status', v_assignment.status,
        'rank_role_ids', v_assignment.rank_role_ids,
        'rank_role_names', v_assignment.rank_role_names,
        'callsign', v_assignment.callsign
      ) END,
      'assignments_unassigned', v_assignment_count,
      'disciplinary_subjects_archived', v_subject_count
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'retired', true,
    'discord_user_id', p_discord_user_id,
    'assignments_unassigned', v_assignment_count,
    'disciplinary_subjects_archived', v_subject_count,
    'remaining_discord_role_ids', to_jsonb(v_roles)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.retire_staff_member(text,text,text,text,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_staff_member(text,text,text,text,text[]) TO service_role;

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

  -- A DM is best-effort. The action is complete when roles and the server notice succeed.
  v_completed := p_role_sync_status = 'succeeded'
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
         error_code = CASE WHEN v_completed THEN NULL ELSE NULLIF(LEFT(COALESCE(p_error_code,''),120),'') END,
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
           is_archived = (v_action.action_type = 'dismissal'),
           archived_at = CASE WHEN v_action.action_type = 'dismissal' THEN now() ELSE NULL END,
           archived_by_discord_id = CASE WHEN v_action.action_type = 'dismissal' THEN v_action.actor_discord_id ELSE NULL END,
           archived_by_name = CASE WHEN v_action.action_type = 'dismissal' THEN left(v_action.actor_name,100) ELSE NULL END,
           archive_reason = CASE WHEN v_action.action_type = 'dismissal' THEN 'فصل عضو: ' || left(v_action.reason,900) ELSE NULL END,
           updated_at = now()
     WHERE discord_user_id = v_action.discord_user_id;

    IF v_action.action_type = 'dismissal' THEN
      PERFORM public.retire_staff_member(
        v_action.discord_user_id,
        'فصل عضو عبر نظام التحذيرات: ' || left(v_action.reason,850),
        v_action.actor_discord_id,
        coalesce(nullif(v_action.actor_name,''),'إدارة S.W.A.T.'),
        ARRAY[]::text[]
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_completed THEN 'completed' ELSE 'failed' END,
    'dm_status', p_dm_status,
    'channel_status', p_channel_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_disciplinary_action_v2(uuid,text,text,text,text,text,text,timestamptz,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_disciplinary_action_v2(uuid,text,text,text,text,text,text,timestamptz,text)
  TO service_role;

-- Repair already-approved real resignations, but do not treat test requests as production decisions.
DO $$
DECLARE
  v record;
  v_remaining_roles text[];
BEGIN
  FOR v IN
    SELECT r.discord_user_id, r.reason, r.reviewed_at,
           r.reviewed_by_discord_id, r.reviewed_by_name,
           p.discord_roles, p.updated_at
      FROM public.resignation_requests r
      JOIN public.staff_profiles p USING (discord_user_id)
     WHERE r.status = 'approved'
       AND p.is_active = true
       AND r.reviewed_at IS NOT NULL
       AND lower(trim(r.reason)) NOT IN ('تيست','test','testing','تجربة','تجريبي')
       AND p.updated_at <= r.reviewed_at
  LOOP
    SELECT coalesce(array_agg(role_id), ARRAY[]::text[])
      INTO v_remaining_roles
      FROM unnest(coalesce(v.discord_roles, ARRAY[]::text[])) AS role_id
     WHERE role_id IN ('1561666360717606993','1569390325364162650');

    PERFORM public.retire_staff_member(
      v.discord_user_id,
      'استقالة معتمدة: ' || left(v.reason,900),
      v.reviewed_by_discord_id,
      coalesce(nullif(v.reviewed_by_name,''),'إدارة S.W.A.T.'),
      v_remaining_roles
    );
  END LOOP;
END;
$$;

-- Also repair completed dismissals that were recorded before portal deactivation was wired in.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT s.discord_user_id, s.last_reason, a.actor_discord_id, a.actor_name
      FROM public.disciplinary_subjects s
      JOIN public.staff_profiles p USING (discord_user_id)
      LEFT JOIN LATERAL (
        SELECT da.actor_discord_id, da.actor_name
          FROM public.disciplinary_actions da
         WHERE da.discord_user_id = s.discord_user_id
           AND da.action_type = 'dismissal'
           AND da.status = 'completed'
         ORDER BY da.completed_at DESC NULLS LAST, da.created_at DESC
         LIMIT 1
      ) a ON true
     WHERE s.status = 'dismissed'
       AND s.is_archived = false
       AND p.is_active = true
       AND p.updated_at <= s.last_action_at
  LOOP
    PERFORM public.retire_staff_member(
      v.discord_user_id,
      'فصل سابق مسجل في سجل التحذيرات: ' || left(coalesce(v.last_reason,'فصل إداري'),850),
      v.actor_discord_id,
      coalesce(nullif(v.actor_name,''),'إدارة S.W.A.T.'),
      ARRAY[]::text[]
    );
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
