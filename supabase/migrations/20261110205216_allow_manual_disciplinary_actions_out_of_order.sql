-- Allow authorized administrators to choose any valid disciplinary action manually.
-- Attendance automation keeps its own 7/14/21-day staged checks in api/warnings.js.
-- A member already dismissed must still restart a new disciplinary cycle with Warning 1.

CREATE OR REPLACE FUNCTION public.begin_disciplinary_action(
  p_request_id uuid,
  p_discord_user_id text,
  p_target_name text,
  p_username text,
  p_avatar_url text,
  p_action_type text,
  p_warning_level integer,
  p_reason text,
  p_details text,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_subject public.disciplinary_subjects%rowtype;
  v_action public.disciplinary_actions%rowtype;
BEGIN
  IF p_request_id IS NULL
     OR p_discord_user_id !~ '^[0-9]{15,22}$'
     OR p_action_type NOT IN ('warning','dismissal')
     OR (p_action_type = 'warning' AND p_warning_level NOT IN (1,2))
     OR (p_action_type = 'dismissal' AND p_warning_level <> 3)
     OR length(trim(coalesce(p_reason,''))) = 0
     OR length(p_reason) > 1000
     OR length(coalesce(p_details,'')) > 3000 THEN
    RAISE EXCEPTION 'invalid_disciplinary_request' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.disciplinary_subjects(discord_user_id,display_name,username,avatar_url)
  VALUES (
    p_discord_user_id,
    left(coalesce(nullif(trim(p_target_name),''),'Discord user'),100),
    nullif(left(coalesce(p_username,''),100),''),
    nullif(p_avatar_url,'')
  )
  ON CONFLICT (discord_user_id) DO NOTHING;

  SELECT * INTO v_subject
    FROM public.disciplinary_subjects
   WHERE discord_user_id = p_discord_user_id
   FOR UPDATE;

  SELECT * INTO v_action
    FROM public.disciplinary_actions
   WHERE request_id = p_request_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'duplicate', true,
      'action_id', v_action.id,
      'status', v_action.status,
      'warning_level', v_action.warning_level,
      'action_type', v_action.action_type
    );
  END IF;

  -- Administrative actions are intentionally not forced through a warning ladder:
  -- Warning 2 can be issued directly, and dismissal can be issued directly.
  -- Only a previously dismissed member starting a new cycle is restricted to Warning 1.
  IF v_subject.status = 'dismissed' THEN
    IF p_action_type <> 'warning' OR p_warning_level <> 1 THEN
      RAISE EXCEPTION 'member_already_dismissed_start_with_warning_one'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.disciplinary_actions(
    request_id, discord_user_id, target_name, action_type, warning_level,
    reason, details, actor_discord_id, actor_name
  ) VALUES (
    p_request_id, p_discord_user_id, v_subject.display_name, p_action_type,
    p_warning_level, trim(p_reason), coalesce(p_details,''),
    p_actor_discord_id, left(p_actor_name,100)
  ) RETURNING * INTO v_action;

  RETURN jsonb_build_object(
    'duplicate', false,
    'action_id', v_action.id,
    'status', v_action.status,
    'warning_level', v_action.warning_level,
    'action_type', v_action.action_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_disciplinary_action(uuid,text,text,text,text,text,integer,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_disciplinary_action(uuid,text,text,text,text,text,integer,text,text,text,text)
  TO service_role;
