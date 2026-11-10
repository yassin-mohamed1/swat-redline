-- Daily attendance ledger for SWAT members.
CREATE TABLE IF NOT EXISTS public.attendance_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  discord_user_id text NOT NULL CHECK (discord_user_id ~ '^[0-9]{15,22}$'),
  attendance_date date NOT NULL,
  first_message_id text NOT NULL,
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9]{15,22}$'),
  display_name text NOT NULL,
  username text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  timezone text NOT NULL DEFAULT 'Asia/Riyadh',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_records_user_date_unique UNIQUE (discord_user_id, attendance_date),
  CONSTRAINT attendance_records_message_unique UNIQUE (first_message_id)
);
CREATE INDEX IF NOT EXISTS attendance_records_date_user_idx
  ON public.attendance_records (attendance_date DESC, discord_user_id);

ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.attendance_records TO service_role;

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

  INSERT INTO public.attendance_records(
    discord_user_id,attendance_date,first_message_id,channel_id,
    display_name,username,first_seen_at,timezone
  ) VALUES (
    p_discord_user_id,p_attendance_date,p_message_id,p_channel_id,
    left(trim(p_display_name),100),nullif(left(coalesce(p_username,''),100),''),
    coalesce(p_first_seen_at,now()),'Asia/Riyadh'
  )
  ON CONFLICT (discord_user_id,attendance_date) DO NOTHING
  RETURNING * INTO v_inserted;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'recorded',true,
      'attendance_date',v_inserted.attendance_date,
      'first_seen_at',v_inserted.first_seen_at,
      'duplicate',false
    );
  END IF;

  SELECT * INTO v_existing
    FROM public.attendance_records
   WHERE discord_user_id=p_discord_user_id
     AND attendance_date=p_attendance_date;

  RETURN jsonb_build_object(
    'recorded',false,
    'attendance_date',v_existing.attendance_date,
    'first_seen_at',v_existing.first_seen_at,
    'duplicate',true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_swat_daily_attendance(text,date,text,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_swat_daily_attendance(text,date,text,text,text,text,timestamptz)
  TO service_role;

NOTIFY pgrst,'reload schema';
