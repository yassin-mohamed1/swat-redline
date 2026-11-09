-- Include legacy browser-audit actor labels when anonymizing a deleted staff member.
CREATE OR REPLACE FUNCTION public.scrub_staff_member_identity(
  p_value jsonb,
  p_discord_user_id text,
  p_known_names text[]
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result jsonb;
  v_key text;
  v_child jsonb;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    v_result := '{}'::jsonb;
    FOR v_key, v_child IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
      IF v_key IN (
        'createdByDiscordId','created_by_discord_id','discordUserId',
        'discord_user_id','actorDiscordId','actor_discord_id','authorId','author_id'
      ) AND v_child = to_jsonb(p_discord_user_id) THEN
        CONTINUE;
      END IF;

      IF v_key IN (
        'owner','sentBy','sent_by','createdBy','created_by','createdByName',
        'created_by_name','author','user','username','displayName','display_name',
        'actor','actorName','actor_name','ownerName'
      ) AND jsonb_typeof(v_child) = 'string'
        AND (v_child #>> '{}') = ANY(coalesce(p_known_names, ARRAY[]::text[])) THEN
        v_result := v_result || jsonb_build_object(v_key, 'Deleted member');
      ELSE
        v_result := v_result || jsonb_build_object(
          v_key,
          public.scrub_staff_member_identity(v_child, p_discord_user_id, p_known_names)
        );
      END IF;
    END LOOP;
    RETURN v_result;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    SELECT coalesce(jsonb_agg(
      public.scrub_staff_member_identity(value, p_discord_user_id, p_known_names)
      ORDER BY ordinal
    ), '[]'::jsonb)
    INTO v_result
    FROM jsonb_array_elements(p_value) WITH ORDINALITY AS items(value, ordinal);
    RETURN v_result;
  END IF;
  RETURN p_value;
END;
$$;
REVOKE ALL ON FUNCTION public.scrub_staff_member_identity(jsonb,text,text[])
  FROM PUBLIC, anon, authenticated;
