ALTER TABLE public.discord_notification_batches
  ADD COLUMN IF NOT EXISTS channel_status text NOT NULL DEFAULT 'pending';

ALTER TABLE public.discord_notification_batches
  ADD COLUMN IF NOT EXISTS channel_message_id text;

ALTER TABLE public.discord_notification_batches
  ADD COLUMN IF NOT EXISTS channel_error_code text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'discord_notification_batches_channel_status_check'
      AND conrelid = 'public.discord_notification_batches'::regclass
  ) THEN
    ALTER TABLE public.discord_notification_batches
      ADD CONSTRAINT discord_notification_batches_channel_status_check
      CHECK (channel_status IN ('pending', 'sent', 'failed'));
  END IF;
END $$;

COMMENT ON COLUMN public.discord_notification_batches.channel_status IS
  'Delivery result for the single configured S.W.A.T. REDLINE notification channel.';
COMMENT ON COLUMN public.discord_notification_batches.channel_message_id IS
  'Discord message ID created in the configured notification channel.';
COMMENT ON COLUMN public.discord_notification_batches.channel_error_code IS
  'Discord error code if the channel post failed.';
