-- Keep the audit log append-only for the server role.
-- Portal APIs require SELECT and INSERT only; they never rewrite audit history.
REVOKE ALL PRIVILEGES ON TABLE public.audit_logs FROM service_role;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO service_role;
