-- Dedicated promotion history, current-rank update, and an auditable server-side write.
CREATE TABLE IF NOT EXISTS public.staff_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id text NOT NULL
    REFERENCES public.staff_profiles(discord_user_id) ON DELETE CASCADE,
  member_name text NOT NULL CHECK (length(trim(member_name)) BETWEEN 1 AND 100),
  old_rank_role_id text CHECK (old_rank_role_id IS NULL OR old_rank_role_id ~ '^[0-9]{15,22}$'),
  old_rank_role_name text CHECK (old_rank_role_name IS NULL OR length(old_rank_role_name) <= 100),
  new_rank_role_id text NOT NULL CHECK (new_rank_role_id ~ '^[0-9]{15,22}$'),
  new_rank_role_name text NOT NULL CHECK (length(trim(new_rank_role_name)) BETWEEN 1 AND 100),
  old_city_rank text,
  new_city_rank text NOT NULL CHECK (new_city_rank = ANY (ARRAY[
    'swat_commander','deputy_swat_commander','swat_team_leader','swat_supervisor',
    'swat_senior_operator','swat_operator','swat_recruit'
  ]::text[])),
  old_callsign text CHECK (old_callsign IS NULL OR old_callsign ~ '^Alpha (0|[1-9][0-9]*)$'),
  new_callsign text CHECK (new_callsign IS NULL OR new_callsign ~ '^Alpha (0|[1-9][0-9]*)$'),
  callsign_changed boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 240),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 800),
  promoted_by_discord_id text NOT NULL CHECK (promoted_by_discord_id ~ '^[0-9]{15,22}$'),
  promoted_by_name text NOT NULL CHECK (length(trim(promoted_by_name)) BETWEEN 1 AND 100),
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9]{15,22}$'),
  announcement_status text NOT NULL DEFAULT 'pending'
    CHECK (announcement_status = ANY (ARRAY['pending','sent','failed']::text[])),
  announcement_message_id text CHECK (announcement_message_id IS NULL OR announcement_message_id ~ '^[0-9]{15,22}$'),
  announcement_error_code text CHECK (announcement_error_code IS NULL OR length(announcement_error_code) <= 120),
  announced_at timestamptz,
  dm_status text NOT NULL DEFAULT 'pending'
    CHECK (dm_status = ANY (ARRAY['pending','sent','failed','skipped']::text[])),
  dm_channel_id text CHECK (dm_channel_id IS NULL OR dm_channel_id ~ '^[0-9]{15,22}$'),
  dm_message_id text CHECK (dm_message_id IS NULL OR dm_message_id ~ '^[0-9]{15,22}$'),
  dm_error_code text CHECK (dm_error_code IS NULL OR length(dm_error_code) <= 120),
  dm_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_promotions_channel_message_pair_check CHECK (
    (announcement_message_id IS NULL AND announcement_status <> 'sent')
    OR announcement_message_id IS NOT NULL
  ),
  CONSTRAINT staff_promotions_dm_message_pair_check CHECK (
    (dm_message_id IS NULL AND dm_status <> 'sent') OR dm_message_id IS NOT NULL
  ),
  CONSTRAINT staff_promotions_dm_channel_pair_check CHECK (
    (dm_channel_id IS NULL AND dm_status <> 'sent') OR dm_channel_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS staff_promotions_created_at_idx
  ON public.staff_promotions (created_at DESC);
CREATE INDEX IF NOT EXISTS staff_promotions_member_created_at_idx
  ON public.staff_promotions (discord_user_id, created_at DESC);

ALTER TABLE public.staff_promotions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.staff_promotions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_promotions TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;

CREATE OR REPLACE FUNCTION public.record_staff_promotion(
  p_discord_user_id text,
  p_member_name text,
  p_old_rank_role_id text,
  p_old_rank_role_name text,
  p_new_rank_role_id text,
  p_new_rank_role_name text,
  p_old_city_rank text,
  p_new_city_rank text,
  p_old_callsign text,
  p_new_callsign text,
  p_callsign_changed boolean,
  p_reason text,
  p_description text,
  p_promoted_by_discord_id text,
  p_promoted_by_name text,
  p_channel_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_assignment public.staff_assignments%rowtype;
  v_promotion public.staff_promotions%rowtype;
  v_rank_ids text[];
  v_rank_names text[];
BEGIN
  IF p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_promoted_by_discord_id !~ '^[0-9]{15,22}$'
     OR p_channel_id !~ '^[0-9]{15,22}$'
     OR length(trim(coalesce(p_member_name,''))) NOT BETWEEN 1 AND 100
     OR length(trim(coalesce(p_new_rank_role_name,''))) NOT BETWEEN 1 AND 100
     OR p_new_rank_role_id !~ '^[0-9]{15,22}$'
     OR p_new_city_rank NOT IN ('swat_commander','deputy_swat_commander','swat_team_leader','swat_supervisor','swat_senior_operator','swat_operator','swat_recruit')
     OR (p_old_rank_role_id IS NOT NULL AND p_old_rank_role_id !~ '^[0-9]{15,22}$')
     OR (p_old_rank_role_name IS NOT NULL AND length(p_old_rank_role_name) > 100)
     OR (p_old_callsign IS NOT NULL AND p_old_callsign !~ '^Alpha (0|[1-9][0-9]*)$')
     OR (p_new_callsign IS NOT NULL AND p_new_callsign !~ '^Alpha (0|[1-9][0-9]*)$')
     OR length(trim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 240
     OR length(trim(coalesce(p_description,''))) NOT BETWEEN 3 AND 800
     OR length(trim(coalesce(p_promoted_by_name,''))) NOT BETWEEN 1 AND 100
     OR p_callsign_changed IS NULL THEN
    RAISE EXCEPTION 'invalid_staff_promotion' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.staff_profiles
   WHERE discord_user_id = p_discord_user_id AND is_active AND NOT is_banned
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_promotion_member_unavailable' USING ERRCODE = '22023';
  END IF;

  IF p_new_callsign IS NOT NULL THEN
    PERFORM 1 FROM public.staff_callsigns
     WHERE callsign = p_new_callsign AND is_active
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'staff_promotion_callsign_unavailable' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.staff_assignments
       WHERE callsign = p_new_callsign AND status = 'assigned'
         AND discord_user_id <> p_discord_user_id
    ) THEN
      RAISE EXCEPTION 'staff_promotion_callsign_in_use' USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT * INTO v_assignment
    FROM public.staff_assignments
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;
  IF FOUND THEN
    v_before := jsonb_build_object(
      'rank_role_id', v_assignment.rank_role_id,
      'rank_role_name', v_assignment.rank_role_name,
      'rank_role_ids', v_assignment.rank_role_ids,
      'rank_role_names', v_assignment.rank_role_names,
      'callsign', v_assignment.callsign,
      'status', v_assignment.status
    );
  END IF;

  v_rank_ids := ARRAY[p_new_rank_role_id]::text[];
  v_rank_names := ARRAY[left(trim(p_new_rank_role_name),100)]::text[];
  INSERT INTO public.staff_assignments(
    discord_user_id,display_name,rank_role_id,rank_role_name,rank_role_ids,rank_role_names,
    callsign,status,assigned_by_discord_id,assigned_by_name,created_at,updated_at
  ) VALUES (
    p_discord_user_id,left(trim(p_member_name),100),p_new_rank_role_id,
    left(trim(p_new_rank_role_name),100),v_rank_ids,v_rank_names,p_new_callsign,'assigned',
    p_promoted_by_discord_id,left(trim(p_promoted_by_name),100),now(),now()
  )
  ON CONFLICT (discord_user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    rank_role_id = EXCLUDED.rank_role_id,
    rank_role_name = EXCLUDED.rank_role_name,
    rank_role_ids = EXCLUDED.rank_role_ids,
    rank_role_names = EXCLUDED.rank_role_names,
    callsign = EXCLUDED.callsign,
    status = 'assigned',
    assigned_by_discord_id = EXCLUDED.assigned_by_discord_id,
    assigned_by_name = EXCLUDED.assigned_by_name,
    updated_at = now()
  RETURNING * INTO v_assignment;

  INSERT INTO public.staff_member_identities(discord_user_id,city_rank,updated_at)
  VALUES (p_discord_user_id,p_new_city_rank,now())
  ON CONFLICT (discord_user_id) DO UPDATE SET
    city_rank = EXCLUDED.city_rank,
    updated_at = now();

  INSERT INTO public.staff_promotions(
    discord_user_id,member_name,old_rank_role_id,old_rank_role_name,
    new_rank_role_id,new_rank_role_name,old_city_rank,new_city_rank,
    old_callsign,new_callsign,callsign_changed,reason,description,
    promoted_by_discord_id,promoted_by_name,channel_id
  ) VALUES (
    p_discord_user_id,left(trim(p_member_name),100),p_old_rank_role_id,
    nullif(left(trim(coalesce(p_old_rank_role_name,'')),100),''),
    p_new_rank_role_id,left(trim(p_new_rank_role_name),100),p_old_city_rank,
    p_new_city_rank,p_old_callsign,p_new_callsign,p_callsign_changed,
    left(trim(p_reason),240),left(trim(p_description),800),
    p_promoted_by_discord_id,left(trim(p_promoted_by_name),100),p_channel_id
  ) RETURNING * INTO v_promotion;

  INSERT INTO public.audit_logs(actor_discord_id,actor_name,action,entity_type,entity_id,details)
  VALUES (
    p_promoted_by_discord_id,left(trim(p_promoted_by_name),100),'update','staff_promotion',v_promotion.id::text,
    jsonb_build_object(
      'type','ترقية فرد',
      'detail','تمت ترقية ' || left(trim(p_member_name),100) || ' إلى ' || left(trim(p_new_rank_role_name),100),
      'target_discord_id',p_discord_user_id,
      'promotion_id',v_promotion.id,
      'before',v_before,
      'after',jsonb_build_object('rank_role_id',p_new_rank_role_id,'rank_role_name',p_new_rank_role_name,
        'city_rank',p_new_city_rank,'callsign',p_new_callsign),
      'reason',left(trim(p_reason),240)
    )
  );

  RETURN jsonb_build_object('ok',true,'promotion',to_jsonb(v_promotion));
END;
$$;

REVOKE ALL ON FUNCTION public.record_staff_promotion(text,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_staff_promotion(text,text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
