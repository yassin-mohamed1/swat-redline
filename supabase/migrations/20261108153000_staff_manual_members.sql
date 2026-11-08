ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS is_manual boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_created_by_discord_id text;

COMMENT ON COLUMN public.staff_profiles.is_manual IS
  'True when an owner added this Discord guild member to the personnel directory without portal OAuth login.';
COMMENT ON COLUMN public.staff_profiles.manual_created_by_discord_id IS
  'Discord user ID of the owner who created the manual personnel profile.';

NOTIFY pgrst, 'reload schema';
