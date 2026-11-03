ALTER TABLE public.staff_profiles
  ALTER COLUMN notifications_enabled SET DEFAULT false;

-- Existing records have not explicitly opted in to bot DMs.
UPDATE public.staff_profiles
SET notifications_enabled = false
WHERE notifications_enabled IS DISTINCT FROM false;

CREATE TABLE IF NOT EXISTS public.discord_notification_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key uuid NOT NULL UNIQUE,
  actor_discord_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('person', 'operation', 'report', 'investigation')),
  entity_id text NOT NULL,
  total_recipients integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.discord_notification_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES public.discord_notification_batches(id) ON DELETE CASCADE,
  recipient_discord_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, recipient_discord_id)
);

CREATE INDEX IF NOT EXISTS discord_notification_deliveries_batch_idx
  ON public.discord_notification_deliveries(batch_id, status);

ALTER TABLE public.discord_notification_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_notification_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_notification_batches FROM anon, authenticated;
REVOKE ALL ON public.discord_notification_deliveries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.discord_notification_batches TO service_role;
GRANT SELECT, INSERT ON public.discord_notification_deliveries TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.discord_notification_deliveries_id_seq TO service_role;

COMMENT ON TABLE public.discord_notification_batches IS
  'Server-side audit of manually initiated Discord notification batches.';
COMMENT ON TABLE public.discord_notification_deliveries IS
  'Per-recipient outcomes for manually initiated Discord notification batches.';

