DROP INDEX IF EXISTS public.audit_logs_event_key_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_event_key_uidx
  ON public.audit_logs(event_key);

COMMENT ON INDEX public.audit_logs_event_key_uidx IS
  'Enforces idempotency for login/logout audit events while allowing multiple NULL event keys.';

NOTIFY pgrst, 'reload schema';
