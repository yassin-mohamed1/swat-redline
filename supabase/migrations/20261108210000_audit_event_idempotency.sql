ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS event_key text;

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_event_key_uidx
  ON public.audit_logs(event_key)
  WHERE event_key IS NOT NULL;

COMMENT ON COLUMN public.audit_logs.event_key IS
  'Optional idempotency key for server-generated audit events such as authenticated session login and logout.';

NOTIFY pgrst, 'reload schema';
