-- Keep attendance discipline disabled until the safe Production build is live.
CREATE TABLE IF NOT EXISTS public.attendance_discipline_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.attendance_discipline_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.attendance_discipline_control FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.attendance_discipline_control TO service_role;
INSERT INTO public.attendance_discipline_control(singleton, enabled)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_swat_attendance_discipline(
  p_event_key text, p_discord_user_id text, p_stage smallint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claim public.attendance_discipline_claims%rowtype;
  v_enabled boolean := false;
BEGIN
  IF length(coalesce(p_event_key,'')) NOT BETWEEN 1 AND 220
     OR p_discord_user_id !~ '^[0-9]{15,22}$' OR p_stage NOT IN (1,2,3) THEN
    RAISE EXCEPTION 'invalid_attendance_discipline_claim' USING ERRCODE = '22023';
  END IF;
  SELECT enabled INTO v_enabled FROM public.attendance_discipline_control WHERE singleton = true;
  IF coalesce(v_enabled, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('claimed',false,'status','disabled','attempts',0);
  END IF;
  INSERT INTO public.attendance_discipline_claims(event_key,discord_user_id,stage)
  VALUES (p_event_key,p_discord_user_id,p_stage) ON CONFLICT(event_key) DO NOTHING;
  SELECT * INTO v_claim FROM public.attendance_discipline_claims
   WHERE event_key=p_event_key FOR UPDATE;
  IF v_claim.discord_user_id<>p_discord_user_id OR v_claim.stage<>p_stage THEN
    RAISE EXCEPTION 'attendance_discipline_claim_conflict' USING ERRCODE = '23505';
  END IF;
  IF v_claim.status='completed' THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;
  IF v_claim.status='processing' AND v_claim.lease_expires_at IS NOT NULL
     AND v_claim.lease_expires_at>now() THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;
  IF v_claim.retry_at IS NOT NULL AND v_claim.retry_at>now() THEN
    RETURN jsonb_build_object('claimed',false,'status',v_claim.status,'attempts',v_claim.attempts);
  END IF;
  UPDATE public.attendance_discipline_claims
     SET status='processing',attempts=attempts+1,
         lease_expires_at=now()+interval '3 minutes',retry_at=NULL,
         last_error=NULL,updated_at=now()
   WHERE event_key=p_event_key RETURNING * INTO v_claim;
  RETURN jsonb_build_object('claimed',true,'status',v_claim.status,'attempts',v_claim.attempts);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_swat_attendance_discipline(text,text,smallint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_swat_attendance_discipline(text,text,smallint)
  TO service_role;
NOTIFY pgrst, 'reload schema';
