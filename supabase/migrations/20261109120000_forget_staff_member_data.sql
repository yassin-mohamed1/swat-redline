-- Atomic permanent deletion of a portal member.
-- Unlike a ban, this stores no block marker; a new Discord OAuth login can create a fresh profile.

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
        'owner','sentBy','createdBy','created_by','author',
        'username','displayName','display_name','actorName','actor_name'
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

CREATE OR REPLACE FUNCTION public.forget_staff_member_data(
  p_discord_user_id text,
  p_actor_discord_id text,
  p_actor_name text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id text := trim(coalesce(p_discord_user_id, ''));
  v_profile_uuid uuid;
  v_known_names text[] := ARRAY[]::text[];
  v_profile_count integer := 0;
  v_event_count integer := 0;
  v_assignment_count integer := 0;
  v_disciplinary_action_count integer := 0;
  v_disciplinary_subject_count integer := 0;
  v_notification_delivery_count integer := 0;
  v_announcement_delivery_count integer := 0;
  v_batch_count integer := 0;
  v_forward_count integer := 0;
  v_callsign_count integer := 0;
  v_profile_creator_count integer := 0;
  v_assignment_actor_count integer := 0;
  v_case_creator_count integer := 0;
  v_operation_creator_count integer := 0;
  v_report_creator_count integer := 0;
  v_wanted_creator_count integer := 0;
  v_attachment_uploader_count integer := 0;
  v_setting_actor_count integer := 0;
  v_audit_delete_count integer := 0;
  v_audit_scrub_count integer := 0;
  v_app_state_count integer := 0;
BEGIN
  IF v_id !~ '^[0-9]{15,22}$'
     OR coalesce(p_actor_discord_id, '') !~ '^[0-9]{15,22}$'
     OR length(trim(coalesce(p_actor_name, ''))) = 0 THEN
    RAISE EXCEPTION 'invalid_member_deletion_request' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_profile_uuid
    FROM public.staff_profiles
   WHERE discord_user_id = v_id
   LIMIT 1;

  SELECT coalesce(array_agg(DISTINCT name), ARRAY[]::text[])
    INTO v_known_names
    FROM (
      SELECT nullif(trim(display_name), '') AS name
        FROM public.staff_profiles WHERE discord_user_id = v_id
      UNION ALL
      SELECT nullif(trim(username), '')
        FROM public.staff_profiles WHERE discord_user_id = v_id
      UNION ALL
      SELECT nullif(trim(display_name), '')
        FROM public.staff_login_events WHERE discord_user_id = v_id
      UNION ALL
      SELECT nullif(trim(display_name), '')
        FROM public.staff_assignments WHERE discord_user_id = v_id
    ) names
   WHERE name IS NOT NULL;

  -- Delete records that are specifically about this member.
  DELETE FROM public.disciplinary_actions WHERE discord_user_id = v_id;
  GET DIAGNOSTICS v_disciplinary_action_count = ROW_COUNT;

  DELETE FROM public.disciplinary_subjects WHERE discord_user_id = v_id;
  GET DIAGNOSTICS v_disciplinary_subject_count = ROW_COUNT;

  DELETE FROM public.staff_login_events WHERE discord_user_id = v_id;
  GET DIAGNOSTICS v_event_count = ROW_COUNT;

  DELETE FROM public.staff_assignments WHERE discord_user_id = v_id;
  GET DIAGNOSTICS v_assignment_count = ROW_COUNT;

  DELETE FROM public.discord_notification_deliveries WHERE recipient_discord_id = v_id;
  GET DIAGNOSTICS v_notification_delivery_count = ROW_COUNT;

  DELETE FROM public.discord_announcement_forward_deliveries WHERE recipient_discord_id = v_id;
  GET DIAGNOSTICS v_announcement_delivery_count = ROW_COUNT;

  -- Keep shared records, but remove the deleted member's authorship/creator attribution.
  UPDATE public.discord_notification_batches
     SET actor_discord_id = 'deleted_member',
         actor_display_name = 'Deleted member',
         actor_username = 'deleted-member'
   WHERE actor_discord_id = v_id;
  GET DIAGNOSTICS v_batch_count = ROW_COUNT;

  UPDATE public.discord_announcement_forwards
     SET author_id = 'deleted_member',
         author_username = 'Deleted member'
   WHERE author_id = v_id;
  GET DIAGNOSTICS v_forward_count = ROW_COUNT;

  UPDATE public.staff_callsigns
     SET created_by_discord_id = NULL
   WHERE created_by_discord_id = v_id;
  GET DIAGNOSTICS v_callsign_count = ROW_COUNT;

  UPDATE public.staff_profiles
     SET manual_created_by_discord_id = NULL
   WHERE manual_created_by_discord_id = v_id;
  GET DIAGNOSTICS v_profile_creator_count = ROW_COUNT;

  UPDATE public.staff_assignments
     SET assigned_by_discord_id = NULL,
         assigned_by_name = 'Deleted member'
   WHERE assigned_by_discord_id = v_id;
  GET DIAGNOSTICS v_assignment_actor_count = ROW_COUNT;

  IF v_profile_uuid IS NOT NULL THEN
    UPDATE public.cases SET created_by = NULL WHERE created_by = v_profile_uuid;
    GET DIAGNOSTICS v_case_creator_count = ROW_COUNT;

    UPDATE public.operations SET created_by = NULL WHERE created_by = v_profile_uuid;
    GET DIAGNOSTICS v_operation_creator_count = ROW_COUNT;

    UPDATE public.reports SET created_by = NULL WHERE created_by = v_profile_uuid;
    GET DIAGNOSTICS v_report_creator_count = ROW_COUNT;

    UPDATE public.wanted_persons SET created_by = NULL WHERE created_by = v_profile_uuid;
    GET DIAGNOSTICS v_wanted_creator_count = ROW_COUNT;

    UPDATE public.wanted_attachments SET uploaded_by = NULL WHERE uploaded_by = v_profile_uuid;
    GET DIAGNOSTICS v_attachment_uploader_count = ROW_COUNT;

    -- Audit rows authored by this profile are removed; rows about this person are anonymized below.
    DELETE FROM public.audit_logs WHERE actor_id = v_profile_uuid;
  END IF;

  -- Remove the member's own audit history (including older Discord-only event rows).
  DELETE FROM public.audit_logs
   WHERE actor_discord_id = v_id
      OR event_key LIKE 'login:' || v_id || ':%'
      OR event_key LIKE 'logout:' || v_id || ':%';
  GET DIAGNOSTICS v_audit_delete_count = ROW_COUNT;

  -- Preserve administrative actions by other staff, but strip the deleted member's identity.
  UPDATE public.audit_logs
     SET entity_id = CASE WHEN entity_id = v_id THEN NULL ELSE entity_id END,
         details = jsonb_build_object(
           'type', 'إجراء إداري على سجل عضو محذوف',
           'detail', 'تم إخفاء تفاصيل هوية عضو حُذفت بياناته.'
         )
   WHERE (entity_id = v_id OR details->>'target_discord_id' = v_id)
     AND actor_discord_id IS DISTINCT FROM v_id;
  GET DIAGNOSTICS v_audit_scrub_count = ROW_COUNT;

  -- Clear "last updated by" attribution where it identifies the deleted account.
  UPDATE public.site_settings
     SET updated_by = 'system:member-deletion'
   WHERE updated_by = v_id OR updated_by = ANY(v_known_names);
  GET DIAGNOSTICS v_setting_actor_count = ROW_COUNT;

  -- Keep shared site records and published announcements, but recursively remove creator identity.
  UPDATE public.app_state
     SET data = public.scrub_staff_member_identity(data, v_id, v_known_names),
         updated_at = now(),
         updated_by = 'system:member-deletion'
   WHERE id = 'main'
     AND (
       data::text LIKE '%' || v_id || '%'
       OR EXISTS (
         SELECT 1
           FROM unnest(v_known_names) AS known_name
          WHERE data::text LIKE '%' || replace(known_name, '%', '\%') || '%'
       )
     );
  GET DIAGNOSTICS v_app_state_count = ROW_COUNT;

  DELETE FROM public.staff_profiles WHERE discord_user_id = v_id;
  GET DIAGNOSTICS v_profile_count = ROW_COUNT;

  -- Preserve an audit event for the deletion itself without storing the target's ID or name.
  INSERT INTO public.audit_logs(
    actor_discord_id, actor_name, action, entity_type, entity_id, details
  ) VALUES (
    p_actor_discord_id,
    left(trim(p_actor_name), 100),
    'delete',
    'staff_profile',
    NULL,
    jsonb_build_object(
      'type', 'حذف نهائي لبيانات عضو',
      'detail', 'حذف المالك بيانات عضو نهائيًا من بوابة S.W.A.T. REDLINE مع إزالة بياناته المرتبطة.',
      'permanent', true,
      'rejoin_allowed', true
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'deleted', true,
    'counts', jsonb_build_object(
      'profiles', v_profile_count,
      'login_events', v_event_count,
      'assignments', v_assignment_count,
      'disciplinary_actions', v_disciplinary_action_count,
      'disciplinary_subjects', v_disciplinary_subject_count,
      'notification_deliveries', v_notification_delivery_count,
      'announcement_deliveries', v_announcement_delivery_count,
      'notification_batches_anonymized', v_batch_count,
      'announcement_forwards_anonymized', v_forward_count,
      'callsign_creator_attributions_cleared', v_callsign_count,
      'other_member_profiles_creator_attributions_cleared', v_profile_creator_count,
      'other_assignments_actor_attributions_cleared', v_assignment_actor_count,
      'case_creator_attributions_cleared', v_case_creator_count,
      'operation_creator_attributions_cleared', v_operation_creator_count,
      'report_creator_attributions_cleared', v_report_creator_count,
      'wanted_person_creator_attributions_cleared', v_wanted_creator_count,
      'wanted_attachment_uploader_attributions_cleared', v_attachment_uploader_count,
      'site_setting_actor_attributions_cleared', v_setting_actor_count,
      'member_audit_events_removed', v_audit_delete_count,
      'target_audit_references_anonymized', v_audit_scrub_count,
      'site_state_records_scrubbed', v_app_state_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_staff_member_identity(jsonb,text,text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.forget_staff_member_data(text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forget_staff_member_data(text,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
