-- Manageable exemptions and leave requests for the S.W.A.T. REDLINE daily attendance system.
CREATE TABLE IF NOT EXISTS public.attendance_exemptions (
  discord_user_id text PRIMARY KEY REFERENCES public.staff_profiles(discord_user_id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_by_discord_id text NOT NULL CHECK (created_by_discord_id ~ '^[0-9]{15,22}$'),
  created_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(reason) <= 1000)
);
CREATE INDEX IF NOT EXISTS attendance_exemptions_enabled_idx
  ON public.attendance_exemptions (discord_user_id) WHERE enabled = true;
ALTER TABLE public.attendance_exemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_exemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attendance_exemptions TO service_role;

CREATE TABLE IF NOT EXISTS public.attendance_leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id text NOT NULL REFERENCES public.staff_profiles(discord_user_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 1000),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by_discord_id text CHECK (reviewed_by_discord_id IS NULL OR reviewed_by_discord_id ~ '^[0-9]{15,22}$'),
  reviewed_by_name text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (length(coalesce(review_note,'')) <= 1000)
);
CREATE INDEX IF NOT EXISTS attendance_leave_requests_status_date_idx
  ON public.attendance_leave_requests (status, start_date, end_date);
CREATE INDEX IF NOT EXISTS attendance_leave_requests_member_idx
  ON public.attendance_leave_requests (discord_user_id, created_at DESC);
ALTER TABLE public.attendance_leave_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_leave_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance_leave_requests TO service_role;

-- Keep the existing daily ledger behavior, but expose the active exemption state to the poller.
CREATE OR REPLACE FUNCTION public.record_swat_daily_attendance(
  p_discord_user_id text,
  p_attendance_date date,
  p_message_id text,
  p_channel_id text,
  p_display_name text,
  p_username text,
  p_first_seen_at timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_profile public.staff_profiles%rowtype;
  v_inserted public.attendance_records%rowtype;
  v_existing public.attendance_records%rowtype;
BEGIN
  IF p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_message_id !~ '^[0-9]{15,22}$'
     OR p_channel_id !~ '^[0-9]{15,22}$'
     OR p_attendance_date IS NULL
     OR length(trim(coalesce(p_display_name,'')))=0
     OR length(p_display_name)>100 THEN
    RAISE EXCEPTION 'invalid_attendance_request' USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_profile
    FROM public.staff_profiles
   WHERE discord_user_id = p_discord_user_id
   FOR SHARE;

  IF NOT FOUND OR v_profile.is_active IS NOT TRUE OR v_profile.is_banned IS TRUE THEN
    RETURN jsonb_build_object('recorded',false,'eligible',false,'exempt',false,'duplicate',false);
  END IF;

  INSERT INTO public.attendance_records(
    discord_user_id,attendance_date,first_message_id,channel_id,
    display_name,username,first_seen_at,timezone
  ) VALUES (
    p_discord_user_id,p_attendance_date,p_message_id,p_channel_id,
    left(trim(p_display_name),100),nullif(left(coalesce(p_username,''),100),''),
    coalesce(p_first_seen_at,now()),'Asia/Riyadh'
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_inserted;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'recorded',true,'eligible',true,
      'exempt',EXISTS (
        SELECT 1 FROM public.attendance_exemptions e
         WHERE e.discord_user_id=p_discord_user_id AND e.enabled
      ),
      'attendance_date',v_inserted.attendance_date,
      'first_seen_at',v_inserted.first_seen_at,
      'first_message_id',v_inserted.first_message_id,
      'duplicate',false
    );
  END IF;

  SELECT * INTO v_existing
    FROM public.attendance_records
   WHERE discord_user_id=p_discord_user_id
     AND attendance_date=p_attendance_date;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendance_message_already_used' USING ERRCODE='23505';
  END IF;

  RETURN jsonb_build_object(
    'recorded',false,'eligible',true,
    'exempt',EXISTS (
      SELECT 1 FROM public.attendance_exemptions e
       WHERE e.discord_user_id=p_discord_user_id AND e.enabled
    ),
    'attendance_date',v_existing.attendance_date,
    'first_seen_at',v_existing.first_seen_at,
    'first_message_id',v_existing.first_message_id,
    'duplicate',true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_swat_daily_attendance(text,date,text,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_swat_daily_attendance(text,date,text,text,text,text,timestamptz)
  TO service_role, postgres;

NOTIFY pgrst, 'reload schema';
