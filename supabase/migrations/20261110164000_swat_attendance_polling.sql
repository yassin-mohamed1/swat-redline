-- Scheduler state for polling the SWAT attendance channel from Vercel.
CREATE TABLE IF NOT EXISTS public.attendance_sync_state (
  channel_id text PRIMARY KEY CHECK (channel_id ~ '^[0-9]{15,22}$'),
  cursor_message_id text,
  lease_expires_at timestamptz,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.attendance_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_sync_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance_sync_state TO service_role;

CREATE OR REPLACE FUNCTION public.claim_swat_attendance_sync(
  p_channel_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state public.attendance_sync_state%rowtype;
BEGIN
  IF p_channel_id !~ '^[0-9]{15,22}$' THEN
    RAISE EXCEPTION 'invalid_attendance_channel' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.attendance_sync_state(channel_id)
  VALUES (p_channel_id)
  ON CONFLICT (channel_id) DO NOTHING;

  UPDATE public.attendance_sync_state
     SET lease_expires_at = now() + interval '90 seconds',
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
    'initialized_at', v_state.initialized_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_swat_attendance_sync(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_swat_attendance_sync(text) TO service_role;

NOTIFY pgrst, 'reload schema';
