ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS military_name text,
  ADD COLUMN IF NOT EXISTS requested_duration_days smallint,
  ADD COLUMN IF NOT EXISTS discord_interaction_id text;

ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_military_name_check
    CHECK (military_name IS NULL OR length(trim(military_name)) BETWEEN 2 AND 100),
  ADD CONSTRAINT attendance_leave_requests_requested_duration_check
    CHECK (requested_duration_days IS NULL OR requested_duration_days BETWEEN 1 AND 365),
  ADD CONSTRAINT attendance_leave_requests_interaction_id_check
    CHECK (discord_interaction_id IS NULL OR discord_interaction_id ~ '^[0-9]{15,22}$');

CREATE UNIQUE INDEX IF NOT EXISTS attendance_leave_requests_interaction_unique
  ON public.attendance_leave_requests (discord_interaction_id)
  WHERE discord_interaction_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
