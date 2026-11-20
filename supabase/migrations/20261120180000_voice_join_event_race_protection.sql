-- Preserve voice joins that race ahead of the attendance poller, and apply them when the stamp row arrives.

CREATE TABLE IF NOT EXISTS public.attendance_voice_join_events (
  event_key text PRIMARY KEY,
  discord_user_id text NOT NULL CHECK (discord_user_id ~ '^[0-9]{15,22}$'),
  attendance_date date NOT NULL,
  voice_channel_id text NOT NULL CHECK (voice_channel_id ~ '^[0-9]{15,22}$'),
  joined_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_voice_join_event_key_length CHECK (length(event_key) BETWEEN 1 AND 180)
);

CREATE INDEX IF NOT EXISTS attendance_voice_join_events_match_idx
  ON public.attendance_voice_join_events (discord_user_id, attendance_date, joined_at);

ALTER TABLE public.attendance_voice_join_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_voice_join_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.attendance_voice_join_events TO service_role;

CREATE OR REPLACE FUNCTION public.apply_swat_voice_join_to_existing_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.attendance_records
     SET voice_joined_at = NEW.joined_at,
         voice_channel_id = NEW.voice_channel_id,
         voice_verification_status = 'verified'
   WHERE discord_user_id = NEW.discord_user_id
     AND attendance_date = NEW.attendance_date
     AND first_seen_at <= NEW.joined_at
     AND voice_verification_status = 'pending'
     AND voice_joined_at IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_voice_join_apply_existing ON public.attendance_voice_join_events;
CREATE TRIGGER attendance_voice_join_apply_existing
AFTER INSERT ON public.attendance_voice_join_events
FOR EACH ROW
EXECUTE FUNCTION public.apply_swat_voice_join_to_existing_attendance();

CREATE OR REPLACE FUNCTION public.match_swat_voice_join_before_attendance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_join public.attendance_voice_join_events%rowtype;
BEGIN
  IF NEW.voice_verification_status = 'pending' AND NEW.voice_joined_at IS NULL THEN
    SELECT * INTO v_join
      FROM public.attendance_voice_join_events
     WHERE discord_user_id = NEW.discord_user_id
       AND attendance_date = NEW.attendance_date
       AND joined_at >= NEW.first_seen_at
     ORDER BY joined_at ASC
     LIMIT 1;
    IF FOUND THEN
      NEW.voice_joined_at := v_join.joined_at;
      NEW.voice_channel_id := v_join.voice_channel_id;
      NEW.voice_verification_status := 'verified';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_match_voice_join_before_insert ON public.attendance_records;
CREATE TRIGGER attendance_match_voice_join_before_insert
BEFORE INSERT ON public.attendance_records
FOR EACH ROW
EXECUTE FUNCTION public.match_swat_voice_join_before_attendance();

CREATE OR REPLACE FUNCTION public.record_swat_attendance_voice_join(
  p_event_key text,
  p_discord_user_id text,
  p_attendance_date date,
  p_voice_channel_id text,
  p_joined_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inserted public.attendance_voice_join_events%rowtype;
BEGIN
  IF length(coalesce(p_event_key,'')) NOT BETWEEN 1 AND 180
     OR p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_voice_channel_id !~ '^[0-9]{15,22}$'
     OR p_attendance_date IS NULL
     OR p_joined_at IS NULL THEN
    RAISE EXCEPTION 'invalid_attendance_voice_join' USING ERRCODE='22023';
  END IF;

  DELETE FROM public.attendance_voice_join_events
   WHERE created_at < now() - interval '30 days';

  INSERT INTO public.attendance_voice_join_events(
    event_key,discord_user_id,attendance_date,voice_channel_id,joined_at
  ) VALUES (
    p_event_key,p_discord_user_id,p_attendance_date,p_voice_channel_id,p_joined_at
  )
  ON CONFLICT (event_key) DO NOTHING
  RETURNING * INTO v_inserted;

  RETURN jsonb_build_object(
    'recorded',FOUND,
    'attendance_date',p_attendance_date,
    'joined_at',p_joined_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_swat_attendance_voice_join(text,text,date,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_swat_attendance_voice_join(text,text,date,text,timestamptz)
  TO service_role;

NOTIFY pgrst, 'reload schema';
