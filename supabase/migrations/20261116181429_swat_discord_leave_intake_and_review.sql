ALTER TABLE public.attendance_leave_requests
  ALTER COLUMN start_date DROP NOT NULL,
  ALTER COLUMN end_date DROP NOT NULL;

ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_check,
  ADD CONSTRAINT attendance_leave_requests_date_pair_check
    CHECK (
      (start_date IS NULL AND end_date IS NULL)
      OR
      (start_date IS NOT NULL AND end_date IS NOT NULL AND end_date >= start_date)
    ),
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_reason_check,
  ADD CONSTRAINT attendance_leave_requests_reason_check
    CHECK (length(trim(reason)) BETWEEN 3 AND 2000);

ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'website',
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS discord_channel_id text,
  ADD COLUMN IF NOT EXISTS discord_message_id text,
  ADD COLUMN IF NOT EXISTS discord_message_url text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS acknowledgement_message_id text,
  ADD COLUMN IF NOT EXISTS approved_duration_days smallint,
  ADD COLUMN IF NOT EXISTS dm_status text NOT NULL DEFAULT 'not_sent',
  ADD COLUMN IF NOT EXISTS dm_error text;

ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_source_check
    CHECK (source IN ('website','discord')),
  ADD CONSTRAINT attendance_leave_requests_channel_id_check
    CHECK (discord_channel_id IS NULL OR discord_channel_id ~ '^[0-9]{15,22}$'),
  ADD CONSTRAINT attendance_leave_requests_message_id_check
    CHECK (discord_message_id IS NULL OR discord_message_id ~ '^[0-9]{15,22}$'),
  ADD CONSTRAINT attendance_leave_requests_ack_message_id_check
    CHECK (acknowledgement_message_id IS NULL OR acknowledgement_message_id ~ '^[0-9]{15,22}$'),
  ADD CONSTRAINT attendance_leave_requests_duration_check
    CHECK (approved_duration_days IS NULL OR approved_duration_days BETWEEN 1 AND 365),
  ADD CONSTRAINT attendance_leave_requests_dm_status_check
    CHECK (dm_status IN ('not_sent','sent','skipped','failed')),
  ADD CONSTRAINT attendance_leave_requests_approved_dates_check
    CHECK (status <> 'approved' OR (start_date IS NOT NULL AND end_date IS NOT NULL)),
  ADD CONSTRAINT attendance_leave_requests_discord_message_unique
    UNIQUE (discord_channel_id, discord_message_id);

CREATE INDEX IF NOT EXISTS attendance_leave_requests_source_created_idx
  ON public.attendance_leave_requests (source, created_at DESC);

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  FOR v_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'swat-leave-request-poller'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'swat-leave-request-poller',
    '5 seconds',
    $job$
      SELECT net.http_get(
        url := 'https://swat-redline.vercel.app/api/notifications/send?task=leave',
        headers := jsonb_build_object(
          'x-announcement-sync-secret',
          (SELECT decrypted_secret
             FROM vault.decrypted_secrets
            WHERE name = 'swat_announcement_sync_secret')
        ),
        timeout_milliseconds := 55000
      ) AS request_id;
    $job$
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
