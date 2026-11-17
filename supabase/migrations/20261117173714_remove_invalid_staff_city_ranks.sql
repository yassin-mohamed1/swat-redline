ALTER TABLE public.staff_member_identities
  ALTER COLUMN city_rank DROP NOT NULL;

UPDATE public.staff_member_identities
SET city_rank = NULL,
    updated_at = now()
WHERE city_rank IN ('swat_senior_operator', 'swat_recruit');

ALTER TABLE public.staff_member_identities
  DROP CONSTRAINT IF EXISTS staff_member_identities_city_rank_check;

ALTER TABLE public.staff_member_identities
  ADD CONSTRAINT staff_member_identities_city_rank_check CHECK (
    city_rank IS NULL OR city_rank = ANY (ARRAY[
      'swat_commander',
      'deputy_swat_commander',
      'swat_team_leader',
      'swat_supervisor',
      'swat_operator'
    ]::text[])
  );
