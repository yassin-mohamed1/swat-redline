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
     OR p_dm_status NOT IN ('sent','failed')
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
                 AND p_dm_status = 'sent'
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
           updated_at = now()
     WHERE discord_user_id = v_action.discord_user_id;

    INSERT INTO public.audit_logs(
      actor_discord_id, actor_name, action, entity_type, entity_id, details
    ) VALUES (
      v_action.actor_discord_id,
      v_action.actor_name,
      CASE WHEN v_action.action_type = 'dismissal' THEN 'delete' ELSE 'create' END,
      'disciplinary_action',
      v_action.id::text,
      jsonb_build_object(
        'type', CASE WHEN v_action.action_type = 'dismissal' THEN 'فصل عضو' ELSE 'إصدار ' || CASE WHEN v_action.warning_level = 1 THEN 'الإنذار الأول' ELSE 'الإنذار الثاني' END END,
        'detail', 'تم إكمال الإجراء التأديبي للعضو ' || v_action.target_name,
        'target_discord_id', v_action.discord_user_id,
        'action_type', v_action.action_type,
        'warning_level', v_action.warning_level,
        'reason', v_action.reason,
        'details', v_action.details,
        'dm_status', p_dm_status,
        'dm_channel_id', p_dm_channel_id,
        'dm_message_id', p_dm_message_id,
        'channel_status', p_channel_status,
        'channel_message_id', p_channel_message_id,
        'warning_expires_at', p_warning_expires_at
      )
    );
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
