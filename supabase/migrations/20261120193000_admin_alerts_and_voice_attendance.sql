-- Admin-only alert delivery and daily voice attendance verification.
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS voice_check_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS voice_check_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_alerted_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='attendance_records_voice_check_status_check'
  ) THEN
    ALTER TABLE public.attendance_records
      ADD CONSTRAINT attendance_records_voice_check_status_check
      CHECK (voice_check_status IN ('not_required','pending','confirmed','alerted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS attendance_records_voice_check_due_idx
  ON public.attendance_records (voice_check_deadline_at, attendance_date)
  WHERE voice_check_status='pending';

ALTER TABLE public.attendance_leave_requests
  ADD COLUMN IF NOT EXISTS admin_alert_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS admin_alert_error text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='attendance_leave_requests_admin_alert_status_check'
  ) THEN
    ALTER TABLE public.attendance_leave_requests
      ADD CONSTRAINT attendance_leave_requests_admin_alert_status_check
      CHECK (admin_alert_status IN ('not_required','pending','sent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS attendance_leave_requests_admin_alert_idx
  ON public.attendance_leave_requests (created_at)
  WHERE status='pending' AND admin_alert_status='pending';

-- One idempotent delivery claim is shared by leave, upcoming-warning, and voice alerts.
CREATE TABLE IF NOT EXISTS public.attendance_admin_alert_claims (
  event_key text PRIMARY KEY,
  alert_type text NOT NULL CHECK (alert_type IN ('leave_request','warning_due_soon','voice_attendance_missing')),
  discord_user_id text CHECK (discord_user_id IS NULL OR discord_user_id ~ '^[0-9]{15,22}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_expires_at timestamptz,
  retry_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_admin_alert_event_key_length CHECK (length(event_key) BETWEEN 1 AND 240),
  CONSTRAINT attendance_admin_alert_payload_object CHECK (jsonb_typeof(payload)='object')
);

CREATE INDEX IF NOT EXISTS attendance_admin_alert_claims_retry_idx
  ON public.attendance_admin_alert_claims (status, retry_at, lease_expires_at);

ALTER TABLE public.attendance_admin_alert_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_admin_alert_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance_admin_alert_claims TO service_role;

CREATE OR REPLACE FUNCTION public.claim_swat_admin_alert(
  p_event_key text,
  p_alert_type text,
  p_discord_user_id text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claim public.attendance_admin_alert_claims%rowtype;
BEGIN
  IF length(coalesce(p_event_key,'')) NOT BETWEEN 1 AND 240
     OR p_alert_type NOT IN ('leave_request','warning_due_soon','voice_attendance_missing')
     OR (p_discord_user_id IS NOT NULL AND p_discord_user_id !~ '^[0-9]{15,22}$')
     OR jsonb_typeof(coalesce(p_payload,'{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'invalid_swat_admin_alert_claim' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.attendance_admin_alert_claims(event_key,alert_type,discord_user_id,payload)
  VALUES (p_event_key,p_alert_type,p_discord_user_id,coalesce(p_payload,'{}'::jsonb))
  ON CONFLICT(event_key) DO NOTHING;

  SELECT * INTO v_claim
    FROM public.attendance_admin_alert_claims
   WHERE event_key=p_event_key
   FOR UPDATE;

  IF v_claim.alert_type<>p_alert_type
     OR v_claim.discord_user_id IS DISTINCT FROM p_discord_user_id THEN
    RAISE EXCEPTION 'swat_admin_alert_claim_conflict' USING ERRCODE='23505';
  END IF;

  IF v_claim.status='sent'
     OR (v_claim.status='processing' AND v_claim.lease_expires_at IS NOT NULL AND v_claim.lease_expires_at>now())
     OR (v_claim.retry_at IS NOT NULL AND v_claim.retry_at>now()) THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;

  UPDATE public.attendance_admin_alert_claims
     SET status='processing',
         attempts=attempts+1,
         lease_expires_at=now()+interval '3 minutes',
         retry_at=NULL,
         last_error=NULL,
         updated_at=now()
   WHERE event_key=p_event_key
   RETURNING * INTO v_claim;

  RETURN jsonb_build_object('claimed',true,'status',v_claim.status,'attempts',v_claim.attempts);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_swat_admin_alert(
  p_event_key text,
  p_success boolean,
  p_error_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.attendance_admin_alert_claims
     SET status=CASE WHEN p_success THEN 'sent' ELSE 'pending' END,
         lease_expires_at=NULL,
         retry_at=CASE WHEN p_success THEN NULL ELSE now()+interval '1 minute' END,
         sent_at=CASE WHEN p_success THEN now() ELSE NULL END,
         last_error=CASE WHEN p_success THEN NULL ELSE NULLIF(left(coalesce(p_error_code,''),160),'') END,
         updated_at=now()
   WHERE event_key=p_event_key AND status='processing';

  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN jsonb_build_object('success',p_success,'updated',v_updated>0);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_swat_admin_alert(text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_swat_admin_alert(text,text,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.complete_swat_admin_alert(text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_swat_admin_alert(text,boolean,text) TO service_role;

-- This state makes the administrator-channel cleanup a one-time operation per channel.
CREATE TABLE IF NOT EXISTS public.discord_admin_channel_setup (
  channel_id text PRIMARY KEY CHECK (channel_id ~ '^[0-9]{15,22}$'),
  history_cleared_at timestamptz,
  deleted_message_count integer NOT NULL DEFAULT 0 CHECK (deleted_message_count >= 0),
  privacy_configured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.discord_admin_channel_setup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_admin_channel_setup FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE public.discord_admin_channel_setup TO service_role;

NOTIFY pgrst,'reload schema';
