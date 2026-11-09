ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS registration_source text;

UPDATE public.staff_profiles
   SET registration_source = CASE
     WHEN is_manual IS TRUE THEN 'manual_id'
     WHEN is_manual IS FALSE
      AND COALESCE(login_count, 0) = 0
      AND last_login IS NULL
      AND '1561561038263029900' = ANY(COALESCE(discord_roles, ARRAY[]::text[]))
       THEN 'bot_role'
     ELSE 'oauth'
   END
 WHERE registration_source IS NULL;

ALTER TABLE public.staff_profiles
  ALTER COLUMN registration_source SET DEFAULT 'oauth',
  ALTER COLUMN registration_source SET NOT NULL;

ALTER TABLE public.staff_profiles
  DROP CONSTRAINT IF EXISTS staff_profiles_registration_source_check;

ALTER TABLE public.staff_profiles
  ADD CONSTRAINT staff_profiles_registration_source_check
  CHECK (registration_source IN ('manual_id', 'bot_role', 'oauth'));

COMMENT ON COLUMN public.staff_profiles.registration_source IS
  'Original portal registration path: manual Discord ID, automatic Discord access-role sync, or Discord OAuth login.';
