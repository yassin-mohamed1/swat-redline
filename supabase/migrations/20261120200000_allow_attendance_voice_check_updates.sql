-- The attendance poller and voice-state worker may update only the new voice-check fields.
GRANT UPDATE (voice_check_status, voice_check_deadline_at, voice_joined_at, voice_alerted_at)
  ON TABLE public.attendance_records TO service_role;
