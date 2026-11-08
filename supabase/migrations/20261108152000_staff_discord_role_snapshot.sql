ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS discord_roles text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS discord_roles_synced_at timestamptz;

COMMENT ON COLUMN public.staff_profiles.discord_roles IS
  'Role IDs observed for this member during their most recent successful Discord portal login.';
COMMENT ON COLUMN public.staff_profiles.discord_roles_synced_at IS
  'Timestamp when discord_roles was last refreshed during Discord OAuth login.';
