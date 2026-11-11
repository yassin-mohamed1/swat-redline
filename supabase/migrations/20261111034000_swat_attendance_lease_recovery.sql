-- Protect attendance polling with an ownership token and a short, renewable lease.
ALTER TABLE public.attendance_sync_state
  ADD COLUMN IF NOT EXISTS lease_token uuid;

CREATE OR REPLACE FUNCTION public.claim_swat_attendance_sync_v2(p_channel_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_state public.attendance_sync_state%rowtype;
  v_token uuid := gen_random_uuid();
BEGIN
  IF p_channel_id !~ '^[0-9]{15,22}$' THEN
    RAISE EXCEPTION 'invalid_attendance_channel' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.attendance_sync_state(channel_id)
  VALUES (p_channel_id)
  ON CONFLICT (channel_id) DO NOTHING;

  UPDATE public.attendance_sync_state
     SET lease_expires_at = now() + interval '18 seconds',
         lease_token = v_token,
         updated_at = now()
   WHERE channel_id = p_channel_id
     AND (lease_expires_at IS NULL OR lease_expires_at < now())
  RETURNING * INTO v_state;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'cursor_message_id', v_state.cursor_message_id,
    'initialized_at', v_state.initialized_at,
    'lease_token', v_state.lease_token
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.renew_swat_attendance_sync_v2(
  p_channel_id text,
  p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_channel_id !~ '^[0-9]{15,22}$' OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid_attendance_lease' USING ERRCODE = '22023';
  END IF;

  UPDATE public.attendance_sync_state
     SET lease_expires_at = now() + interval '18 seconds',
         updated_at = now()
   WHERE channel_id = p_channel_id
     AND lease_token = p_lease_token
     AND lease_expires_at > now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('renewed', v_rows = 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.advance_swat_attendance_cursor_v2(
  p_channel_id text,
  p_lease_token uuid,
  p_message_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_channel_id !~ '^[0-9]{15,22}$'
     OR p_lease_token IS NULL
     OR (p_message_id <> '0' AND p_message_id !~ '^[0-9]{15,22}$') THEN
    RAISE EXCEPTION 'invalid_attendance_cursor_request' USING ERRCODE = '22023';
  END IF;

  UPDATE public.attendance_sync_state
     SET cursor_message_id = p_message_id,
         updated_at = now()
   WHERE channel_id = p_channel_id
     AND lease_token = p_lease_token
     AND lease_expires_at > now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('advanced', v_rows = 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_swat_attendance_sync_v2(
  p_channel_id text,
  p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  IF p_channel_id !~ '^[0-9]{15,22}$' OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'invalid_attendance_lease' USING ERRCODE = '22023';
  END IF;

  UPDATE public.attendance_sync_state
     SET lease_expires_at = NULL,
         lease_token = NULL,
         updated_at = now()
   WHERE channel_id = p_channel_id
     AND lease_token = p_lease_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('released', v_rows = 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_swat_attendance_sync_v2(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_swat_attendance_sync_v2(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_swat_attendance_cursor_v2(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_swat_attendance_sync_v2(text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_swat_attendance_sync_v2(text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.renew_swat_attendance_sync_v2(text, uuid) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.advance_swat_attendance_cursor_v2(text, uuid, text) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.release_swat_attendance_sync_v2(text, uuid) TO service_role, postgres;
