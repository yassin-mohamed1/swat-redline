ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.staff_profiles.notifications_enabled IS
  'Whether this Discord staff member has opted in to direct-message notifications from the S.W.A.T. REDLINE bot.';
