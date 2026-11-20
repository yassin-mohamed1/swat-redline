-- Keep the original attendance voice-check status in sync with the admin-alert verifier.

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
         voice_verification_status = 'verified',
         voice_check_status = 'confirmed'
   WHERE discord_user_id = NEW.discord_user_id
     AND attendance_date = NEW.attendance_date
     AND first_seen_at <= NEW.joined_at
     AND voice_verification_status = 'pending'
     AND voice_joined_at IS NULL;
  RETURN NEW;
END;
$$;

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
      NEW.voice_check_status := 'confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
