-- Admin alert routing, daily voice attendance verification, and retryable Discord notifications.

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS voice_joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_channel_id text,
  ADD COLUMN IF NOT EXISTS voice_verification_status text,
  ADD COLUMN IF NOT EXISTS voice_alert_queued_at timestamptz;

-- Do not retroactively accuse members for attendance records created before this feature.
UPDATE public.attendance_records
   SET voice_verification_status = 'legacy'
 WHERE voice_verification_status IS NULL;

ALTER TABLE public.attendance_records
  ALTER COLUMN voice_verification_status SET DEFAULT 'pending',
  ALTER COLUMN voice_verification_status SET NOT NULL;

ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_voice_verification_status_check;
ALTER TABLE public.attendance_records
  ADD CONSTRAINT attendance_records_voice_verification_status_check
  CHECK (voice_verification_status IN ('pending','verified','notified','legacy'));

ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_voice_channel_id_check;
ALTER TABLE public.attendance_records
  ADD CONSTRAINT attendance_records_voice_channel_id_check
  CHECK (voice_channel_id IS NULL OR voice_channel_id ~ '^[0-9]{15,22}$');

CREATE INDEX IF NOT EXISTS attendance_records_voice_pending_idx
  ON public.attendance_records (attendance_date, voice_verification_status)
  WHERE voice_verification_status = 'pending';

-- Existing leave requests are historical and must not generate a new admin alert on rollout.
ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS admin_alert_queued_at timestamptz;
UPDATE public.attendance_leave_requests
   SET admin_alert_queued_at = coalesce(submitted_at, created_at, now())
 WHERE admin_alert_queued_at IS NULL;

CREATE INDEX IF NOT EXISTS attendance_leave_requests_admin_alert_idx
  ON public.attendance_leave_requests (created_at)
  WHERE status = 'pending' AND admin_alert_queued_at IS NULL;

CREATE TABLE IF NOT EXISTS public.attendance_admin_alerts (
  alert_key text PRIMARY KEY,
  alert_type text NOT NULL CHECK (alert_type IN ('leave_request','warning_due','voice_missing')),
  discord_user_id text CHECK (discord_user_id IS NULL OR discord_user_id ~ '^[0-9]{15,22}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  discord_message_id text CHECK (discord_message_id IS NULL OR discord_message_id ~ '^[0-9]{15,22}$'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT attendance_admin_alerts_key_length CHECK (length(alert_key) BETWEEN 1 AND 220)
);

CREATE INDEX IF NOT EXISTS attendance_admin_alerts_delivery_idx
  ON public.attendance_admin_alerts (status, next_attempt_at, locked_until, created_at);

ALTER TABLE public.attendance_admin_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_admin_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance_admin_alerts TO service_role;

NOTIFY pgrst, 'reload schema';
