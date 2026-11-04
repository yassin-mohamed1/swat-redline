-- Owner-level independent controls for Discord notification delivery.
-- The portal owner always remains a direct-message recipient.
ALTER TABLE public.discord_notification_batches
  DROP CONSTRAINT IF EXISTS discord_notification_batches_entity_type_check;
ALTER TABLE public.discord_notification_batches
  ADD CONSTRAINT discord_notification_batches_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'person'::text,
    'operation'::text,
    'report'::text,
    'investigation'::text,
    'task'::text,
    'announcement'::text
  ]));

ALTER TABLE public.discord_notification_batches
  DROP CONSTRAINT IF EXISTS discord_notification_batches_channel_status_check;
ALTER TABLE public.discord_notification_batches
  ADD CONSTRAINT discord_notification_batches_channel_status_check
  CHECK (channel_status = ANY (ARRAY[
    'pending'::text,
    'sent'::text,
    'failed'::text,
    'disabled'::text
  ]));

INSERT INTO public.site_settings (key, value, updated_by, updated_at)
VALUES
  ('notificationChannelEnabled', 'false'::jsonb, 'owner-settings', now()),
  ('notificationMemberDmEnabled', 'false'::jsonb, 'owner-settings', now())
ON CONFLICT (key) DO NOTHING;
