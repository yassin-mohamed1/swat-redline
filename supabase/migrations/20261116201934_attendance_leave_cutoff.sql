ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS cutoff_date date,
  ADD COLUMN IF NOT EXISTS cut_by_discord_id text,
  ADD COLUMN IF NOT EXISTS cut_by_name text,
  ADD COLUMN IF NOT EXISTS cut_at timestamptz,
  ADD COLUMN IF NOT EXISTS cut_reason text,
  ADD COLUMN IF NOT EXISTS cut_dm_status text NOT NULL DEFAULT 'not_sent',
  ADD COLUMN IF NOT EXISTS cut_dm_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_leave_requests_cutoff_date_check'
      AND conrelid = 'public.attendance_leave_requests'::regclass
  ) THEN
    ALTER TABLE public.attendance_leave_requests
      ADD CONSTRAINT attendance_leave_requests_cutoff_date_check
      CHECK (
        cutoff_date IS NULL OR
        (start_date IS NOT NULL AND end_date IS NOT NULL AND
         cutoff_date >= start_date - 1 AND cutoff_date < end_date)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_leave_requests_cut_dm_status_check'
      AND conrelid = 'public.attendance_leave_requests'::regclass
  ) THEN
    ALTER TABLE public.attendance_leave_requests
      ADD CONSTRAINT attendance_leave_requests_cut_dm_status_check
      CHECK (cut_dm_status IN ('not_sent','sent','failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS attendance_leave_requests_active_cutoff_idx
  ON public.attendance_leave_requests (discord_user_id, start_date, cutoff_date)
  WHERE status = 'approved';
