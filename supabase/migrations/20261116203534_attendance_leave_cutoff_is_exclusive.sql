ALTER TABLE public.attendance_leave_requests
  DROP CONSTRAINT IF EXISTS attendance_leave_requests_cutoff_date_check;

ALTER TABLE public.attendance_leave_requests
  ADD CONSTRAINT attendance_leave_requests_cutoff_date_check
  CHECK (
    cutoff_date IS NULL OR
    (start_date IS NOT NULL AND end_date IS NOT NULL AND
     cutoff_date >= start_date AND cutoff_date <= end_date)
  );

UPDATE public.attendance_leave_requests
SET status = 'cancelled', updated_at = now()
WHERE status = 'approved'
  AND cutoff_date IS NOT NULL
  AND start_date IS NOT NULL
  AND cutoff_date <= start_date;
