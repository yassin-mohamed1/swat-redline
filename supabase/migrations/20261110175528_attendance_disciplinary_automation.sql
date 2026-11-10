-- Idempotent claims/retries for automatic attendance disciplinary actions.
CREATE TABLE IF NOT EXISTS public.attendance_discipline_claims (
  event_key text PRIMARY KEY,
  discord_user_id text NOT NULL CHECK (discord_user_id ~ '^[0-9]{15,22}$'),
  stage smallint NOT NULL CHECK (stage IN (1, 2, 3)),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_expires_at timestamptz,
  retry_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_discipline_claim_event_key_length CHECK (length(event_key) BETWEEN 1 AND 220)
);
CREATE INDEX IF NOT EXISTS attendance_discipline_claims_retry_idx
  ON public.attendance_discipline_claims (status, retry_at, lease_expires_at);
ALTER TABLE public.attendance_discipline_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_discipline_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance_discipline_claims TO service_role;
CREATE OR REPLACE FUNCTION public.claim_swat_attendance_discipline(
  p_event_key text, p_discord_user_id text, p_stage smallint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_claim public.attendance_discipline_claims%rowtype;
BEGIN
  IF length(coalesce(p_event_key,'')) NOT BETWEEN 1 AND 220
     OR p_discord_user_id !~ '^[0-9]{15,22}$' OR p_stage NOT IN (1,2,3) THEN
    RAISE EXCEPTION 'invalid_attendance_discipline_claim' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.attendance_discipline_claims(event_key,discord_user_id,stage)
  VALUES (p_event_key,p_discord_user_id,p_stage) ON CONFLICT(event_key) DO NOTHING;
  SELECT * INTO v_claim FROM public.attendance_discipline_claims WHERE event_key=p_event_key FOR UPDATE;
  IF v_claim.discord_user_id<>p_discord_user_id OR v_claim.stage<>p_stage THEN
    RAISE EXCEPTION 'attendance_discipline_claim_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_claim.status='completed' THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;
  IF v_claim.status='processing' AND v_claim.lease_expires_at IS NOT NULL AND v_claim.lease_expires_at>now() THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;
  IF v_claim.retry_at IS NOT NULL AND v_claim.retry_at>now() THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;
  UPDATE public.attendance_discipline_claims
    SET status='processing',attempts=attempts+1,lease_expires_at=now()+interval '3 minutes',
        retry_at=NULL,last_error=NULL,updated_at=now()
    WHERE event_key=p_event_key RETURNING * INTO v_claim;
  RETURN jsonb_build_object('claimed',true,'status',v_claim.status,'attempts',v_claim.attempts);
END;
$$;
CREATE OR REPLACE FUNCTION public.complete_swat_attendance_discipline(
  p_event_key text,p_success boolean,p_error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE public.attendance_discipline_claims
    SET status=CASE WHEN p_success THEN 'completed' ELSE 'pending' END,
        lease_expires_at=NULL,retry_at=CASE WHEN p_success THEN NULL ELSE now()+interval '5 minutes' END,
        completed_at=CASE WHEN p_success THEN now() ELSE NULL END,
        last_error=CASE WHEN p_success THEN NULL ELSE NULLIF(left(coalesce(p_error_code,''),120),'') END,
        updated_at=now()
    WHERE event_key=p_event_key AND status='processing';
  GET DIAGNOSTICS v_updated=ROW_COUNT;
  RETURN jsonb_build_object('success',p_success,'updated',v_updated>0);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_swat_attendance_discipline(text,text,smallint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_swat_attendance_discipline(text,text,smallint) TO service_role;
REVOKE ALL ON FUNCTION public.complete_swat_attendance_discipline(text,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_swat_attendance_discipline(text,boolean,text) TO service_role;
NOTIFY pgrst,'reload schema';
