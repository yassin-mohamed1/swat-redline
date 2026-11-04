CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.discord_announcement_sync_state (
  channel_id text PRIMARY KEY,
  cursor_message_id text,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.discord_announcement_forwards (
  message_id text PRIMARY KEY,
  channel_id text NOT NULL,
  author_id text NOT NULL,
  author_username text NOT NULL,
  author_is_bot boolean NOT NULL DEFAULT false,
  message_created_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','sent','partial']::text[])),
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.discord_announcement_forward_deliveries (
  message_id text NOT NULL REFERENCES public.discord_announcement_forwards(message_id) ON DELETE CASCADE,
  recipient_discord_id text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['sent','skipped','failed']::text[])),
  error_code text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_discord_id)
);

CREATE INDEX IF NOT EXISTS discord_announcement_forwards_channel_created_idx
  ON public.discord_announcement_forwards(channel_id, message_created_at);

ALTER TABLE public.discord_announcement_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_announcement_forwards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_announcement_forward_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_announcement_sync_state FROM anon, authenticated;
REVOKE ALL ON public.discord_announcement_forwards FROM anon, authenticated;
REVOKE ALL ON public.discord_announcement_forward_deliveries FROM anon, authenticated;

GRANT ALL ON public.discord_announcement_sync_state TO service_role;
GRANT ALL ON public.discord_announcement_forwards TO service_role;
GRANT ALL ON public.discord_announcement_forward_deliveries TO service_role;
