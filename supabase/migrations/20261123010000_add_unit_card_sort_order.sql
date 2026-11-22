-- Persist the portal's manual ordering for published S.W.A.T. unit identity cards.
-- This does not modify or recreate any Discord messages.

ALTER TABLE public.staff_member_identities
  ADD COLUMN IF NOT EXISTS unit_sort_order integer;

ALTER TABLE public.staff_member_identities
  DROP CONSTRAINT IF EXISTS staff_member_identities_unit_sort_order_check;

ALTER TABLE public.staff_member_identities
  ADD CONSTRAINT staff_member_identities_unit_sort_order_check
  CHECK (unit_sort_order IS NULL OR unit_sort_order >= 0);

CREATE INDEX IF NOT EXISTS staff_member_identities_unit_order_idx
  ON public.staff_member_identities (channel_id, unit_sort_order)
  WHERE message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.save_staff_unit_card_order(
  p_discord_user_ids text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer := COALESCE(cardinality(p_discord_user_ids), 0);
  v_unique_count integer;
  v_updated integer;
BEGIN
  IF v_count < 1 OR v_count > 250 THEN
    RAISE EXCEPTION 'invalid_unit_card_order_count' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_discord_user_ids) AS item(discord_user_id)
    WHERE item.discord_user_id IS NULL
       OR item.discord_user_id !~ '^[0-9]{15,22}$'
  ) THEN
    RAISE EXCEPTION 'invalid_unit_card_discord_id' USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT item.discord_user_id)
    INTO v_unique_count
  FROM unnest(p_discord_user_ids) AS item(discord_user_id);

  IF v_unique_count <> v_count THEN
    RAISE EXCEPTION 'duplicate_unit_card_discord_id' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_discord_user_ids) AS requested(discord_user_id)
    LEFT JOIN public.staff_member_identities AS identity
      ON identity.discord_user_id = requested.discord_user_id
     AND identity.channel_id = '1561490450953670817'
     AND identity.message_id IS NOT NULL
    WHERE identity.discord_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'unit_card_identity_not_found' USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_member_identities AS identity
     SET unit_sort_order = requested.sort_position - 1,
         updated_at = now()
    FROM unnest(p_discord_user_ids) WITH ORDINALITY
      AS requested(discord_user_id, sort_position)
   WHERE identity.discord_user_id = requested.discord_user_id
     AND identity.channel_id = '1561490450953670817'
     AND identity.message_id IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_count THEN
    RAISE EXCEPTION 'unit_card_order_update_incomplete' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'updated_count', v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.save_staff_unit_card_order(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_staff_unit_card_order(text[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
