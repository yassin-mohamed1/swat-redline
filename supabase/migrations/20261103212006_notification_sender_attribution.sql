ALTER TABLE public.discord_notification_batches
  ADD COLUMN IF NOT EXISTS actor_display_name text,
  ADD COLUMN IF NOT EXISTS actor_username text;

CREATE INDEX IF NOT EXISTS discord_notification_batches_actor_idx
  ON public.discord_notification_batches (actor_discord_id, created_at DESC);
