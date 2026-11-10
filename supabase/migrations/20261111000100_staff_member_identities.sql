CREATE TABLE IF NOT EXISTS public.staff_member_identities (
  discord_user_id text PRIMARY KEY
    REFERENCES public.staff_profiles(discord_user_id) ON DELETE CASCADE,
  city_rank text NOT NULL
    CHECK (city_rank = ANY (ARRAY[
      'swat_commander',
      'deputy_swat_commander',
      'swat_team_leader',
      'swat_supervisor',
      'swat_senior_operator',
      'swat_operator',
      'swat_recruit'
    ]::text[])),
  channel_id text
    CHECK (channel_id IS NULL OR channel_id ~ '^[0-9]{15,22}$'),
  message_id text
    CHECK (message_id IS NULL OR message_id ~ '^[0-9]{15,22}$'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_member_identities_message_pair_check CHECK (
    (channel_id IS NULL AND message_id IS NULL)
    OR
    (channel_id IS NOT NULL AND message_id IS NOT NULL)
  ),
  CONSTRAINT staff_member_identities_message_unique UNIQUE (message_id)
);

COMMENT ON TABLE public.staff_member_identities IS
  'Portal-managed S.W.A.T. city rank and the single Discord identity message for each staff member.';
COMMENT ON COLUMN public.staff_member_identities.city_rank IS
  'Independent city rank key, separate from the member Discord roles and assignment-role selection.';
COMMENT ON COLUMN public.staff_member_identities.message_id IS
  'Discord message ID for the member identity card; PATCH this message instead of posting duplicates.';

ALTER TABLE public.staff_member_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.staff_member_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_member_identities TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;
