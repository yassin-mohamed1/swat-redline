-- Multi-rank personnel assignments and an owner-managed Alpha callsign catalogue.
-- Existing singular assignment columns are retained for compatibility; existing rows are backfilled.

ALTER TABLE public.staff_assignments
  ADD COLUMN IF NOT EXISTS rank_role_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS rank_role_names text[] NOT NULL DEFAULT '{}'::text[];

UPDATE public.staff_assignments
   SET rank_role_ids = CASE
         WHEN status = 'assigned' AND rank_role_id IS NOT NULL AND cardinality(rank_role_ids) = 0
         THEN ARRAY[rank_role_id]::text[]
         ELSE rank_role_ids
       END,
       rank_role_names = CASE
         WHEN status = 'assigned' AND rank_role_name IS NOT NULL AND cardinality(rank_role_names) = 0
         THEN ARRAY[rank_role_name]::text[]
         ELSE rank_role_names
       END
 WHERE status = 'assigned';

CREATE TABLE IF NOT EXISTS public.staff_callsigns (
  callsign text PRIMARY KEY
    CHECK (callsign ~ '^Alpha (0|[1-9][0-9]*)$'),
  created_by_discord_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.staff_callsigns ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.staff_callsigns FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.staff_callsigns TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;

INSERT INTO public.staff_callsigns(callsign)
SELECT 'Alpha ' || n::text
  FROM generate_series(0,15) AS n
ON CONFLICT (callsign) DO NOTHING;

CREATE OR REPLACE FUNCTION public.save_staff_assignment_v2(
  p_discord_user_id text,
  p_display_name text,
  p_username text,
  p_avatar_url text,
  p_rank_role_ids text[],
  p_rank_role_names text[],
  p_callsign text,
  p_status text,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_row public.staff_assignments%rowtype;
  v_action text;
  v_ids text[] := coalesce(p_rank_role_ids, '{}'::text[]);
  v_names text[] := coalesce(p_rank_role_names, '{}'::text[]);
  v_unique_count integer;
BEGIN
  IF p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_status NOT IN ('assigned','unassigned')
     OR length(trim(coalesce(p_display_name,''))) = 0
     OR length(p_display_name) > 100
     OR cardinality(v_ids) <> cardinality(v_names)
     OR (p_status = 'assigned' AND (
       cardinality(v_ids) < 1 OR cardinality(v_ids) > 20
       OR EXISTS (SELECT 1 FROM unnest(v_ids) AS value WHERE value !~ '^[0-9]{15,22}$')
       OR EXISTS (SELECT 1 FROM unnest(v_names) AS value WHERE length(trim(coalesce(value,''))) = 0 OR length(value) > 100)
       OR (p_callsign IS NOT NULL AND p_callsign !~ '^Alpha (0|[1-9][0-9]*)$')
     ))
     OR (p_status = 'unassigned' AND (
       cardinality(v_ids) <> 0 OR cardinality(v_names) <> 0 OR p_callsign IS NOT NULL
     )) THEN
    RAISE EXCEPTION 'invalid_staff_assignment' USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT value) INTO v_unique_count FROM unnest(v_ids) AS value;
  IF v_unique_count <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'duplicate_staff_assignment_role' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'discord_user_id', discord_user_id,
    'display_name', display_name,
    'rank_role_id', rank_role_id,
    'rank_role_name', rank_role_name,
    'rank_role_ids', rank_role_ids,
    'rank_role_names', rank_role_names,
    'callsign', callsign,
    'status', status
  )
  INTO v_before
  FROM public.staff_assignments
  WHERE discord_user_id = p_discord_user_id
  FOR UPDATE;

  INSERT INTO public.staff_assignments(
    discord_user_id, display_name, username, avatar_url,
    rank_role_id, rank_role_name, rank_role_ids, rank_role_names, callsign, status,
    assigned_by_discord_id, assigned_by_name, created_at, updated_at
  ) VALUES (
    p_discord_user_id,
    left(trim(p_display_name),100),
    nullif(left(coalesce(p_username,''),100),''),
    nullif(p_avatar_url,''),
    CASE WHEN p_status = 'assigned' THEN v_ids[1] ELSE NULL END,
    CASE WHEN p_status = 'assigned' THEN v_names[1] ELSE NULL END,
    v_ids,
    v_names,
    p_callsign,
    p_status,
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    now(),
    now()
  )
  ON CONFLICT (discord_user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    username = EXCLUDED.username,
    avatar_url = coalesce(EXCLUDED.avatar_url, public.staff_assignments.avatar_url),
    rank_role_id = EXCLUDED.rank_role_id,
    rank_role_name = EXCLUDED.rank_role_name,
    rank_role_ids = EXCLUDED.rank_role_ids,
    rank_role_names = EXCLUDED.rank_role_names,
    callsign = EXCLUDED.callsign,
    status = EXCLUDED.status,
    assigned_by_discord_id = EXCLUDED.assigned_by_discord_id,
    assigned_by_name = EXCLUDED.assigned_by_name,
    updated_at = now()
  RETURNING * INTO v_row;

  v_after := jsonb_build_object(
    'discord_user_id', v_row.discord_user_id,
    'display_name', v_row.display_name,
    'rank_role_id', v_row.rank_role_id,
    'rank_role_name', v_row.rank_role_name,
    'rank_role_ids', v_row.rank_role_ids,
    'rank_role_names', v_row.rank_role_names,
    'callsign', v_row.callsign,
    'status', v_row.status
  );

  v_action := CASE
    WHEN p_status = 'unassigned' THEN 'delete'
    WHEN v_before IS NULL THEN 'create'
    ELSE 'update'
  END;

  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(coalesce(p_actor_name,'Unknown user'),100),
    v_action,
    'staff_assignment',
    p_discord_user_id,
    jsonb_build_object(
      'type', CASE WHEN p_status = 'unassigned' THEN 'إنهاء تعيين فرد'
                   WHEN v_before IS NULL THEN 'تعيين فرد'
                   ELSE 'تعديل التعيين' END,
      'detail', CASE WHEN p_status = 'unassigned'
                     THEN 'تم إنهاء تعيين ' || v_row.display_name
                     ELSE 'تم تعيين ' || v_row.display_name || ' بالرتب ' ||
                          array_to_string(v_row.rank_role_names, '، ') ||
                          coalesce(' • ' || v_row.callsign,'') END,
      'target_discord_id', p_discord_user_id,
      'before', v_before,
      'after', v_after
    )
  );

  RETURN jsonb_build_object('ok',true,'before',v_before,'after',v_after);
END;
$$;

REVOKE ALL ON FUNCTION public.save_staff_assignment_v2(text,text,text,text,text[],text[],text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_staff_assignment_v2(text,text,text,text,text[],text[],text,text,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
