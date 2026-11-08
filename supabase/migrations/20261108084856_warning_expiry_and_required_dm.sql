-- Warning roles expire 30 days after a successfully delivered warning.
ALTER TABLE public.disciplinary_subjects
  ADD COLUMN IF NOT EXISTS warning_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS expiry_error text;

ALTER TABLE public.disciplinary_actions
  ADD COLUMN IF NOT EXISTS dm_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS dm_channel_id text,
  ADD COLUMN IF NOT EXISTS dm_message_id text,
  ADD COLUMN IF NOT EXISTS dm_error_code text,
  ADD COLUMN IF NOT EXISTS warning_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

ALTER TABLE public.disciplinary_actions
  ADD CONSTRAINT disciplinary_actions_dm_status_check
  CHECK (dm_status IN ('pending','sent','failed'));

CREATE INDEX IF NOT EXISTS disciplinary_subjects_warning_expiry_idx
  ON public.disciplinary_subjects(warning_expires_at)
  WHERE status = 'active' AND warning_level IN (1,2) AND warning_expires_at IS NOT NULL;

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
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_completed THEN 'completed' ELSE 'failed' END,
    'dm_status', p_dm_status,
    'channel_status', p_channel_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_expired_warning_roles(p_limit integer DEFAULT 25)
RETURNS TABLE(
  discord_user_id text,
  display_name text,
  warning_level smallint,
  warning_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s.discord_user_id
      FROM public.disciplinary_subjects s
     WHERE s.status = 'active'
       AND s.warning_level IN (1,2)
       AND s.warning_expires_at IS NOT NULL
       AND s.warning_expires_at <= now()
       AND (s.expiry_claimed_at IS NULL OR s.expiry_claimed_at < now() - interval '10 minutes')
       AND (s.expiry_retry_at IS NULL OR s.expiry_retry_at <= now())
     ORDER BY s.warning_expires_at
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit,25),100))
  )
  UPDATE public.disciplinary_subjects s
     SET expiry_claimed_at = now()
    FROM due
   WHERE s.discord_user_id = due.discord_user_id
  RETURNING s.discord_user_id, s.display_name, s.warning_level, s.warning_expires_at;
END;
$$;

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

REVOKE ALL ON FUNCTION public.complete_disciplinary_action_v2(uuid,text,text,text,text,text,text,timestamptz,text)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_expired_warning_roles(integer)
  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_expired_warning_role(text,smallint,timestamptz,boolean,text)
  FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_disciplinary_action_v2(uuid,text,text,text,text,text,text,timestamptz,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_expired_warning_roles(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_expired_warning_role(text,smallint,timestamptz,boolean,text)
  TO service_role;
