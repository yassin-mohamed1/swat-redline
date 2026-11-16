-- Track the daily Discord attendance-channel cleanup without changing attendance records.
ALTER TABLE public.attendance_sync_state
  ADD COLUMN IF NOT EXISTS channel_cleanup_date date,
  ADD COLUMN IF NOT EXISTS channel_cleanup_cursor text;
