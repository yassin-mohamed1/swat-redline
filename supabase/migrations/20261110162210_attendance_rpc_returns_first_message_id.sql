-- Return the original message ID so a retried poll can resend a missing confirmation safely.
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
    RETURN jsonb_build_object('recorded',false,'eligible',false,'duplicate',false);
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
      'recorded',true,
      'eligible',true,
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
    'recorded',false,
    'eligible',true,
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
  TO service_role;

NOTIFY pgrst,'reload schema';
