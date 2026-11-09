-- Persistent cursor for the scheduled Discord access-role member scan.
CREATE TABLE IF NOT EXISTS public.discord_role_sync_state (
  guild_id text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{15,22}$'),
  cursor_id text NOT NULL DEFAULT '0' CHECK (cursor_id = '0' OR cursor_id ~ '^[0-9]{15,22}$'),
  last_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.discord_role_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.discord_role_sync_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.discord_role_sync_state TO service_role;

COMMENT ON TABLE public.discord_role_sync_state IS
  'Server-side cursor for scheduled, idempotent Discord member role synchronization.';
