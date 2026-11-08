CREATE OR REPLACE FUNCTION public.complete_expired_warning_role(
  p_discord_user_id text,
  p_warning_level smallint,
  p_warning_expires_at timestamptz,
  p_success boolean,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
  v_display_name text;
BEGIN
  IF p_success THEN
    UPDATE public.disciplinary_subjects
       SET warning_level = 0,
           warning_expires_at = NULL,
           expiry_claimed_at = NULL,
           expiry_retry_at = NULL,
           expiry_error = NULL,
           updated_at = now()
     WHERE discord_user_id = p_discord_user_id
       AND status = 'active'
       AND warning_level = p_warning_level
       AND warning_expires_at = p_warning_expires_at;
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
      UPDATE public.disciplinary_actions
         SET expired_at = now()
       WHERE discord_user_id = p_discord_user_id
         AND action_type = 'warning'
         AND warning_level = p_warning_level
         AND warning_expires_at = p_warning_expires_at
         AND status = 'completed'
         AND expired_at IS NULL;

      SELECT display_name INTO v_display_name
        FROM public.disciplinary_subjects
       WHERE discord_user_id = p_discord_user_id;

      INSERT INTO public.audit_logs(
        actor_discord_id, actor_name, action, entity_type, entity_id, details
      ) VALUES (
        NULL,
        'SYSTEM • WARNING EXPIRY',
        'update',
        'disciplinary_subject',
        p_discord_user_id,
        jsonb_build_object(
          'type', 'انتهاء صلاحية الإنذار تلقائيًا',
          'detail', 'انتهت مدة ' || CASE WHEN p_warning_level = 1 THEN 'الإنذار الأول' ELSE 'الإنذار الثاني' END || ' للعضو ' || coalesce(v_display_name,p_discord_user_id),
          'target_discord_id', p_discord_user_id,
          'expired_warning_level', p_warning_level,
          'warning_expires_at', p_warning_expires_at,
          'after', jsonb_build_object('warning_level',0,'status','active','warning_expires_at',null)
        )
      );
    END IF;

    RETURN jsonb_build_object('success', true, 'updated', v_updated > 0);
  ELSE
    UPDATE public.disciplinary_subjects
       SET expiry_claimed_at = NULL,
           expiry_retry_at = now() + interval '5 minutes',
           expiry_error = NULLIF(LEFT(COALESCE(p_error_code,''),120),'')
     WHERE discord_user_id = p_discord_user_id
       AND status = 'active'
       AND warning_level = p_warning_level
       AND warning_expires_at = p_warning_expires_at;
    RETURN jsonb_build_object('success', false, 'retry_scheduled', true);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_expired_warning_role(text,smallint,timestamptz,boolean,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_expired_warning_role(text,smallint,timestamptz,boolean,text)
  TO service_role;

-- The portal status editor and record editor are service-role-only RPCs.
-- set_disciplinary_subject_state and edit_disciplinary_action_record are defined in the preceding migration.
