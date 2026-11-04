ALTER TABLE public.staff_profiles
  ALTER COLUMN notifications_enabled SET DEFAULT true;

UPDATE public.staff_profiles
SET notifications_enabled = true
WHERE notifications_enabled IS DISTINCT FROM true;
